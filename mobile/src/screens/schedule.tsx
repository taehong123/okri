import React, { useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Target } from "lucide-react-native";
import { useApp, useBootstrap } from "../context";
import { Badge, Button, ErrorState, IconButton, Loading, Row, Screen, Txt } from "../ui";
import { activeItems, dayOffset, overdue, plusDays, today } from "../model";
import type { Item, Routes } from "../types";

export function GanttScreen() {
  const query = useBootstrap(), { t, language, theme } = useApp(), nav = useNavigation<NativeStackNavigationProp<Routes>>();
  const [anchor, setAnchor] = useState(today()), [days, setDays] = useState(14), [focused, setFocused] = useState<string | null>(null), { fontScale } = useWindowDimensions();
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const items = activeItems(query.data), projects = items.filter(i => i.kind === "project"), start = plusDays(anchor, -1), dayWidth = 48, rowHeight = Math.max(88, fontScale * 64);
  const dates = Array.from({ length: days }, (_, index) => plusDays(start, index));
  const labels: { item: Item; child: boolean }[] = projects.flatMap(item => [{ item, child: false }, ...items.filter(t => t.kind === "task" && t.parentId === item.id).map(item => ({ item, child: true }))]);
  const width = dayWidth * days, todayIndex = dayOffset(today(), start);
  return <Screen>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <IconButton icon={ChevronLeft} label={t("이전")} onPress={() => setAnchor(plusDays(anchor, -days))} /><Button secondary label={t("오늘")} onPress={() => setAnchor(today())} /><IconButton icon={ChevronRight} label={t("다음")} onPress={() => setAnchor(plusDays(anchor, days))} />
    </View>
    <View style={{ flexDirection: "row", gap: 8 }}><View style={{ flex: 1 }}><Button secondary={days !== 14} label={t("2주")} onPress={() => setDays(14)} /></View><View style={{ flex: 1 }}><Button secondary={days !== 30} label={t("30일")} onPress={() => setDays(30)} /></View></View>
    <Txt role="label" muted>{start} – {dates.at(-1)}</Txt>
    <Txt role="meta" muted>{t("오늘과 마감일 기준")}</Txt>
    {!projects.length ? <Txt muted>{t("Project가 없습니다.")}</Txt> : <ScrollView horizontal contentContainerStyle={{ minWidth: 180 + width }} showsHorizontalScrollIndicator>
      <View>
        <View style={{ flexDirection: "row", minHeight: 64, borderBottomWidth: 1, borderColor: theme.tokens["border-default"] }}><View style={{ width: 180, justifyContent: "center" }}><Txt role="label">{t("Project")}</Txt></View>{dates.map(d => <View key={d} style={{ width: dayWidth, alignItems: "center", justifyContent: "center", backgroundColor: d === today() ? theme.tokens["selected-bg"] : theme.tokens["bg-surface"] }}><Txt role="meta" muted>{new Date(d + "T12:00:00").toLocaleDateString(language, { weekday: "short" })}</Txt><Txt role="label">{Number(d.slice(8))}</Txt></View>)}</View>
        {labels.map(({ item, child }) => {
          const dueIndex = item.dueDate ? dayOffset(item.dueDate, start) : null;
          const left = Math.max(0, Math.min(todayIndex, dueIndex ?? 0)), right = Math.min(days, Math.max(todayIndex, dueIndex ?? 0) + 1);
          const late = overdue(item);
          return <View key={item.id} style={{ flexDirection: "row", minHeight: rowHeight, borderBottomWidth: 0.5, borderBottomColor: theme.tokens["border-default"] }}>
            <View style={{ width: 180, paddingRight: 12, paddingLeft: child ? 16 : 0, justifyContent: "center" }}><Row onPress={() => nav.navigate("Item", { id: item.id })} trailing={<View />}><Txt role={child ? "label" : "body"}>{item.title}</Txt>{item.dueDate && <Txt role="meta" muted>{item.dueDate}</Txt>}{late && <Badge danger>{t("기한 초과")}</Badge>}</Row></View>
            <View style={{ width, minHeight: rowHeight, justifyContent: "center" }}>
              <View pointerEvents="none" style={{ position: "absolute", inset: 0, flexDirection: "row" }}>{dates.map(d => <View key={d} style={{ width: dayWidth, height: "100%", borderLeftWidth: 0.5, borderLeftColor: theme.tokens["border-default"], backgroundColor: d === today() ? theme.tokens["bg-subtle"] : "transparent" }} />)}</View>
              {dueIndex === null ? <View style={{ paddingLeft: 12 }}><Txt muted role="meta">{t("기한 없음")}</Txt></View> : child ? dueIndex >= 0 && dueIndex < days && <View style={{ marginLeft: dueIndex * dayWidth, width: dayWidth }}><IconButton icon={Target} label={item.title + " " + item.dueDate} onPress={() => nav.navigate("Item", { id: item.id })} /></View>
                : right > left && <Pressable accessibilityRole="button" accessibilityLabel={item.title + ", " + item.dueDate} onFocus={() => setFocused(item.id)} onBlur={() => setFocused(null)} onPress={() => nav.navigate("Item", { id: item.id })} style={{ marginLeft: left * dayWidth, width: Math.max(dayWidth, (right - left) * dayWidth), paddingHorizontal: 2, minHeight: 48, justifyContent: "center", borderWidth: 1, borderColor: focused === item.id ? theme.tokens["focus-ring"] : "transparent" }}><View style={{ height: 24, borderRadius: 4, backgroundColor: theme.tokens[late ? "danger-fg" : "progress-fill"] }} /></Pressable>}
            </View>
          </View>;
        })}
      </View>
    </ScrollView>}
  </Screen>;
}
export function OkrScreen() {
  const query = useBootstrap(), { t, theme } = useApp(), nav = useNavigation<NativeStackNavigationProp<Routes>>(), [collapsed, setCollapsed] = useState<string[]>([]);
  if (query.isPending) return <Loading />;
  if (!query.data) return <Screen><ErrorState retry={() => void query.refetch()} /></Screen>;
  const items = activeItems(query.data), roots = items.filter(i => i.kind === "objective");
  function node(item: Item, ancestors: string[] = []): React.ReactNode {
    if (ancestors.includes(item.id) || ancestors.length > 4) return null;
    const children = items.filter(c => c.parentId === item.id), hidden = collapsed.includes(item.id);
    const type = { objective: "Objective", key_result: "Key Result", initiative: "Initiative", project: "Project", task: "Task" }[item.kind];
    return <View key={item.id} style={{ marginLeft: ancestors.length ? 8 : 0, borderLeftWidth: ancestors.length ? 2 : 0, borderLeftColor: theme.tokens[item.kind === "initiative" ? "initiative-rail" : "kr-rail"], paddingLeft: ancestors.length ? 8 : 0, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}><View style={{ flex: 1 }}><Row onPress={() => nav.navigate("Item", { id: item.id })} trailing={<View />}><Badge>{type}</Badge><Txt role={item.kind === "objective" ? "section" : "body"}>{item.title}</Txt><Txt role="meta" muted>{item.progress}%</Txt></Row></View>
        {!!children.length && <IconButton icon={hidden ? ChevronRight : ChevronDown} label={t(hidden ? "펼치기" : "접기")} onPress={() => setCollapsed(v => hidden ? v.filter(id => id !== item.id) : [...v, item.id])} />}
      </View>
      {!hidden && children.map(child => node(child, [...ancestors, item.id]))}
    </View>;
  }
  return <Screen refresh={() => void query.refetch()} refreshing={query.isRefetching}>{query.data.team.currentRole !== "viewer" && <Button secondary icon={Plus} label={t("Objective 추가")} onPress={() => nav.navigate("Editor", { kind: "objective" })} />}{roots.length ? roots.map(root => node(root)) : <Txt muted>{t("등록된 Objective가 없습니다.")}</Txt>}</Screen>;
}
