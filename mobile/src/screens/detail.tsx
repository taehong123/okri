import React from "react";
import { Alert, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Check, Pencil, Plus, RotateCcw } from "lucide-react-native";
import { useApp, useBootstrap } from "../context";
import { Badge, Button, ErrorState, Loading, Row, Screen, Txt } from "../ui";
import { activeItems, complete, overdue, today } from "../model";
import { statusText, TaskRow, useWrite } from "./work";
import type { Routes } from "../types";

export function ItemScreen({ route, navigation }: NativeStackScreenProps<Routes, "Item">) {
  const query = useBootstrap(), { t, theme } = useApp(), write = useWrite();
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const data = query.data, item = data.items.find(i => i.id === route.params.id);
  if (!item || item.archivedAt) return <Screen><Txt>{t("항목을 찾을 수 없습니다.")}</Txt></Screen>;
  const parent = data.items.find(i => i.id === item.parentId), children = activeItems(data).filter(i => i.parentId === item.id), writable = data.team.currentRole !== "viewer";
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>
    <Badge>{t(item.kind === "key_result" ? "Key Result" : item.kind === "objective" ? "Objective" : item.kind === "initiative" ? "Initiative" : item.kind === "project" ? "Project" : "Task")}</Badge>
    <Txt role="title">{item.title}</Txt>
    {writable && <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}><Button secondary icon={Pencil} label={t("수정")} onPress={() => navigation.navigate("Editor", { id: item.id })} />{item.kind === "task" && <Button icon={complete(item.status) ? RotateCcw : Check} busy={write.isPending} label={t(complete(item.status) ? "완료 취소" : "완료")} onPress={() => write.mutate({ path: "/api/mobile/v1/items", body: { id: item.id, status: complete(item.status) ? "todo" : "done" } })} />}</View>}
    <View><Row><Txt muted role="label">{t("상태")}</Txt><Badge danger={overdue(item)}>{t(overdue(item) ? "기한 초과" : statusText[item.status])}</Badge></Row>
      <Row><Txt muted role="label">{t("기한")}</Txt><Txt>{item.dueDate || t("기한 없음")}</Txt></Row>
      <Row><Txt muted role="label">{t(item.kind === "project" ? "책임자" : "담당자")}</Txt><Txt>{item.assignments.filter(a => a.role !== "project_worker").map(a => a.displayName).join(", ") || t("미지정")}</Txt></Row>
      {parent && <Row onPress={() => navigation.push("Item", { id: parent.id })}><Txt muted role="label">{t("상위 항목")}</Txt><Txt>{parent.title}</Txt></Row>}
    </View>
    {!!item.description && <Txt>{item.description}</Txt>}
    {item.kind !== "task" && <View style={{ gap: 8 }}><View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: item.progress }} style={{ height: 6, borderRadius: 3, backgroundColor: theme.tokens["progress-track"] }}><View style={{ height: 6, borderRadius: 3, width: Math.max(0, Math.min(100, item.progress)) + "%" as `${number}%`, backgroundColor: theme.tokens["progress-fill"] }} /></View><Txt role="meta" muted>{item.progress}%</Txt></View>}
    <View>{children.map(child => child.kind === "task" ? <TaskRow key={child.id} item={child} writable={writable} /> : <Row key={child.id} onPress={() => navigation.push("Item", { id: child.id })}><Txt>{child.title}</Txt><Txt role="meta" muted>{t(statusText[child.status])}</Txt></Row>)}</View>
    {item.kind === "project" && writable && <Button secondary icon={Plus} label={t("Task 추가")} onPress={() => navigation.navigate("Editor", { kind: "task", parentId: item.id })} />}
    {writable && (item.kind === "objective" || item.kind === "key_result" || item.kind === "initiative") && <Button secondary icon={Plus} label={t("하위 항목 추가")} onPress={() => navigation.navigate("Editor", { kind: item.kind === "objective" ? "key_result" : item.kind === "key_result" ? "initiative" : "project", parentId: item.id })} />}
  </Screen>;
}
export function RoutineScreen({ route, navigation }: NativeStackScreenProps<Routes, "Routine">) {
  const query = useBootstrap(), { t } = useApp(), write = useWrite();
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const data = query.data, routine = data.routines.find(i => i.id === route.params.id), writable = data.team.currentRole !== "viewer";
  if (!routine) return <Screen><Txt>{t("항목을 찾을 수 없습니다.")}</Txt></Screen>;
  const tasks = activeItems(data).filter(i => i.kind === "task" && i.routineId === routine.id);
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>
    <Badge>{t("Routine")}</Badge><Txt role="title">{routine.title}</Txt><Txt>{routine.description}</Txt>
    {writable && <Button icon={routine.completed ? RotateCcw : Check} busy={write.isPending} label={t(routine.completed ? "완료 취소" : "오늘 완료")} onPress={() => write.mutate({ path: "/api/mobile/v1/routine-completions", method: "PUT", body: { routineId: routine.id, date: today(), completed: !routine.completed } })} />}
    <View>{tasks.map(task => <TaskRow key={task.id} item={task} writable={writable} />)}</View>
    {writable && <Button secondary icon={Plus} label={t("Task 추가")} onPress={() => navigation.navigate("Editor", { kind: "task", routineId: routine.id })} />}
  </Screen>;
}
