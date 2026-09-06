import type { Translator } from "./server-language";
import { systemPropertyLabel } from "./property-label";

export type ManagementProperty = { id: string; name: string; type: string; options: string; system_key: string | null; active: number };
export type ManagementSnapshot = {
  parentProjectId: string | null;
  item: { id: string; kind: "project" | "task"; title: string; parent_id: string | null; status: string; priority: string; progress: number; due_date: string | null; archived_at: string | null; updated_at: string } | null;
  assignments: { id: string; role: string; member_id: string; updated_at: string }[];
  members: { id: string; display_name: string; role: string; status: string; user_id: string | null; updated_at: string }[];
  definitions: ManagementProperty[];
  values: { property_id: string; value: string; updated_at: string }[];
};
export type ManagementState = Record<string, Record<string, { value?: string | null; selected_date?: string | null; selected_option?: { value: string } | null; selected_options?: { value: string }[] }>>;
export type ManagementValues = { status: string; priority: string; dueDate: string | null; assignee: string | null; properties: Record<string, string | number | boolean | string[] | null> };
export type ManagementDraft = { snapshot: string; channel: string; ts: string; memberId: string; propertyIds: string[] };
export const mgField = (id: string) => `mg_prop_${id}`;
export const mgStatuses = { backlog: "백로그", todo: "할 일", policy_discussion: "정책 논의", in_progress: "진행 중", developing: "개발 중", development_done: "개발 완료", done: "완료", blocked: "막힘" };
export const mgPriorities = { low: "낮음", medium: "보통", high: "높음", urgent: "긴급" };
const nil = "__none";
const text = (value: string) => ({ type: "plain_text", text: value });
const option = (label: string, value: string) => ({ text: text(label.slice(0, 75)), value });
export function propertyOptions(p: ManagementProperty): string[] { try { const values = JSON.parse(p.options); return Array.isArray(values) ? values.filter((v) => typeof v === "string") : []; } catch { return []; } }
export function initialManagementValues(snapshot: ManagementSnapshot): ManagementValues {
  const item = snapshot.item!;
  return { status: item.kind === "task" ? ["done", "development_done"].includes(item.status) ? "done" : "todo" : item.status,
    priority: item.priority, dueDate: item.due_date, assignee: snapshot.assignments.find((a) => a.role === (item.kind === "project" ? "project_dri" : "task_assignee"))?.member_id ?? null,
    properties: Object.fromEntries(snapshot.values.map((v) => { try { return [v.property_id, JSON.parse(v.value)]; } catch { return [v.property_id, v.value]; } })) };
}
export function editableManagementProperties(snapshot: ManagementSnapshot) {
  const values = initialManagementValues(snapshot).properties;
  return snapshot.item?.kind === "project" ? snapshot.definitions.filter((p) => {
    const value = values[p.id];
    return p.active && !p.system_key
    && ["text", "number", "select", "date", "checkbox", "member", "members"].includes(p.type)
    && !(typeof value === "string" && value.length > 3000)
    && !(p.type === "members" && Array.isArray(value) && value.length > 50);
  }).slice(0, 85) : [];
}
function selected(state: ManagementState, id: string) { return state[id]?.[id]?.selected_option?.value ?? nil; }
export class ManagementFieldError extends Error {
  constructor(public field: string, message: string) { super(message); }
}
export function parseManagementValues(snapshot: ManagementSnapshot, ids: string[], state: ManagementState): ManagementValues {
  const result = initialManagementValues(snapshot);
  const invalid = (field: string) => { throw new ManagementFieldError(field, "입력값을 확인해 주세요."); };
  const date = (raw: string | null | undefined, field: string) => {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw)) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) return invalid(field);
    return raw;
  };
  const activeMember = (id: string, field: string) => { if (!snapshot.members.some((m) => m.id === id && m.status === "active")) invalid(field); return id; };
  if (state.mg_status) result.status = selected(state, "mg_status");
  if (!(snapshot.item?.kind === "task" ? ["todo", "done"] : Object.keys(mgStatuses)).includes(result.status)) invalid("mg_status");
  if (state.mg_priority) result.priority = selected(state, "mg_priority");
  if (!Object.keys(mgPriorities).includes(result.priority)) invalid("mg_priority");
  if (state.mg_due) result.dueDate = date(state.mg_due.mg_due.selected_date, "mg_due");
  if (state.mg_member) result.assignee = selected(state, "mg_member") === nil ? null : activeMember(selected(state, "mg_member"), "mg_member");
  for (const p of snapshot.definitions.filter((p) => ids.includes(p.id))) {
    const field = mgField(p.id), input = state[field]?.[field];
    if (!input) continue;
    const choice = input.selected_option?.value ?? nil;
    let value: ManagementValues["properties"][string] = null;
    if (p.type === "select") {
      if (choice !== nil) { const choices = propertyOptions(p); if (!/^\d+$/.test(choice) || !choices[Number(choice)]) invalid(field); value = choices[Number(choice)]; }
    } else if (p.type === "member") value = choice === nil ? null : activeMember(choice, field);
    else if (p.type === "members") {
      if ((input.selected_options?.length ?? 0) > 50) invalid(field);
      value = [...new Set((input.selected_options ?? []).map((o) => activeMember(o.value, field)))];
    }
    else if (p.type === "checkbox") { if (![nil, "true", "false"].includes(choice)) invalid(field); value = choice === nil ? null : choice === "true"; }
    else if (p.type === "date") value = date(input.selected_date, field);
    else {
      const raw = input.value?.trim() ?? "";
      if (raw.length > 3000) invalid(field);
      value = !raw ? null : p.type === "number" ? Number(raw) : raw;
      if (typeof value === "number" && !Number.isFinite(value)) invalid(field);
    }
    result.properties[p.id] = Array.isArray(value) && !value.length ? null : value;
  }
  return result;
}

export function managementEditorView(snapshot: ManagementSnapshot, requestId: string, ids: string[], t: Translator,
  options: { state?: ManagementState; error?: string; errorField?: string; appUrl?: string; itemId?: string } = {}) {
  const item = snapshot.item!, original = initialManagementValues(snapshot), blocks: Record<string, unknown>[] = [];
  const label = (key: string, fallback: string) => {
    const definition = item.kind === "project" ? snapshot.definitions.find((p) => p.system_key === key) : undefined;
    return systemPropertyLabel(definition ? { name: definition.name, systemKey: definition.system_key } : undefined, t, fallback);
  };
  const add = (id: string, label: string, element: Record<string, unknown>, optional = true) => {
    const supplied = options.state?.[id]?.[id];
    if (supplied) {
      delete element.initial_value; delete element.initial_date; delete element.initial_option; delete element.initial_options;
      if (element.type === "plain_text_input" && supplied.value) element.initial_value = supplied.value;
      if (element.type === "datepicker" && supplied.selected_date) element.initial_date = supplied.selected_date;
      if (supplied.selected_option) element.initial_option = choiceLabel(snapshot, id, supplied.selected_option.value, t);
      if (supplied.selected_options?.length) element.initial_options = supplied.selected_options.map((o) => option(snapshot.members.find((m) => m.id === o.value)?.display_name || t("미지정"), o.value));
    }
    blocks.push({ type: "input", block_id: id, label: text(label.slice(0, 200)), optional, element: { action_id: id, ...element },
      ...(options.errorField === id ? { hint: text(t("입력값을 확인해 주세요.")) } : {}) });
  };
  const staticSelect = (labels: Record<string, string>, value: string | null) => {
    const choices = Object.entries(labels).map(([v, label]) => option(t(label), v));
    return { type: "static_select", options: choices, ...(value && labels[value] ? { initial_option: option(t(labels[value]), value) } : {}), placeholder: text(t("미지정")) };
  };
  const searchable = (id: string, value: string | string[] | null, multi = false) => {
    const choices = allChoices(snapshot, id, t);
    const initial = (v: string) => choiceLabel(snapshot, id, v, t);
    const selectedValues = Array.isArray(value) ? value : multi ? [] : [typeof value === "string" ? value : nil];
    const staticOptions = choices.length > 0 && choices.length <= 100 && selectedValues.every((v) => choices.some((o) => o.value === v));
    return { type: multi ? staticOptions ? "multi_static_select" : "multi_external_select" : staticOptions ? "static_select" : "external_select",
      ...(staticOptions ? { options: choices } : { min_query_length: 0 }), placeholder: text(t("미지정")),
      ...(multi ? { max_selected_items: 50, ...(Array.isArray(value) && value.length ? { initial_options: value.map(initial) } : {}) }
        : { initial_option: initial(typeof value === "string" ? value : nil) }) };
  };
  blocks.push({ type: "section", text: text(item.title.slice(0, 2800)) });
  blocks.push({ type: "context", elements: [text(t("미지정 값은 비워 둘 수 있습니다."))] });
  if (options.error) blocks.push({ type: "section", text: text(options.error.slice(0, 2800)) });
  add("mg_status", label("status", "상태"), staticSelect(item.kind === "task" ? { todo: "할 일", done: "완료" } : mgStatuses, original.status), false);
  add("mg_member", label("project_dri", item.kind === "project" ? "책임자" : "담당자"), searchable("mg_member", original.assignee));
  add("mg_due", label("due_date", "기한"), { type: "datepicker", placeholder: text(t("미지정")), ...(original.dueDate ? { initial_date: original.dueDate } : {}) });
  add("mg_priority", label("priority", "우선순위"), staticSelect(mgPriorities, original.priority), false);
  for (const p of snapshot.definitions.filter((p) => ids.includes(p.id))) {
    const id = mgField(p.id), value = original.properties[p.id] ?? null;
    if (["select", "member", "members"].includes(p.type)) add(id, p.name, searchable(id, p.type === "select" && typeof value === "string" ? String(propertyOptions(p).indexOf(value)) : value as string | string[] | null, p.type === "members"));
    else if (p.type === "checkbox") add(id, p.name, staticSelect({ [nil]: "미지정", true: "예", false: "아니요" }, value === null ? nil : String(value)));
    else if (p.type === "date") add(id, p.name, { type: "datepicker", ...(value ? { initial_date: value } : {}), placeholder: text(t("미지정")) });
    else add(id, p.name, { type: "plain_text_input", max_length: 3000, ...(value !== null ? { initial_value: String(value) } : {}), placeholder: text(t("미지정")) });
  }
  if (item.kind === "project" && snapshot.definitions.filter((p) => p.active && !p.system_key).length > ids.length) blocks.push({ type: "context", elements: [text(t("나머지 속성은 Project에서 수정해 주세요."))] });
  if (item.kind === "task") blocks.push({ type: "context", elements: [text(t("분류 등 Project 속성은 상위 Project에서 수정합니다."))] });
  const actions: Record<string, unknown>[] = [];
  if (item.kind === "task" && snapshot.parentProjectId) actions.push({ type: "button", action_id: "management_parent", text: text(t("상위 Project 정보 수정")), value: snapshot.parentProjectId });
  if (options.error) actions.push({ type: "button", action_id: "management_reload", value: item.id, text: text(t("최신 정보로 다시 열기")),
    confirm: { title: text(t("최신 정보로 다시 열기")), text: text(t("입력 중인 변경을 버리고 최신 정보를 불러옵니다.")), confirm: text(t("다시 열기")), deny: text(t("취소")) } });
  if (options.appUrl) actions.push({ type: "button", text: text(t("업무 열기")), url: `${options.appUrl}/?view=${item.kind === "project" ? "work" : "inbox"}&${item.kind}=${encodeURIComponent(item.id)}` });
  if (actions.length) blocks.push({ type: "actions", elements: actions });
  return { type: "modal", callback_id: "management_submit", private_metadata: requestId, notify_on_close: false,
    title: text(t("정보 입력·수정")), submit: text(t("변경 저장")), close: text(t("취소")), blocks };
}

function allChoices(snapshot: ManagementSnapshot, field: string, t: Translator) {
  let values: ReturnType<typeof option>[];
  const property = snapshot.definitions.find((p) => mgField(p.id) === field);
  if (property?.type === "select") values = propertyOptions(property).map((value, i) => option(value, String(i)));
  else if (field === "mg_member" || property?.type === "member" || property?.type === "members") values = snapshot.members.filter((m) => m.status === "active").map((m) => option(m.display_name, m.id));
  else if (field === "mg_status") values = Object.entries(snapshot.item?.kind === "task" ? { todo: "할 일", done: "완료" } : mgStatuses).map(([v, label]) => option(t(label), v));
  else if (field === "mg_priority") values = Object.entries(mgPriorities).map(([v, label]) => option(t(label), v));
  else if (property?.type === "checkbox") values = [option(t("예"), "true"), option(t("아니요"), "false")];
  else return [];
  if (!["mg_status", "mg_priority"].includes(field) && property?.type !== "members") values.unshift(option(t("미지정"), nil));
  return values;
}
function choiceLabel(snapshot: ManagementSnapshot, field: string, value: string, t: Translator) {
  return allChoices(snapshot, field, t).find((o) => o.value === value)
    ?? option(snapshot.members.find((m) => m.id === value)?.display_name || t("미지정"), value);
}
export function choicesFor(snapshot: ManagementSnapshot, field: string, query: string, t: Translator) {
  const values = allChoices(snapshot, field, t);
  return values.filter((o) => !query || o.text.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 100);
}
