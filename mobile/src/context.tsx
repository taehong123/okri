import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
import { ApiError, request } from "./api";
import { login, readSession, storeSession } from "./auth";
import { resolveLanguage, translator, type Language } from "./i18n";
import { THEMES, isThemeMode, type ThemeMode } from "../../lib/themes";
import { today } from "./model";
import type { Bootstrap, Session } from "./types";

const client = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1, staleTime: 30000 }, mutations: { retry: false } } });
type AppContext = {
  session: Session | null; ready: boolean; language: Language; setLanguage: (l: Language) => Promise<void>;
  theme: typeof THEMES[number]; setTheme: (m: ThemeMode) => Promise<void>;
  workspace: string | null; switchWorkspace: (id: string) => Promise<void>;
  signIn: () => Promise<void>; signOut: () => Promise<void>;
  acceptSession: (session: Session) => Promise<void>;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  t: ReturnType<typeof translator>; clear: () => Promise<void>;
};
const Context = createContext<AppContext | null>(null);
export const useApp = () => {
  const value = useContext(Context); if (!value) throw new Error("Missing OKRI context"); return value;
};
function StateProvider({ children, loadSession = readSession }: { children: React.ReactNode; loadSession?: () => Promise<Session | null> }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [language, setLanguageState] = useState<Language>(resolveLanguage(getLocales()[0]?.languageCode));
  const [mode, setMode] = useState<ThemeMode>("white");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const generation = useRef(0);
  const queryClient = useQueryClient();
  useEffect(() => { void Promise.all([loadSession(), AsyncStorage.multiGet(["okri.native.language", "okri.native.theme"])]).then(([saved, prefs]) => {
    setSession(saved);
    if (prefs[0][1]) setLanguageState(resolveLanguage(prefs[0][1]));
    if (isThemeMode(prefs[1][1])) setMode(prefs[1][1]);
  }).catch(() => setSession(null)).finally(() => setReady(true)); }, [loadSession]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", s => { if (s === "active") void queryClient.invalidateQueries(); });
    return () => sub.remove();
  }, [queryClient]);
  const clear = useCallback(async () => {
    generation.current++;
    await queryClient.cancelQueries();
    await storeSession(null); setSession(null); setWorkspace(null); queryClient.clear();
  }, [queryClient]);
  const api = useCallback(async <T,>(path: string, init?: RequestInit) => {
    const current = generation.current;
    try {
      return await request<T>(path, session, workspace, language, init);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && session && current === generation.current) await clear();
      throw error;
    }
  }, [session, workspace, language, clear]);
  const acceptSession = useCallback(async (value: Session) => {
    generation.current++;
    await queryClient.cancelQueries(); queryClient.clear();
    await storeSession(value); setWorkspace(null); setSession(value);
  }, [queryClient]);
  const context = useMemo<AppContext>(() => ({
    session, ready, language, workspace, theme: THEMES.find(t => t.mode === mode)!, api, clear,
    t: translator(language), acceptSession,
    setLanguage: async l => { await AsyncStorage.setItem("okri.native.language", l); setLanguageState(l); },
    setTheme: async m => { await AsyncStorage.setItem("okri.native.theme", m); setMode(m); },
    switchWorkspace: async id => {
      // Validate membership before clearing the old workspace's rendered data.
      await api("/api/workspaces", { method: "PATCH", body: JSON.stringify({ workspaceId: id }) });
      generation.current++; await queryClient.cancelQueries(); queryClient.clear(); setWorkspace(id);
    },
    signIn: async () => { const value = await login(language); if (value) await acceptSession(value); },
    signOut: async () => {
      try { await api("/api/native/session", { method: "DELETE" }); }
      finally { await clear(); }
    },
  }), [session, ready, language, workspace, mode, api, clear, acceptSession, queryClient]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export function Providers({ children, loadSession }: { children: React.ReactNode; loadSession?: () => Promise<Session | null> }) {
  return <QueryClientProvider client={client}><StateProvider loadSession={loadSession}>{children}</StateProvider></QueryClientProvider>;
}
export function useBootstrap() {
  const { session, workspace, api } = useApp();
  return useQuery({ queryKey: ["bootstrap", session?.user.id, workspace, today()], queryFn: ({ signal }) => api<Bootstrap>("/api/bootstrap?date=" + today(), { signal }), enabled: !!session });
}
