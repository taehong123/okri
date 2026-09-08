import React, { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, View } from "react-native";
import { usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Picker } from "@react-native-picker/picker";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Save, X } from "lucide-react-native";
import { useApp, useBootstrap } from "../context";
import { Button, ErrorState, Field, IconButton, Loading, Screen, Txt } from "../ui";
import { activeItems, today } from "../model";
import { statusText } from "./work";
import type { Bootstrap, Item, Kind, Priority, Routes, Status } from "../types";

export function Select({ label, value, options, onChange, enabled = true }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (id: string) => void; enabled?: boolean }) {
  const { theme } = useApp();
  return <View style={{ gap: 8 }}><Txt role="label">{label}</Txt><View style={{ borderWidth: 1, borderColor: theme.tokens["border-control"], borderRadius: 8, overflow: "hidden" }}>
    <Picker accessibilityLabel={label} selectedValue={value} onValueChange={onChange} enabled={enabled} dropdownIconColor={theme.tokens["text-primary"]} style={{ minHeight: 48, color: theme.tokens["text-primary"], backgroundColor: theme.tokens["input-bg"] }} itemStyle={{ fontFamily: "Pretendard", fontSize: 16, color: theme.tokens["text-primary"] }}>
      {options.map(o => <Picker.Item key={o.id} value={o.id} label={o.label} style={{ fontFamily: Platform.OS === "android" ? "PretendardVariable" : "Pretendard", fontSize: 16, color: theme.tokens["text-primary"], backgroundColor: theme.tokens["input-bg"] }} />)}
    </Picker>
  </View></View>;
}
export function EditorScreen(props: NativeStackScreenProps<Routes, "Editor">) {
  const query = useBootstrap();
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  return <EditorForm {...props} data={query.data} key={props.route.key} />;
}
function EditorForm({ route, navigation, data }: NativeStackScreenProps<Routes, "Editor"> & { data: Bootstrap }) {
  const { t, api } = useApp(), client = useQueryClient(), original = data.items.find(i => i.id === route.params.id);
  const kind = original?.kind || route.params.kind || "task", lock = useRef(false);
  const [title, setTitle] = useState(original?.title || ""), [description, setDescription] = useState(original?.description || "");
  const [status, setStatus] = useState<Status>(original?.status || "todo"), [priority, setPriority] = useState<Priority>(original?.priority || "medium");
  const [parent, setParent] = useState(original?.routineId ? "routine:" + original.routineId : original?.parentId || (route.params.routineId ? "routine:" + route.params.routineId : route.params.parentId || ""));
  const [member, setMember] = useState(original ? original.assignments.find(a => a.role === (kind === "project" ? "project_dri" : "task_assignee"))?.memberId || "" : data.team.members.find(m => m.userId === data.user.id)?.id || "");
  const [due, setDue] = useState(original?.dueDate || ""), [showDate, setShowDate] = useState(false), [cadence, setCadence] = useState("daily");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const baseline = useRef(JSON.stringify({ title, description, status, priority, parent, member, due, cadence }));
  const dirty = baseline.current !== JSON.stringify({ title, description, status, priority, parent, member, due, cadence });
  usePreventRemove(!saved && dirty, ({ data: action }) => {
    Alert.alert(t("변경사항을 버릴까요?"), t("저장되지 않은 변경사항이 있습니다."), [
      { text: t("취소"), style: "cancel" }, { text: t("버리기"), style: "destructive", onPress: () => navigation.dispatch(action.action) },
    ]);
  });
  useEffect(() => { if (saved) navigation.goBack(); }, [saved, navigation]);
  const parentKind: Partial<Record<Kind | "routine", Kind>> = { task: "project", project: "initiative", initiative: "key_result", key_result: "objective" };
  const projects = activeItems(data).filter(i => i.kind === parentKind[kind]);
  const parents = [{ id: "", label: t("연결 없음") }, ...projects.map(i => ({ id: i.id, label: i.title })), ...(kind === "task" ? data.routines.filter(r => r.active && !r.systemKey).map(r => ({ id: "routine:" + r.id, label: t("Routine") + " · " + r.title })) : [])];
  async function save() {
    if (lock.current) return;
    if (!title.trim()) { setError(t("이름을 입력해 주세요.")); return; }
    if (kind !== "task" && parentKind[kind] && !parent) { setError(t("상위 항목을 선택해 주세요.")); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      const routineId = parent.startsWith("routine:") ? parent.slice(8) : null;
      const itemParentId = routineId ? null : parent || null;
      const payload = kind === "routine" ? { title: title.trim(), description, cadence, assigneeMemberId: member || null }
        : { ...(original ? { id: original.id } : { kind, source: "web" }), title: title.trim(), description, status, priority, dueDate: due || null,
          ...(parentKind[kind] ? { parentId: itemParentId, routineId, cycleId: routineId ? null : data.items.find(i => i.id === itemParentId)?.cycleId ?? null } : {}),
          ...(kind === "project" ? { driMemberId: member || null } : kind === "task" ? { assigneeMemberId: member || null } : {}),
        };
      const result = await api<{ item?: Item; code?: string }>(kind === "routine" ? "/api/mobile/v1/routines" : "/api/mobile/v1/items", { method: original ? "PATCH" : "POST", body: JSON.stringify(payload) });
      if (result.code) throw new Error("Confirmation required");
      await client.invalidateQueries(); setSaved(true);
    } catch { setError(t("연결을 확인하고 다시 시도해 주세요.") + " " + t("저장한 내용은 유지됩니다.")); }
    finally { lock.current = false; setBusy(false); }
  }
  if (data.team.currentRole === "viewer") return <Screen><Txt>{t("읽기 전용")}</Txt></Screen>;
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={100}><Screen>
    <Field label={t("제목")} value={title} onChangeText={setTitle} autoFocus maxLength={300} multiline />
    {parentKind[kind] && <Select label={t(kind === "project" ? "상위 Initiative" : kind === "task" ? "Project / Routine" : "상위 항목")} value={parent} options={parents} onChange={setParent} />}
    {(kind === "project" || kind === "task" || kind === "routine") && <Select label={t(kind === "project" ? "책임자" : "담당자")} value={member} options={[{ id: "", label: t("미지정") }, ...data.team.members.filter(m => m.status === "active").map(m => ({ id: m.id, label: m.displayName }))]} onChange={setMember} />}
    {kind !== "routine" ? <>
      <Select label={t("상태")} value={status} options={Object.entries(statusText).filter(([key]) => kind === "task" ? key === "todo" || key === "done" : key !== "archived").map(([id, key]) => ({ id, label: t(key) }))} onChange={v => setStatus(v as Status)} />
      <Select label={t("우선순위")} value={priority} options={["low", "medium", "high", "urgent"].map((id, i) => ({ id, label: t(["낮음", "보통", "높음", "긴급"][i]) }))} onChange={v => setPriority(v as Priority)} />
      <View style={{ gap: 8 }}><Txt role="label">{t("기한")}</Txt><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ flex: 1 }}><Button secondary icon={CalendarDays} label={due || t("기한 없음")} onPress={() => setShowDate(v => !v)} /></View>{!!due && <IconButton icon={X} label={t("기한 제거")} onPress={() => setDue("")} />}</View>
        {showDate && (Platform.OS === "web" ? <Field label={t("날짜")} placeholder="YYYY-MM-DD" value={due} onChangeText={setDue} /> : <DateTimePicker value={new Date((due || today()) + "T12:00:00")} mode="date" onChange={(event, date) => { if (Platform.OS === "android") setShowDate(false); if (event.type !== "dismissed" && date) setDue([date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-")); }} />)}
      </View>
    </> : <Select label={t("반복")} value={cadence} options={["daily", "weekly", "monthly"].map((id, i) => ({ id, label: t(["매일", "매주", "매월"][i]) }))} onChange={setCadence} />}
    <Field label={t("설명")} value={description} onChangeText={setDescription} multiline maxLength={10000} />
    {!!error && <ErrorState message={error} />}
    <Button icon={Save} label={t("저장")} onPress={() => void save()} busy={busy} />
  </Screen></KeyboardAvoidingView>;
}
