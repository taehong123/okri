import React, { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { BookOpen, CalendarRange, CircleHelp, LogOut, Repeat2, Settings2, Target } from "lucide-react-native";
import { useApp, useBootstrap } from "../context";
import { languages } from "../i18n";
import { THEMES } from "../../../lib/themes";
import { Button, ErrorState, Row, Screen, Txt } from "../ui";
import { Select } from "./editor";
import type { Routes } from "../types";
import { ApiError } from "../api";

export function MoreScreen() {
  const { t } = useApp(), nav = useNavigation<NativeStackNavigationProp<Routes>>();
  const entries = [{ screen: "Okr", label: "OKR", icon: Target }, { screen: "Gantt", label: "간트", icon: CalendarRange }, { screen: "Routines", label: "Routine", icon: Repeat2 }, { screen: "Settings", label: "설정", icon: Settings2 }] as const;
  return <Screen><Txt role="title">{t("더보기")}</Txt><View>{entries.map(entry => <Row key={entry.screen} icon={entry.icon} onPress={() => nav.navigate(entry.screen)}><Txt>{t(entry.label)}</Txt></Row>)}</View><Row icon={BookOpen} onPress={() => void Linking.openURL("https://okri.ai/guide")}><Txt>{t("이용 안내")}</Txt></Row></Screen>;
}
export function SettingsScreen() {
  const { t, language, setLanguage, theme, setTheme, signOut, switchWorkspace, api, clear } = useApp(), data = useBootstrap().data;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError("");
    try { await action(); } catch { setError(t("연결을 확인하고 다시 시도해 주세요.")); }
    finally { setBusy(false); }
  }
  async function deleteAccount() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api("/api/native/account", { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) });
      await clear();
    } catch (e) {
      setError(t(e instanceof ApiError && e.code === "reauthentication_required" ? "계정을 삭제하려면 로그아웃 후 다시 로그인해 주세요."
        : e instanceof ApiError && e.code === "transfer_workspace_ownership" ? "공유 워크스페이스의 소유권을 먼저 이전해 주세요." : "삭제하지 못했습니다. 다시 시도해 주세요."));
    } finally { setBusy(false); }
  }
  return <Screen>
    <Txt role="section">{data?.user.displayName}</Txt><Txt muted role="label">{data?.user.email}</Txt>
    <Select label={t("워크스페이스")} value={data?.team.workspace?.id || ""} options={(data?.workspaces || []).filter(w => !w.scheduledDeletionAt).map(w => ({ id: w.id, label: w.name }))} onChange={id => void run(() => switchWorkspace(id))} enabled={!busy} />
    <Select label={t("언어")} value={language} options={languages.map(l => ({ id: l.id, label: l.name }))} onChange={id => void run(() => setLanguage(id as typeof language))} />
    <Select label={t("테마")} value={theme.mode} options={THEMES.map(th => ({ id: th.mode, label: t(th.label) }))} onChange={id => void run(() => setTheme(id as typeof theme.mode))} />
    <View><Row icon={CircleHelp} onPress={() => void Linking.openURL("https://okri.ai/guide")}><Txt>{t("이용 안내")}</Txt></Row>
      <Row onPress={() => void Linking.openURL("https://okri.ai/privacy")}><Txt>{t("개인정보 처리방침")}</Txt></Row>
      <Row onPress={() => void Linking.openURL("https://okri.ai/terms")}><Txt>{t("이용약관")}</Txt></Row>
    </View>
    {!!error && <ErrorState message={error} />}
    <Button secondary icon={LogOut} label={t("로그아웃")} busy={busy} onPress={() => Alert.alert(t("로그아웃"), "", [{ text: t("취소"), style: "cancel" }, { text: t("로그아웃"), onPress: () => void run(signOut) }])} />
    <Button secondary label={t("계정 삭제")} disabled={busy} onPress={() => Alert.alert(t("계정을 삭제할까요?"), t("개인 워크스페이스와 계정을 영구 삭제합니다. 공유 워크스페이스의 자료는 팀에 남습니다."), [{ text: t("취소"), style: "cancel" }, { text: t("영구 삭제"), style: "destructive", onPress: () => void deleteAccount() }])} />
    <Txt role="meta" muted>OKRI 1.0.0</Txt>
  </Screen>;
}
