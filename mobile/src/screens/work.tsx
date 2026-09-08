import React, { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, CircleCheck, FolderKanban, Plus, Repeat2 } from "lucide-react-native";
import { useApp, useBootstrap } from "../context";
import { Badge, Button, ErrorState, Field, IconButton, Loading, Row, Screen, Txt } from "../ui";
import { activeItems, complete, myTasks, overdue, today } from "../model";
import type { Bootstrap, Item, Routes } from "../types";

export const statusText: Record<string, string> = { backlog: "대기", todo: "할 일", policy_discussion: "정책 논의", in_progress: "진행 중", developing: "개발 중", development_done: "개발 완료", done: "완료", blocked: "막힘", archived: "보관됨" };
export function useWrite() {
  const { api, t } = useApp(), client = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body, method = "PATCH" }: { path: string; body: unknown; method?: string }) => api(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => { void client.invalidateQueries(); },
    onError: () => Alert.alert(t("저장하지 못했습니다."), t("연결을 확인하고 다시 시도해 주세요.")),
  });
}
export function TaskRow({ item, writable, data }: { item: Item; writable: boolean; data?: Bootstrap }) {
  const nav = useNavigation<NativeStackNavigationProp<Routes>>(), { theme, t, language } = useApp(), write = useWrite();
  const done = complete(item.status), late = overdue(item);
  const parent = data?.items.find(i => i.id === item.parentId)?.title || data?.routines.find(r => r.id === item.routineId)?.title;
  return <View style={{ flexDirection: "row", alignItems: "flex-start", borderBottomWidth: 0.5, borderBottomColor: theme.tokens["border-default"] }}>
    <Pressable accessibilityRole="checkbox" aria-checked={done} aria-disabled={!writable || write.isPending} accessibilityState={{ checked: done, disabled: !writable || write.isPending }} accessibilityLabel={item.title + ": " + t(done ? "완료 취소" : "완료")} disabled={!writable || write.isPending}
      onPress={() => write.mutate({ path: "/api/items", body: { id: item.id, status: done ? "todo" : "done" } })}
      style={({ pressed }) => ({ minWidth: 48, minHeight: 56, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.tokens["bg-hover"] : "transparent" })}>
      {done ? <CircleCheck size={22} color={theme.tokens["success-fg"]} /> : <Circle size={22} color={theme.tokens["border-control"]} />}
    </Pressable>
    <Pressable accessibilityRole="button" onPress={() => nav.navigate("Item", { id: item.id })} style={{ flex: 1, paddingVertical: 12, paddingRight: 4, gap: 4 }}>
      <Txt style={done ? { textDecorationLine: "line-through", color: theme.tokens["text-secondary"] } : undefined}>{item.title}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {parent && <Txt role="meta" muted>{parent}</Txt>}
        {item.dueDate && <Txt role="meta" style={{ color: theme.tokens[late ? "danger-fg" : "text-secondary"] }}>{late ? t("기한 초과") + " · " : ""}{new Date(item.dueDate + "T12:00:00").toLocaleDateString(language, { month: "short", day: "numeric" })}</Txt>}
      </View>
    </Pressable>
  </View>;
}
export function TodayScreen() {
  const query = useBootstrap(), { t, language } = useApp(), nav = useNavigation<NativeStackNavigationProp<Routes>>();
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const data = query.data, tasks = myTasks(data), member = data.team.members.find(m => m.userId === data.user.id);
  const routines = data.routines.filter(r => r.active && !r.systemKey && r.assigneeMemberId === member?.id);
  const writable = data.team.currentRole !== "viewer";
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1 }}><Txt muted role="label">{new Date(today() + "T12:00:00").toLocaleDateString(language, { month: "long", day: "numeric", weekday: "long" })}</Txt><Txt role="title">{t("오늘 할 일")}</Txt></View>
      {writable && <IconButton icon={Plus} label={t("Task 추가")} onPress={() => nav.navigate("Editor", { kind: "task" })} />}
    </View>
    {query.isError && <ErrorState retry={() => void query.refetch()} />}
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}><Badge>{t("내 담당 업무")} {tasks.length}</Badge>{tasks.some(i => overdue(i)) && <Badge danger>{t("기한 초과")} {tasks.filter(i => overdue(i)).length}</Badge>}</View>
    <View>{tasks.length ? tasks.map(item => <TaskRow key={item.id} item={item} data={data} writable={writable} />) : <Txt muted>{t("미완료 업무가 없습니다.")}</Txt>}</View>
    {!!routines.length && <View><Txt role="section">{t("Routine")}</Txt>{routines.map(r => <Row key={r.id} icon={Repeat2} onPress={() => nav.navigate("Routine", { id: r.id })}><Txt>{r.title}</Txt><Txt muted role="meta">{t(r.completed ? "완료" : "진행 중")}</Txt></Row>)}</View>}
  </Screen>;
}
export function ProjectsScreen() {
  const query = useBootstrap(), { t } = useApp(), nav = useNavigation<NativeStackNavigationProp<Routes>>(), [search, setSearch] = useState(""), [showDone, setShowDone] = useState(false);
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const data = query.data, projects = activeItems(data).filter(i => i.kind === "project" && (showDone || !complete(i.status)) && i.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><Txt role="title">{t("Project")}</Txt>{data.team.currentRole !== "viewer" && <IconButton icon={Plus} label={t("Project 만들기")} onPress={() => nav.navigate("Editor", { kind: "project" })} />}</View>
    <Field label={t("검색")} value={search} onChangeText={setSearch} autoCorrect={false} returnKeyType="search" />
    <Button secondary icon={showDone ? Check : undefined} label={t("완료 포함")} onPress={() => setShowDone(v => !v)} />
    <View>{projects.map(project => <Row key={project.id} icon={FolderKanban} onPress={() => nav.navigate("Item", { id: project.id })}>
      <Txt>{project.title}</Txt><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Badge danger={overdue(project)}>{t(overdue(project) ? "기한 초과" : statusText[project.status])}</Badge><Txt role="meta" muted>{project.dueDate || t("기한 없음")} · {project.progress}%</Txt></View>
    </Row>)}</View>
    {!projects.length && <Txt muted>{t(search ? "검색 결과가 없습니다." : "Project가 없습니다.")}</Txt>}
  </Screen>;
}
export function RoutinesScreen() {
  const query = useBootstrap(), { t } = useApp(), nav = useNavigation<NativeStackNavigationProp<Routes>>();
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const data = query.data;
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>
    {data.team.currentRole !== "viewer" && <Button label={t("Routine 추가")} icon={Plus} onPress={() => nav.navigate("Editor", { kind: "routine" })} />}
    <View>{data.routines.filter(r => r.active && !r.systemKey).map(r => <Row key={r.id} icon={Repeat2} onPress={() => nav.navigate("Routine", { id: r.id })}><Txt>{r.title}</Txt><Txt muted role="meta">{t(r.cadence === "daily" ? "매일" : r.cadence === "weekly" ? "매주" : "매월")}</Txt></Row>)}</View>
  </Screen>;
}
