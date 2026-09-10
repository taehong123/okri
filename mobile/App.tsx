import React, { useEffect, useState } from "react";
import { Image, Platform, View, Linking, Pressable, useWindowDimensions } from "react-native";
import * as Apple from "expo-apple-authentication";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { CalendarCheck, Ellipsis, FolderKanban, ListTodo } from "lucide-react-native";
import { Providers, useApp, useBootstrap } from "./src/context";
import { Button, ErrorState, Field, Loading, Screen, Txt } from "./src/ui";
import { ProjectsScreen, RoutinesScreen, TodayScreen } from "./src/screens/work";
import { ItemScreen, RoutineScreen } from "./src/screens/detail";
import { EditorScreen, Select } from "./src/screens/editor";
import { DailyScreen } from "./src/screens/daily";
import { GanttScreen, OkrScreen } from "./src/screens/schedule";
import { MoreScreen, SettingsScreen } from "./src/screens/settings";
import { languages } from "./src/i18n";
import type { Routes, Session } from "./src/types";
import { appleLogin, reviewLogin } from "./src/auth";

const Stack = createNativeStackNavigator<Routes>();
const Tab = createBottomTabNavigator();
function Tabs() {
  const { t, theme } = useApp(), data = useBootstrap().data, insets = useSafeAreaInsets(), { fontScale } = useWindowDimensions();
  return <Tab.Navigator screenOptions={{
    headerTitle: data?.team.workspace?.name || "OKRI",
    headerTitleStyle: { fontFamily: "Pretendard", fontSize: 16, fontWeight: "600" },
    headerStyle: { backgroundColor: theme.tokens["bg-page"] }, headerTintColor: theme.tokens["text-primary"], headerShadowVisible: false,
    tabBarActiveTintColor: theme.tokens["text-primary"], tabBarInactiveTintColor: theme.tokens["text-secondary"],
    tabBarStyle: { backgroundColor: theme.tokens["bg-page"], borderTopColor: theme.tokens["border-default"], height: Math.max(72, 48 + 24 * fontScale) + insets.bottom, paddingTop: 8, paddingBottom: Math.max(8, insets.bottom) },
    tabBarLabelStyle: { fontFamily: "Pretendard", fontSize: 13 }, tabBarLabelPosition: "below-icon",
  }}>
    <Tab.Screen name="Today" component={TodayScreen} options={{ title: t("내 업무"), tabBarIcon: ({ color }) => <ListTodo color={color} size={22} /> }} />
    <Tab.Screen name="Projects" component={ProjectsScreen} options={{ title: t("Project"), tabBarIcon: ({ color }) => <FolderKanban color={color} size={22} /> }} />
    <Tab.Screen name="Daily" component={DailyScreen} options={{ title: t("데일리"), tabBarIcon: ({ color }) => <CalendarCheck color={color} size={22} /> }} />
    <Tab.Screen name="More" component={MoreScreen} options={{ title: t("더보기"), tabBarIcon: ({ color }) => <Ellipsis color={color} size={22} /> }} />
  </Tab.Navigator>;
}
function Login() {
  const { t, signIn, language, setLanguage, theme, api, acceptSession } = useApp();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [apple, setApple] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(false), [reviewOpen, setReviewOpen] = useState(false);
  const [reviewUsername, setReviewUsername] = useState(""), [reviewPassword, setReviewPassword] = useState("");
  useEffect(() => {
    void api<{ enabled: boolean }>("/api/native/review").then(config => setReviewEnabled(config.enabled)).catch(() => setReviewEnabled(false));
    if (Platform.OS === "ios") void Promise.all([Apple.isAvailableAsync(), api<{ enabled: boolean }>("/api/native/apple")]).then(([available, config]) => setApple(available && config.enabled)).catch(() => setApple(false));
  }, [api]);
  async function start() { if (busy) return; setBusy(true); setError(false); try { await signIn(); } catch { setError(true); } finally { setBusy(false); } }
  async function startApple() { if (busy) return; setBusy(true); setError(false); try { await acceptSession(await appleLogin(language)); } catch (e) { if ((e as { code?: string }).code !== "ERR_REQUEST_CANCELED") setError(true); } finally { setBusy(false); } }
  async function startReview() {
    if (busy || !reviewUsername.trim() || !reviewPassword) return;
    setBusy(true); setError(false);
    try { await acceptSession(await reviewLogin(language, reviewUsername, reviewPassword)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  function closeReview() { setReviewOpen(false); setReviewPassword(""); setError(false); }
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.tokens["bg-page"] }}>
    <Screen style={{ flexGrow: 1, justifyContent: "space-between", paddingTop: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><Image source={require("./assets/icon.png")} style={{ width: 48, height: 48, borderRadius: 8 }} accessible={false} /><Txt role="section">OKRI</Txt></View>
      <View style={{ gap: 24, paddingVertical: 32 }}><Txt role="title">{t("목표와 실행, 한곳에서.")}</Txt><Txt muted>{t("목표부터 오늘 할 일까지.")}</Txt><Button label={t("Google로 시작하기")} onPress={() => void start()} busy={busy} />
        {apple && <View pointerEvents={busy ? "none" : "auto"} accessibilityState={{ disabled: busy }}><Apple.AppleAuthenticationButton buttonType={Apple.AppleAuthenticationButtonType.SIGN_IN} buttonStyle={theme.colorScheme === "dark" ? Apple.AppleAuthenticationButtonStyle.WHITE : Apple.AppleAuthenticationButtonStyle.BLACK} cornerRadius={8} style={{ width: "100%", height: 52 }} onPress={() => void startApple()} /></View>}
        {reviewEnabled && !reviewOpen && <Button secondary label={t("앱 심사용 로그인")} onPress={() => { setReviewOpen(true); setError(false); }} />}
        {reviewEnabled && reviewOpen && <View style={{ gap: 16 }}>
          <Txt role="section">{t("심사 계정으로 로그인")}</Txt>
          <Field label={t("심사 계정 아이디")} value={reviewUsername} onChangeText={setReviewUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" />
          <Field label={t("비밀번호")} value={reviewPassword} onChangeText={setReviewPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="password" textContentType="password" onSubmitEditing={() => void startReview()} />
          <View style={{ gap: 8 }}><Button label={t("로그인")} onPress={() => void startReview()} busy={busy} disabled={!reviewUsername.trim() || !reviewPassword} /><Button secondary label={t("취소")} onPress={closeReview} disabled={busy} /></View>
        </View>}
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>{[{ path: "terms", text: "이용약관" }, { path: "privacy", text: "개인정보 처리방침" }].map(link => <Pressable key={link.path} accessibilityRole="link" onPress={() => void Linking.openURL("https://okri.ai/" + link.path)} style={{ minHeight: 48, justifyContent: "center" }}><Txt role="label">{t(link.text)}</Txt></Pressable>)}</View>
        {error && <ErrorState />}</View>
      <Select label={t("언어")} value={language} options={languages.map(l => ({ id: l.id, label: l.name }))} onChange={id => void setLanguage(id as typeof language)} />
    </Screen>
  </SafeAreaView>;
}
function Root() {
  const { ready, session, theme, t, workspace } = useApp(), c = theme.tokens;
  const [fonts, fontError] = useFonts({ Pretendard: require("./assets/PretendardVariable.ttf") });
  if (!ready || (!fonts && !fontError)) return <Loading />;
  if (fontError) return <Screen><ErrorState /></Screen>;
  return <><StatusBar style={theme.colorScheme === "dark" ? "light" : "dark"} />{!session ? <Login /> :
    <NavigationContainer key={session.user.id + (workspace || "")} theme={{ ...DefaultTheme, dark: theme.colorScheme === "dark", colors: { ...DefaultTheme.colors, background: c["bg-page"], card: c["bg-page"], text: c["text-primary"], primary: c["text-link"], border: c["border-default"], notification: c["danger-fg"] } }}>
      <Stack.Navigator screenOptions={{ contentStyle: { backgroundColor: c["bg-page"] }, headerStyle: { backgroundColor: c["bg-page"] }, headerTintColor: c["text-primary"], headerTitleStyle: { fontFamily: "Pretendard", fontSize: 18 }, headerShadowVisible: false, headerBackTitle: t("뒤로") }}>
        <Stack.Screen name="Main" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="Item" component={ItemScreen} options={{ title: t("상세") }} />
        <Stack.Screen name="Routine" component={RoutineScreen} options={{ title: "Routine" }} />
        <Stack.Screen name="Editor" component={EditorScreen} options={{ title: t("업무 편집"), presentation: "modal", gestureEnabled: false }} />
        <Stack.Screen name="Gantt" component={GanttScreen} options={{ title: t("간트") }} />
        <Stack.Screen name="Okr" component={OkrScreen} options={{ title: "OKR" }} />
        <Stack.Screen name="Routines" component={RoutinesScreen} options={{ title: "Routine" }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: t("설정") }} />
      </Stack.Navigator>
    </NavigationContainer>}</>;
}
export function AppRoot({ loadSession }: { loadSession?: () => Promise<Session | null> }) { return <SafeAreaProvider><Providers loadSession={loadSession}><Root /></Providers></SafeAreaProvider>; }
export default function App() { return <AppRoot />; }
