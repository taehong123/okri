import { useEffect, useState } from "react";
import { Alert, Pressable, Switch, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck, Clock3 } from "lucide-react-native";
import { useApp } from "../context";
import { disablePush, enablePush, pushPermissionState } from "../push";
import type { NotificationInbox, NotificationPreferences, Routes, WorkNotification } from "../types";
import { Button, ErrorState, IconButton, Loading, Row, Screen, Txt } from "../ui";
import { Select } from "./editor";

export const notificationQueryKey = (userId?: string, workspace?: string | null) => ["notifications", userId, workspace] as const;

export function useNotificationInbox() {
  const { api, session, workspace } = useApp();
  return useQuery({
    queryKey: notificationQueryKey(session?.user.id, workspace),
    queryFn: ({ signal }) => api<NotificationInbox>("/api/mobile/v1/notifications", { signal }),
    enabled: !!session,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function NotificationRow({ value, open }: { value: WorkNotification; open: (value: WorkNotification) => void }) {
  const { theme, language, t } = useApp();
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${value.title}. ${value.body}`}
    accessibilityState={{ selected: !value.readAt }}
    onPress={() => open(value)}
    style={({ pressed }) => ({
      minHeight: 72, paddingVertical: 12, paddingHorizontal: 4, gap: 4,
      borderBottomWidth: 1, borderBottomColor: theme.tokens["border-default"],
      backgroundColor: pressed ? theme.tokens["bg-hover"] : "transparent",
    })}
  >
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {!value.readAt && <View accessibilityLabel={t("읽지 않음")} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.tokens["text-primary"] }} />}
      <Txt role="label" style={{ flex: 1, fontWeight: value.readAt ? "400" : "600" }}>{value.title}</Txt>
      <Txt role="meta" muted>{new Date(value.createdAt).toLocaleDateString(language, { month: "short", day: "numeric" })}</Txt>
    </View>
    <Txt role="label" muted style={{ paddingLeft: value.readAt ? 0 : 16 }}>{value.body}</Txt>
  </Pressable>;
}

export function NotificationsScreen() {
  const query = useNotificationInbox(), { api, t, session, workspace, theme } = useApp();
  const client = useQueryClient(), nav = useNavigation<NativeStackNavigationProp<Routes>>();
  const write = useMutation({ mutationFn: (body: { id?: string; all?: true }) => api("/api/mobile/v1/notifications", { method: "PATCH", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: notificationQueryKey(session?.user.id, workspace) }) });
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const open = (value: WorkNotification) => {
    if (!value.readAt) write.mutate({ id: value.id });
    if (value.itemId) nav.navigate("Item", { id: value.itemId });
  };
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <Txt muted role="label">{query.data.unreadCount > 0 ? t("읽지 않은 알림 {count}개", { count: query.data.unreadCount }) : t("새 알림이 없습니다.")}</Txt>
      {query.data.unreadCount > 0 && <IconButton icon={CheckCheck} label={t("모두 읽음")} disabled={write.isPending} onPress={() => write.mutate({ all: true })} />}
    </View>
    {write.isError && <ErrorState message={t("알림을 업데이트하지 못했습니다.")} />}
    <View>{query.data.notifications.length
      ? query.data.notifications.map(value => <NotificationRow key={value.id} value={value} open={open} />)
      : <View style={{ paddingVertical: 32, gap: 8, alignItems: "center" }}><Bell size={24} color={theme.tokens["icon-default"]} /><Txt>{t("새 알림이 없습니다.")}</Txt><Txt muted role="label">{t("업무가 배정되거나 아침 요약이 준비되면 여기에 표시됩니다.")}</Txt></View>}
    </View>
  </Screen>;
}

function PreferenceRow({ label, description, value, disabled, onChange }: { label: string; description: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const { theme } = useApp();
  return <Row trailing={<Switch accessibilityLabel={label} value={value} disabled={disabled} onValueChange={onChange} trackColor={{ false: theme.tokens["border-control"], true: theme.tokens["text-primary"] }} thumbColor={theme.tokens["bg-page"]} />}>
    <Txt>{label}</Txt><Txt muted role="label">{description}</Txt>
  </Row>;
}

export function NotificationSettingsScreen() {
  const { api, language, t } = useApp(), client = useQueryClient();
  const query = useQuery({ queryKey: ["notification-preferences"], queryFn: ({ signal }) => api<NotificationPreferences>("/api/mobile/v1/notifications/preferences", { signal }) });
  const [permission, setPermission] = useState<"granted" | "prompt" | "denied">("prompt"), [deviceBusy, setDeviceBusy] = useState(false), [deviceError, setDeviceError] = useState("");
  useEffect(() => { void pushPermissionState().then(setPermission).catch(() => setPermission("denied")); }, []);
  const save = useMutation({
    mutationFn: (patch: Partial<NotificationPreferences>) => api<NotificationPreferences>("/api/mobile/v1/notifications/preferences", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: data => client.setQueryData(["notification-preferences"], data),
  });
  async function toggleDevice() {
    if (deviceBusy) return;
    setDeviceBusy(true); setDeviceError("");
    try {
      if (permission === "granted" && (query.data?.registeredDeviceCount ?? 0) > 0) {
        await disablePush(api); setPermission(await pushPermissionState());
      } else {
        const result = await enablePush(api, language); setPermission(result.enabled ? "granted" : "denied");
        if (result.denied) Alert.alert(t("알림 권한이 꺼져 있습니다."), t("기기 설정에서 OKRI 알림을 허용해 주세요."));
      }
      await query.refetch();
    } catch { setDeviceError(t("이 기기의 알림 설정을 변경하지 못했습니다.")); }
    finally { setDeviceBusy(false); }
  }
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const enabledOnDevice = permission === "granted" && query.data.registeredDeviceCount > 0;
  return <Screen>
    <View><Row icon={enabledOnDevice ? Bell : BellOff} trailing={null}><Txt>{t(enabledOnDevice ? "이 기기에서 알림 받는 중" : "이 기기 알림 꺼짐")}</Txt><Txt muted role="label">{permission === "denied" ? t("기기 설정에서 권한을 다시 허용해야 합니다.") : t("배정과 요약 알림을 기기에서 받습니다.")}</Txt></Row></View>
    <Button secondary={enabledOnDevice} icon={enabledOnDevice ? BellOff : Bell} label={t(enabledOnDevice ? "이 기기 알림 끄기" : "이 기기 알림 켜기")} busy={deviceBusy} onPress={() => void toggleDevice()} />
    {!!deviceError && <ErrorState message={deviceError} />}
    <View>
      <PreferenceRow label={t("업무 배정 즉시 알림")} description={t("Project나 Task가 나에게 배정되면 바로 알립니다.")} value={query.data.assignmentPush} disabled={save.isPending} onChange={assignmentPush => save.mutate({ assignmentPush })} />
      <PreferenceRow label={t("아침 업무 요약")} description={t("지연, 오늘 마감, 진행 중인 업무를 한 번에 알립니다.")} value={query.data.morningBriefPush} disabled={save.isPending} onChange={morningBriefPush => save.mutate({ morningBriefPush })} />
    </View>
    <Select label={t("요약 시간")} value={String(query.data.digestHour)} options={Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), label: t("{hour}시", { hour }) }))} onChange={value => save.mutate({ digestHour: Number(value) })} enabled={!save.isPending && query.data.morningBriefPush} />
    <Row icon={Clock3}><Txt>{t("시간대")}</Txt><Txt muted role="label">{query.data.timezone}</Txt></Row>
    {save.isError && <ErrorState message={t("알림 설정을 저장하지 못했습니다.")} />}
  </Screen>;
}
