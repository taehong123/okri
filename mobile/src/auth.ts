import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import * as Apple from "expo-apple-authentication";
import type { Session } from "./types";
import { ORIGIN, request } from "./api";

const SESSION_KEY = "okri.native.session.v1";
let browserSession: Session | null = null;
export async function readSession(): Promise<Session | null> {
  const raw = Platform.OS === "web" ? browserSession : await SecureStore.getItemAsync(SESSION_KEY);
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value?.accessToken?.startsWith("okri_native_") && Date.parse(value.expiresAt) > Date.now() ? value : null;
  } catch { return null; }
}
export async function storeSession(session: Session | null) {
  if (Platform.OS === "web") { browserSession = session; return; }
  if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}
export function randomValue() {
  return Array.from(Crypto.getRandomBytes(32), n => n.toString(16).padStart(2, "0")).join("");
}
export async function login(language: string): Promise<Session | null> {
  const verifier = randomValue(), state = randomValue();
  const challenge = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const url = ORIGIN + "/api/native/auth?challenge=" + encodeURIComponent(challenge) + "&state=" + state;
  const result = await WebBrowser.openAuthSessionAsync(url, "okri://auth", { preferEphemeralSession: true });
  if (result.type !== "success") return null;
  const callback = new URL(result.url);
  if (callback.protocol !== "okri:" || callback.hostname !== "auth" || callback.searchParams.get("state") !== state) throw new Error("Invalid sign-in response");
  const code = callback.searchParams.get("code");
  if (!code || callback.searchParams.has("error")) throw new Error("Sign-in failed");
  return request<Session>("/api/native/token", null, null, language, { method: "POST", body: JSON.stringify({ code, verifier }) });
}

export async function appleLogin(language: string) {
  const { nonce } = await request<{ nonce: string }>("/api/native/apple", null, null, language, { method: "POST", body: JSON.stringify({ action: "challenge" }) });
  const credential = await Apple.signInAsync({ requestedScopes: [Apple.AppleAuthenticationScope.FULL_NAME, Apple.AppleAuthenticationScope.EMAIL], nonce });
  if (!credential.identityToken || !credential.authorizationCode) throw new Error("Apple sign-in failed");
  return request<Session>("/api/native/apple", null, null, language, { method: "POST", body: JSON.stringify({
    identityToken: credential.identityToken, authorizationCode: credential.authorizationCode, nonce,
    name: [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(" "),
  }) });
}

export async function reviewLogin(language: string, username: string, password: string) {
  return request<Session>("/api/native/review", null, null, language, {
    method: "POST",
    body: JSON.stringify({ username: username.trim(), password }),
  });
}
