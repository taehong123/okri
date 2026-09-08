import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderKanban, Plus, Repeat2, Save, Send, Square } from "lucide-react-native";
import { useApp, useBootstrap } from "../context";
import { randomValue } from "../auth";
import { today, workGroups } from "../model";
import { Badge, Button, ErrorState, Field, Loading, Screen, Txt } from "../ui";
import type { Daily, DailyDraft, DailyWork } from "../types";

export function DailyScreen() {
  const { session, workspace, api } = useApp(), date = today();
  const query = useQuery({ queryKey: ["daily", session?.user.id, workspace, date], queryFn: ({ signal }) => api<Daily>("/api/daily-scrum?date=" + date, { signal }) });
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  return <DailyForm data={query.data} refresh={() => void query.refetch()} refreshing={query.isRefetching} key={(workspace || "") + date} />;
}
function DailyForm({ data, refresh, refreshing }: { data: Daily; refresh: () => void; refreshing: boolean }) {
  const { t, theme, api } = useApp(), bootstrap = useBootstrap(), client = useQueryClient();
  const [draft, setDraft] = useState<DailyDraft>({ ...data.draft, selectedWorkIds: data.draft.selectedWorkIds || [], selectedYesterdayWorkIds: data.draft.selectedYesterdayWorkIds || [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(""), [adding, setAdding] = useState<string | null>(null), [newTitle, setNewTitle] = useState("");
  const dirty = useRef(false), lock = useRef(false), submitId = useRef(randomValue()), addId = useRef(randomValue());
  const writable = bootstrap.data?.team.currentRole !== "viewer";
  useEffect(() => { if (!dirty.current) setDraft({ ...data.draft, selectedWorkIds: data.draft.selectedWorkIds || [], selectedYesterdayWorkIds: data.draft.selectedYesterdayWorkIds || [] }); }, [data.draft]);
  function patch(value: Partial<DailyDraft>) { dirty.current = true; setSaved(""); submitId.current = randomValue(); setDraft(d => ({ ...d, ...value })); }
  function toggle(key: string, yesterday = false) {
    const field = yesterday ? "selectedYesterdayWorkIds" : "selectedWorkIds";
    const values = draft[field] || [];
    if (!values.includes(key) && values.length >= 50) return;
    const other = yesterday ? "selectedWorkIds" : "selectedYesterdayWorkIds";
    patch({ [field]: values.includes(key) ? values.filter(v => v !== key) : [...values, key], [other]: draft[other].filter(v => v !== key), noPlannedTasks: false, skipReason: null, skipNote: "" });
  }
  async function save(submit: boolean) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setSaved("");
    try {
      await api("/api/daily-scrum", { method: "PUT", body: JSON.stringify({ ...draft, date: data.date, selectedTaskIds: draft.selectedWorkIds.filter(k => k.startsWith("task:")).map(k => k.slice(5)) }) });
      if (submit) await api("/api/daily-scrum/submit", { method: "POST", body: JSON.stringify({ date: data.date, requestId: submitId.current }) });
      dirty.current = false; setSaved(t(submit ? "제출했습니다." : "저장했습니다."));
      await client.invalidateQueries();
    } catch { setError(t("연결을 확인하고 다시 시도해 주세요.") + " " + t("저장한 내용은 유지됩니다.")); }
    finally { lock.current = false; setBusy(false); }
  }
  async function addTask(kind: string, id: string) {
    if (!newTitle.trim() || lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ task: { id: string } }>("/api/daily-scrum/tasks", { method: "POST", body: JSON.stringify({ title: newTitle.trim(), date: data.date, parentKind: kind, parentId: id, requestId: addId.current }) });
      patch({ selectedWorkIds: [...new Set([...draft.selectedWorkIds, "task:" + result.task.id])] });
      addId.current = randomValue(); setAdding(null); setNewTitle(""); setSaved(t("Task를 추가하고 오늘 할 일에 선택했습니다."));
      await client.invalidateQueries();
    } catch { setError(t("연결을 확인하고 다시 시도해 주세요.")); }
    finally { lock.current = false; setBusy(false); }
  }
  function WorkCheck({ item, yesterday = false }: { item: DailyWork; yesterday?: boolean }) {
    const checked = (yesterday ? draft.selectedYesterdayWorkIds : draft.selectedWorkIds).includes(item.key);
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={item.title} aria-checked={checked} aria-disabled={!writable || busy} accessibilityState={{ checked, disabled: !writable || busy }} disabled={!writable || busy} onPress={() => toggle(item.key, yesterday)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", minHeight: 52, gap: 12, paddingVertical: 12, backgroundColor: pressed ? theme.tokens["bg-hover"] : "transparent", borderBottomWidth: 0.5, borderBottomColor: theme.tokens["border-default"] })}>
      <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.tokens["border-control"], borderRadius: 4, backgroundColor: theme.tokens[checked ? "button-primary-bg" : "bg-page"] }}>{checked && <Check size={18} color={theme.tokens["button-primary-fg"]} />}</View>
      <View style={{ flex: 1 }}><Txt>{item.title}</Txt>{yesterday && !item.completedYesterday && checked && <Txt muted role="meta">{t("제출 시 완료 처리")}</Txt>}</View>
    </Pressable>;
  }
  function groups(work: DailyWork[], yesterday = false) {
    return workGroups(work).map(group => <View key={group.key} style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 8 }}>
        {group.kind === "routine" ? <Repeat2 size={20} color={theme.tokens["icon-default"]} /> : <FolderKanban size={20} color={theme.tokens["icon-default"]} />}
        <Txt role="section" style={{ flex: 1 }}>{group.kind === "general" ? t("일반 업무") : group.title}</Txt>
      </View>
      {group.children.map(row => <WorkCheck key={row.key} item={row} yesterday={yesterday} />)}
      {!group.children.length && group.parent && <WorkCheck item={group.parent} yesterday={yesterday} />}
      {!yesterday && group.parent && writable && (adding === group.key ? <View style={{ gap: 8 }}><Field label={t("Task 제목")} value={newTitle} onChangeText={setNewTitle} autoFocus /><Button label={t("추가하고 오늘 할 일에 선택")} busy={busy} onPress={() => void addTask(group.kind, group.parent!.id)} /><Button secondary label={t("취소")} onPress={() => { setAdding(null); setNewTitle(""); }} /></View> : <Button secondary icon={Plus} label={t("Task 추가")} onPress={() => { addId.current = randomValue(); setNewTitle(""); setAdding(group.key); }} />)}
    </View>);
  }
  return <Screen refresh={refresh} refreshing={refreshing}>
    <Txt role="title">{t("데일리")}</Txt><Txt muted role="label">{data.date} · {data.member.displayName}</Txt>
    {!!data.latestSubmission && <Badge>{t("제출 완료")}</Badge>}
    <Txt role="section">{t("완료한 일")}</Txt>
    {groups(data.candidates.yesterdayWork || [], true)}
    <Field label={t("어제 한 일")} value={draft.yesterdayNote} onChangeText={v => patch({ yesterdayNote: v })} multiline editable={writable && !busy} />
    <Txt role="section">{t("오늘 할 일")}</Txt>
    {groups(data.candidates.work || [])}
    <Button secondary icon={draft.noPlannedTasks ? Check : Square} disabled={!writable || busy} label={t("오늘 계획된 업무 없음")} onPress={() => patch({ noPlannedTasks: !draft.noPlannedTasks, selectedWorkIds: [], selectedTaskIds: [] })} />
    <Field label={t("오늘 할 일 메모")} value={draft.todayNote} onChangeText={v => patch({ todayNote: v })} multiline editable={writable && !busy} />
    <Field label={t("도움이 필요한 일")} value={draft.blockersNote} onChangeText={v => patch({ blockersNote: v })} multiline editable={writable && !busy} />
    {!!error && <ErrorState message={error} />}
    {!!saved && <View accessibilityRole="alert"><Txt style={{ color: theme.tokens["success-fg"] }}>{saved}</Txt></View>}
    {writable && <><Button secondary icon={Save} label={t("임시 저장")} busy={busy} onPress={() => void save(false)} /><Button icon={Send} label={t("제출")} busy={busy} onPress={() => void save(true)} /><Txt muted role="meta">{t("앱에서 작성한 내용은 제출 후 팀에 공유됩니다.")}</Txt></>}
  </Screen>;
}
