import React from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextProps, type TextInputProps, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { AlertCircle, ChevronRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "./context";

export function Txt({ role = "body", muted = false, style, ...props }: Omit<TextProps, "role"> & { role?: "body" | "label" | "meta" | "title" | "section"; muted?: boolean }) {
  const { theme } = useApp();
  const sizes = { body: 16, label: 14, meta: 13, title: 24, section: 18 };
  return <Text {...props} style={[{ fontFamily: "Pretendard", fontSize: sizes[role], lineHeight: sizes[role] * (role === "title" ? 1.3 : 1.6), letterSpacing: 0, color: theme.tokens[muted ? "text-secondary" : "text-primary"], fontWeight: role === "title" || role === "section" ? "700" : "400", flexShrink: 1 }, style]} />;
}
export function Button({ label, icon: Icon, onPress, busy = false, disabled = false, secondary = false, danger = false, compact = false }: { label: string; icon?: LucideIcon; onPress: () => void; busy?: boolean; disabled?: boolean; secondary?: boolean; danger?: boolean; compact?: boolean }) {
  const { theme } = useApp(), c = theme.tokens, [focused, setFocused] = React.useState(false);
  const role = disabled || busy ? "disabled" : danger ? "danger" : secondary ? "secondary" : "primary";
  return <Pressable onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} disabled={disabled || busy} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} style={({ pressed }) => [{
    minHeight: 48, minWidth: 48, paddingHorizontal: compact ? 12 : 16, paddingVertical: 12, borderRadius: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: c[("button-" + role + (pressed && role !== "disabled" ? "-active-bg" : "-bg")) as keyof typeof c],
    borderWidth: 1, borderColor: focused ? c["focus-ring"] : secondary ? c["border-default"] : "transparent",
  }]}>
    {busy ? <ActivityIndicator color={c["button-disabled-fg"]} /> : Icon && <Icon size={20} color={c[("button-" + role + "-fg") as keyof typeof c]} />}
    <Txt role="label" style={{ fontWeight: "600", color: c[("button-" + role + "-fg") as keyof typeof c] }}>{label}</Txt>
  </Pressable>;
}
export function IconButton({ icon: Icon, label, onPress, disabled }: { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean }) {
  const { theme } = useApp(), [focused, setFocused] = React.useState(false);
  return <Pressable onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: focused ? theme.tokens["focus-ring"] : "transparent", backgroundColor: pressed ? theme.tokens["bg-hover"] : "transparent" })}>
    <Icon size={22} color={theme.tokens[disabled ? "button-disabled-fg" : "icon-default"]} />
  </Pressable>;
}
export function Screen({ children, refresh, refreshing = false, style }: { children: React.ReactNode; refresh?: () => void; refreshing?: boolean; style?: ViewStyle }) {
  const { theme } = useApp(), insets = useSafeAreaInsets();
  return <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: theme.tokens["bg-page"] }} contentContainerStyle={[{ width: "100%", maxWidth: 1200, alignSelf: "center", padding: 16, paddingBottom: Math.max(24, insets.bottom), gap: 16 }, style]} refreshControl={refresh ? <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.tokens["text-primary"]} /> : undefined}>{children}</ScrollView>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { theme } = useApp(), [focused, setFocused] = React.useState(false);
  return <View style={{ gap: 8 }}><Txt role="label">{label}</Txt><TextInput {...props} accessibilityLabel={label} onFocus={e => { setFocused(true); props.onFocus?.(e); }} onBlur={e => { setFocused(false); props.onBlur?.(e); }} placeholderTextColor={theme.tokens["input-placeholder"]} style={[{
    color: theme.tokens["input-fg"], backgroundColor: theme.tokens["input-bg"], fontFamily: "Pretendard", fontSize: 16, lineHeight: 25.6, letterSpacing: 0,
    minHeight: props.multiline ? 104 : 48, paddingHorizontal: 12, paddingVertical: 12, borderWidth: 1, borderRadius: 8,
    borderColor: theme.tokens[focused ? "focus-ring" : "border-control"], textAlignVertical: props.multiline ? "top" : "auto",
  }, props.style]} /></View>;
}
export function ErrorState({ retry, message }: { retry?: () => void; message?: string }) {
  const { theme, t } = useApp();
  return <View accessibilityRole="alert" style={{ gap: 12, paddingVertical: 16 }}><AlertCircle color={theme.tokens["danger-fg"]} size={24} /><Txt>{message || t("연결을 확인하고 다시 시도해 주세요.")}</Txt>{retry && <Button secondary label={t("재시도")} onPress={retry} />}</View>;
}
export function Loading() {
  const { theme } = useApp();
  return <View style={{ flex: 1, padding: 32, justifyContent: "center", backgroundColor: theme.tokens["bg-page"] }}><ActivityIndicator color={theme.tokens["text-primary"]} /></View>;
}
export function Row({ children, onPress, icon: Icon, trailing }: { children: React.ReactNode; onPress?: () => void; icon?: LucideIcon; trailing?: React.ReactNode }) {
  const { theme } = useApp(), [focused, setFocused] = React.useState(false);
  const content = <>{Icon && <Icon size={20} color={theme.tokens["icon-default"]} />}<View style={{ flex: 1, gap: 4 }}>{children}</View>{trailing ?? (onPress && <ChevronRight size={18} color={theme.tokens["icon-default"]} />)}</>;
  const style = { minHeight: 56, paddingVertical: 12, gap: 12, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.tokens["border-default"] } as const;
  return onPress ? <Pressable accessibilityRole="button" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={onPress} style={({ pressed }) => [style, { backgroundColor: pressed ? theme.tokens["bg-hover"] : "transparent", borderColor: focused ? theme.tokens["focus-ring"] : "transparent", borderLeftWidth: focused ? 2 : 0 }]}>{content}</Pressable> : <View style={style}>{content}</View>;
}
export function Badge({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
  const { theme } = useApp();
  return <View style={{ alignSelf: "flex-start", backgroundColor: theme.tokens[danger ? "danger-bg" : "neutral-badge-bg"], paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}><Txt role="meta" style={{ color: theme.tokens[danger ? "danger-fg" : "neutral-badge-fg"] }}>{children}</Txt></View>;
}
