import { env } from "cloudflare:workers";
import type { SlackConnection } from "@/db/schema";
import {
  ITEM_PRIORITIES,
  ITEM_STATUSES,
  createItem,
  getItem,
  getItemAssignmentMap,
  getSlackConnection,
  getTeam,
  listItems,
  listRoutines,
  replaceItemAssignmentRole,
  serializeItem,
  updateItem,
  type ItemPriority,
  type ItemStatus,
  type RequestAuthorization,
} from "@/lib/pace-data";
import { createSlackMemberLinkUrl, dailyMemberBySlack, slackApi, slackTokenForConnection } from "@/lib/slack-daily";
import { saveSlackProjectImages } from "@/lib/project-images";
import { readLanguagePreferences, workspaceMessageLanguage } from "@/lib/language-preferences";
import { serverTranslator, type Translator } from "@/lib/server-language";
import {
  SLACK_WORK_COMMANDS,
  type ParsedSlackWorkCommand,
  type SlackWorkCommand,
} from "@/lib/slack-work-command-parser";
import {
  prepareSlackWorkDraft,
  readSlackThread,
  SlackWorkIntakeError,
  type SlackWorkDraft,
} from "@/lib/slack-work-intake";

export { parseSlackWorkCommand } from "@/lib/slack-work-command-parser";

type WorkMessageEvent = {
  channel: string;
  channelType: string;
  user: string;
  text: string;
  ts?: string;
  threadTs?: string;
};

type CommandMetadata = {
  command: SlackWorkCommand;
  query: string;
  requestId: string;
  ownerId: string;
  teamId: string;
  slackUserId: string;
  memberId: string;
  createdAt: number;
  draft?: SlackWorkDraft;
  sourceThread?: { channel: string; ts: string };
};

type SlackState = Record<string, Record<string, {
  value?: string;
  selected_date?: string;
  selected_option?: { value?: string };
  selected_options?: Array<{ value?: string }>;
}>>;

export async function handleSlackWorkCommandEvent(
  request: Request,
  connection: SlackConnection,
  event: WorkMessageEvent,
  parsed: ParsedSlackWorkCommand,
  options: { preparingNotice?: boolean } = {},
) {
  const linked = await dailyMemberBySlack(connection.teamId, event.user);
  const token = await slackTokenForConnection(connection);
  const t = linked
    ? await memberTranslator(linked.authorization)
    : await serverTranslator(await workspaceMessageLanguage(env.DB, connection.ownerId));
  if (parsed.command === "help") {
    await postPrivate(token, event, commandHelp(t));
    return;
  }
  if (!linked) {
    const link = await createSlackMemberLinkUrl(connection.ownerId, connection.teamId, event.user, request);
    await postPrivate(token, event, t("OKRI 계정 연결이 필요합니다. 15분 안에 로그인해 연결해 주세요.\n{link}", { link }));
    return;
  }
  if (isWriteCommand(parsed.command) && linked.authorization.role === "viewer") {
    await postPrivate(token, event, t("Viewer는 조회 명령만 사용할 수 있습니다."));
    return;
  }
  if (parsed.command === "my_work") {
    await postPrivate(token, event, await assignedWorkSummary(linked.authorization, linked.memberId, t));
    return;
  }
  if (parsed.command === "work_create") {
    if (options.preparingNotice !== false) {
      await postPrivate(token, event, t("스레드를 읽고 생성 초안을 준비하고 있습니다."));
    }
    let draft: SlackWorkDraft;
    try {
      draft = await prepareSlackWorkDraft({
        authorization: linked.authorization,
        memberId: linked.memberId,
        token,
        event,
        query: parsed.query,
      });
    } catch (error) {
      console.error("Slack work draft preparation stopped", {
        name: error instanceof Error ? error.name : "unknown",
        code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "",
      });
      const message = error instanceof SlackWorkIntakeError
        ? t(error.message)
        : t("생성 초안을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      await postPrivate(token, event, message);
      return;
    }
    const metadata = commandMetadata(connection, event, linked.memberId, draft);
    const alternative = alternateDraftMetadata(metadata);
    const label = t(draft.kind === "project" ? "Project 생성 초안" : "Task 생성 초안");
    await postPrivate(token, event, `${label}: ${draft.title}`, [
      { type: "section", text: { type: "mrkdwn", text: reviewDraftText(draft, t) } },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "work_command_open", style: "primary", text: { type: "plain_text", text: t("검토 후 생성") }, value: serializeMetadata(metadata) },
          { type: "button", action_id: "work_command_open", text: { type: "plain_text", text: t(draft.kind === "project" ? "Task로 검토" : "Project로 검토") }, value: serializeMetadata(alternative) },
        ],
      },
    ]);
    return;
  }
  const metadata: CommandMetadata = {
    ...parsed,
    requestId: crypto.randomUUID(),
    ownerId: linked.authorization.ownerId,
    teamId: connection.teamId,
    slackUserId: event.user,
    memberId: linked.memberId,
    createdAt: Date.now(),
    ...(isCreateCommand(parsed.command) && sourceThread(event) ? { sourceThread: sourceThread(event)! } : {}),
  };
  const label = commandLabel(parsed.command, t);
  await postPrivate(token, event, `${label}${parsed.query ? ` · ${parsed.query}` : ""}`, [
    { type: "section", text: { type: "mrkdwn", text: `*${label}*${parsed.query ? `\n${escapeSlack(parsed.query)}` : ""}` } },
    { type: "actions", elements: [{ type: "button", action_id: "work_command_open", style: "primary", text: { type: "plain_text", text: t("작업 열기") }, value: JSON.stringify(metadata) }] },
  ]);
}

export async function openSlackWorkCommandModal(triggerId: string, authorization: RequestAuthorization, memberId: string, rawMetadata: string, teamId: string, slackUserId: string) {
  const metadata = parseCommandMetadata(rawMetadata, authorization, memberId, teamId, slackUserId);
  const connection = await getSlackConnection(authorization.ownerId);
  if (!connection || connection.teamId !== metadata.teamId) throw new Error("Slack 연결이 변경되었습니다.");
  const token = await slackTokenForConnection(connection);
  const t = await memberTranslator(authorization);
  const view = await commandModal(metadata, authorization, t);
  await slackApi(token, "views.open", { trigger_id: triggerId, view });
}

export async function slackWorkCommandOptions(authorization: RequestAuthorization, memberId: string, actionId: string, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (actionId === "work_parent") {
    const [projects, routines] = await Promise.all([
      listItems(authorization.ownerId, { kind: "project", query: normalized || undefined, limit: 20 }),
      listRoutines(authorization.ownerId, new Date().toISOString().slice(0, 10), false),
    ]);
    const matchingRoutines = routines.filter((routine) => !normalized || routine.title.toLocaleLowerCase().includes(normalized));
    const general = matchingRoutines.find((routine) => routine.systemKey === "general");
    const options = general ? [option(`General · ${general.title}`, `routine:${general.id}`)] : [];
    options.push(...projects.slice(0, Math.max(0, 20 - options.length)).map((item) => option(`Project · ${item.title}`, `project:${item.id}`)));
    options.push(...matchingRoutines.filter((routine) => routine.systemKey !== "general")
      .slice(0, Math.max(0, 20 - options.length)).map((routine) => option(`Routine · ${routine.title}`, `routine:${routine.id}`)));
    return { options: options.slice(0, 20) };
  }
  if (actionId === "work_initiative") return { options: await itemOptions(authorization.ownerId, "initiative", normalized) };
  if (actionId === "work_target_project") return { options: await itemOptions(authorization.ownerId, "project", normalized) };
  if (actionId === "work_target_task_open") return { options: await taskOptions(authorization.ownerId, normalized, false) };
  if (actionId === "work_target_task_done") return { options: await taskOptions(authorization.ownerId, normalized, true) };
  if (actionId === "work_target_task_any") return { options: await taskOptions(authorization.ownerId, normalized) };
  if (actionId === "work_member") {
    const team = await getTeam(authorization.ownerId, authorization.userId);
    return { options: team.members.filter((entry) => !normalized || `${entry.displayName} ${entry.email}`.toLocaleLowerCase().includes(normalized))
      .slice(0, 20).map((entry) => option(entry.displayName || entry.email, entry.id)) };
  }
  return { options: [] };
}

export async function submitSlackWorkCommand(authorization: RequestAuthorization, memberId: string, metadataRaw: string, state: SlackState, teamId: string, slackUserId: string) {
  const metadata = parseCommandMetadata(metadataRaw, authorization, memberId, teamId, slackUserId);
  const t = await memberTranslator(authorization);
  if (isWriteCommand(metadata.command) && authorization.role === "viewer") throw new Error(t("Viewer는 조회 명령만 사용할 수 있습니다."));
  const claim = await claimOperation(metadata);
  if (!claim.claimed) return resultView(claim.message || t("이미 처리된 요청입니다."), t);
  try {
    const result = await executeCommand(authorization, metadata, state, t);
    await completeOperation(metadata.requestId, result.id ?? null, result.message);
    return resultView(result.message, t);
  } catch (error) {
    await failOperation(metadata.requestId, error);
    throw error;
  }
}

async function executeCommand(authorization: RequestAuthorization, metadata: CommandMetadata, state: SlackState, t: Translator) {
  const command = metadata.command;
  if (command === "project_create") {
    const title = textValue(state, "work_title").trim();
    const initiativeId = selectedValue(state, "work_initiative");
    const initiative = await getItem(authorization.ownerId, initiativeId);
    if (!title || !initiative || initiative.kind !== "initiative" || initiative.archivedAt) throw new Error(t("제목과 활성 Initiative를 선택해 주세요."));
    const item = await createItem(authorization.ownerId, {
      title, description: textValue(state, "work_description"), kind: "project", parentId: initiative.id,
      cycleId: initiative.cycleId, status: selectedValue(state, "work_status") as ItemStatus || "in_progress",
      priority: selectedValue(state, "work_priority") as ItemPriority || "medium",
      dueDate: dateValue(state, "work_due") || null, source: "slack", createdByUserId: authorization.userId,
    });
    const dri = selectedValue(state, "work_dri") || metadata.memberId;
    const workers = selectedValues(state, "work_workers");
    await replaceItemAssignmentRole(authorization.ownerId, item.id, "project_dri", [dri]);
    if (workers.length) await replaceItemAssignmentRole(authorization.ownerId, item.id, "project_worker", workers);
    const imageNote = await attachSlackThreadImages(authorization, metadata, item.id, t);
    return { id: item.id, message: `${t("Project를 생성했습니다.")}\n${item.title}${imageNote}` };
  }
  if (command === "task_create") {
    const title = textValue(state, "work_title").trim();
    const [parentKind, parentId = ""] = selectedValue(state, "work_parent").split(":", 2);
    if (!title || !parentId || !["project", "routine"].includes(parentKind)) throw new Error(t("제목과 상위 Project 또는 Routine을 선택해 주세요."));
    const project = parentKind === "project" ? await getItem(authorization.ownerId, parentId) : null;
    const item = await createItem(authorization.ownerId, {
      title, description: textValue(state, "work_description"), kind: "task",
      parentId: parentKind === "project" ? parentId : null, routineId: parentKind === "routine" ? parentId : null,
      cycleId: project?.cycleId ?? null, priority: selectedValue(state, "work_priority") as ItemPriority || "medium",
      dueDate: dateValue(state, "work_due") || null, source: "slack", createdByUserId: authorization.userId,
    });
    await replaceItemAssignmentRole(authorization.ownerId, item.id, "task_assignee", [selectedValue(state, "work_assignee") || metadata.memberId]);
    const imageNote = await attachSlackThreadImages(authorization, metadata, parentKind === "project" ? parentId : null, t);
    return { id: item.id, message: `${t("Task를 생성했습니다.")}\n${item.title}${imageNote}` };
  }
  const targetId = selectedValue(state, "work_target", targetAction(command));
  const current = await getItem(authorization.ownerId, targetId);
  if (!current || current.archivedAt) throw new Error(t("활성 업무를 다시 선택해 주세요."));
  if (command === "project_view" || command === "task_view") {
    const assignments = await getItemAssignmentMap(authorization.ownerId, [current.id]);
    const item = serializeItem(current, {}, assignments[current.id] ?? []);
    return { id: item.id, message: detailMessage(item, t) };
  }
  if (command === "task_complete" || command === "task_reopen") {
    if (current.kind !== "task") throw new Error(t("Task를 선택해 주세요."));
    const completed = command === "task_complete";
    if ((current.status === "done") === completed) return { id: current.id, message: t(completed ? "이미 완료된 Task입니다." : "이미 미완료 상태인 Task입니다.") };
    const item = await updateItem(authorization.ownerId, current.id, { status: completed ? "done" : "todo", source: "slack" });
    return { id: item.id, message: `${t(completed ? "Task를 완료했습니다." : "Task를 다시 열었습니다.")}\n${item.title}` };
  }
  if (command === "project_status") {
    if (current.kind !== "project") throw new Error(t("Project를 선택해 주세요."));
    const status = selectedValue(state, "work_status") as ItemStatus;
    if (!status || status === "archived") throw new Error(t("변경할 상태를 선택해 주세요."));
    const item = await updateItem(authorization.ownerId, current.id, { status, source: "slack" });
    return { id: item.id, message: `${t("Project 상태를 변경했습니다.")}\n${item.title} · ${t(projectStatusLabel(status))}` };
  }
  if (command === "project_edit" || command === "task_edit") {
    const expected = command === "project_edit" ? "project" : "task";
    if (current.kind !== expected) throw new Error(t(expected === "project" ? "Project를 선택해 주세요." : "Task를 선택해 주세요."));
    const title = textValue(state, "work_title").trim();
    const priority = selectedValue(state, "work_priority") as ItemPriority;
    const dueDate = dateValue(state, "work_due");
    const patch: Parameters<typeof updateItem>[2] = { source: "slack" };
    if (title) patch.title = title;
    if (priority) patch.priority = priority;
    if (dueDate) patch.dueDate = dueDate;
    if (expected === "project") {
      const status = selectedValue(state, "work_status") as ItemStatus;
      if (status && status !== "archived") patch.status = status;
    } else {
      const parent = selectedValue(state, "work_parent");
      if (parent) {
        const [kind, id] = parent.split(":", 2);
        if (kind === "project") { patch.parentId = id; patch.routineId = null; }
        if (kind === "routine") { patch.routineId = id; patch.parentId = null; }
      }
    }
    const item = await updateItem(authorization.ownerId, current.id, patch);
    const member = selectedValue(state, expected === "project" ? "work_dri" : "work_assignee");
    if (member) await replaceItemAssignmentRole(authorization.ownerId, item.id, expected === "project" ? "project_dri" : "task_assignee", [member]);
    return { id: item.id, message: `${t(expected === "project" ? "Project를 수정했습니다." : "Task를 수정했습니다.")}\n${item.title}` };
  }
  throw new Error(t("지원하지 않는 명령입니다."));
}

async function commandModal(metadata: CommandMetadata, authorization: RequestAuthorization, t: Translator) {
  const members = (await getTeam(authorization.ownerId, authorization.userId)).members.slice(0, 100);
  const memberOptions = members.map((member) => option(member.displayName || member.email, member.id));
  const actor = memberOptions.find((entry) => entry.value === metadata.memberId);
  const blocks: Record<string, unknown>[] = [];
  const create = metadata.command === "project_create" || metadata.command === "task_create";
  const project = metadata.command.startsWith("project_");
  const draft = create ? metadata.draft : undefined;
  if (create) blocks.push(input("work_title", t("이름"), plainInput("work_title", draft?.title || metadata.query), false));
  if (metadata.command === "project_create") blocks.push(input("work_initiative", t("상위 Initiative"), externalSelect(
    "work_initiative",
    t("Initiative 검색"),
    draft?.parentKind === "initiative" && draft.parentId ? option(draft.parentLabel || "Initiative", draft.parentId) : undefined,
  ), false));
  if (metadata.command === "task_create") blocks.push(input("work_parent", t("상위 Project 또는 Routine"), externalSelect(
    "work_parent",
    t("상위 업무 검색"),
    draft?.parentId && ["project", "routine"].includes(draft.parentKind)
      ? option(draft.parentLabel || draft.parentKind, `${draft.parentKind}:${draft.parentId}`)
      : undefined,
  ), false));
  if (!create) blocks.push(input("work_target", t("대상 업무"), externalSelect(targetAction(metadata.command), metadata.query || t("업무 검색")), false));
  if (metadata.command === "project_status") blocks.push(input("work_status", t("Project 상태"), staticSelect("work_status", projectStatusOptions(t), undefined, t("선택")), false));
  if (create || metadata.command === "project_edit" || metadata.command === "task_edit") {
    if (!create) blocks.push(input("work_title", t("새 이름"), plainInput("work_title", ""), true));
    if (metadata.command === "task_edit") blocks.push(input("work_parent", t("새 상위 업무"), externalSelect("work_parent", t("변경하지 않음")), true));
    blocks.push(input("work_priority", t("우선순위"), staticSelect("work_priority", priorityOptions(t), create ? draft?.priority || "medium" : undefined, t("선택")), !create));
    blocks.push(input("work_due", t("기한"), { type: "datepicker", action_id: "work_due", placeholder: { type: "plain_text", text: t(create ? "기한 선택" : "변경하지 않음") }, ...(draft?.dueDate ? { initial_date: draft.dueDate } : {}) }, true));
    const memberAction = project ? "work_dri" : "work_assignee";
    blocks.push(input(memberAction, project ? t("책임자") : t("담당자"), staticSelect(memberAction, memberOptions, create ? draft?.responsibleMemberId || actor?.value : undefined, t("선택")), !create));
    if (metadata.command === "project_create") {
      const selected = new Set(draft?.participantMemberIds ?? []);
      const initialOptions = memberOptions.filter((entry) => selected.has(entry.value));
      blocks.push(input("work_workers", t("참여자"), { type: "multi_static_select", action_id: "work_workers", options: memberOptions, placeholder: { type: "plain_text", text: t("참여자 선택") }, max_selected_items: 20, ...(initialOptions.length ? { initial_options: initialOptions } : {}) }, true));
    }
    if (project) blocks.push(input("work_status", t("Project 상태"), staticSelect("work_status", projectStatusOptions(t), create ? "in_progress" : undefined, t("선택")), !create));
    if (create) blocks.push(input("work_description", t("설명"), { ...plainInput("work_description", draft?.description ?? ""), multiline: true }, true));
  }
  return {
    type: "modal", callback_id: "work_command_submit", private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: commandLabel(metadata.command, t).slice(0, 24) },
    submit: { type: "plain_text", text: t(submitLabel(metadata.command)) }, close: { type: "plain_text", text: t("취소") }, blocks,
  };
}

function input(blockId: string, label: string, element: Record<string, unknown>, optional: boolean) {
  return { type: "input", block_id: blockId, optional, label: { type: "plain_text", text: label }, element };
}
function plainInput(actionId: string, value: string) {
  return { type: "plain_text_input", action_id: actionId, ...(value ? { initial_value: value } : {}) };
}
function externalSelect(actionId: string, placeholder: string, initialOption?: ReturnType<typeof option>) {
  return { type: "external_select", action_id: actionId, min_query_length: 0, placeholder: { type: "plain_text", text: placeholder.slice(0, 150) }, ...(initialOption ? { initial_option: initialOption } : {}) };
}
function staticSelect(actionId: string, options: ReturnType<typeof option>[], initialValue?: string, placeholder = "Select") {
  const initial = initialValue ? options.find((entry) => entry.value === initialValue) : undefined;
  return { type: "static_select", action_id: actionId, options, placeholder: { type: "plain_text", text: placeholder }, ...(initial ? { initial_option: initial } : {}) };
}
function option(label: string, value: string) {
  return { text: { type: "plain_text", text: label.slice(0, 75) }, value };
}

async function itemOptions(ownerId: string, kind: "initiative" | "project", query: string) {
  const rows = await listItems(ownerId, { kind, query: query || undefined, limit: 20 });
  return rows.map((item) => option(`${kind === "project" ? "Project" : "Initiative"} · ${item.title}`, item.id));
}
async function taskOptions(ownerId: string, query: string, completed?: boolean) {
  const rows = await listItems(ownerId, { kind: "task", query: query || undefined, limit: 100 });
  const filtered = rows.filter((item) => completed === undefined || (item.status === "done") === completed).slice(0, 20);
  const parentIds = [...new Set(filtered.flatMap((item) => item.parentId ? [item.parentId] : []))];
  const parents = await Promise.all(parentIds.map((id) => getItem(ownerId, id)));
  const parentMap = new Map(parents.flatMap((item) => item ? [[item.id, item.title] as const] : []));
  const assignments = await getItemAssignmentMap(ownerId, filtered.map((item) => item.id));
  return filtered.map((item) => {
    const assignees = (assignments[item.id] ?? []).filter((entry) => entry.role === "task_assignee").map((entry) => entry.displayName).filter(Boolean).join(", ");
    return option(`${item.title} · ${item.parentId ? parentMap.get(item.parentId) ?? "Project" : "Routine"}${assignees ? ` · ${assignees}` : ""}${item.dueDate ? ` · ${item.dueDate}` : ""}`, item.id);
  });
}

async function assignedWorkSummary(authorization: RequestAuthorization, memberId: string, t: Translator) {
  const rows = await env.DB.prepare(`SELECT item.kind, item.title, item.status, item.due_date
    FROM item_assignments assignment JOIN items item ON item.id = assignment.item_id AND item.owner_id = assignment.owner_id
    WHERE assignment.owner_id = ? AND assignment.member_id = ? AND item.archived_at IS NULL
      AND ((item.kind = 'project' AND assignment.role IN ('project_dri','project_worker'))
        OR (item.kind = 'task' AND assignment.role = 'task_assignee' AND item.status NOT IN ('done','development_done','archived')))
    ORDER BY CASE WHEN item.due_date IS NULL THEN 1 ELSE 0 END, item.due_date, item.updated_at DESC LIMIT 20`)
    .bind(authorization.ownerId, memberId).all<Record<string, string>>();
  if (!rows.results.length) return t("현재 담당 중인 Project나 미완료 Task가 없습니다.");
  return `*${t("내 업무")}*\n${rows.results.map((row) => `• ${row.kind === "project" ? "Project" : "Task"} · ${escapeSlack(row.title)}${row.due_date ? ` · ${row.due_date}` : ""}`).join("\n")}`;
}

function commandHelp(t: Translator) {
  const row = (command: string, type: SlackWorkCommand) => `• \`${command}\` — ${commandLabel(type, t)}`;
  const slashHelp = t("사용법\n• `/okri daily` — 개인 데일리 작성\n• `/okri <문장>` — 문장을 General Task로 수집")
    .split("\n").slice(1).join("\n");
  return [
    `*${t("업무 생성 관리 봇 명령")}*`,
    "",
    "*Daily*",
    slashHelp,
    "",
    `*${t("생성")}*`,
    row("!업무생성 [만들 일] · !work create [request]", "work_create"),
    "",
    `*${t("내 업무")}*`,
    row("!내 업무 · !my work", "my_work"),
    "",
    "*Project*",
    row("!프로젝트 생성 [이름] · !project [name]", "project_create"),
    row("!프로젝트 조회 [검색어] · !project view [query]", "project_view"),
    row("!프로젝트 수정 [검색어] · !project edit [query]", "project_edit"),
    row("!프로젝트 상태 [검색어] · !project status [query]", "project_status"),
    "",
    "*Task*",
    row("!태스크 생성 [이름] · !task [name]", "task_create"),
    row("!태스크 조회 [검색어] · !task view [query]", "task_view"),
    row("!태스크 수정 [검색어] · !task edit [query]", "task_edit"),
    row("!태스크 완료 [검색어] · !task complete [query]", "task_complete"),
    row("!태스크 재열기 [검색어] · !task reopen [query]", "task_reopen"),
    "",
    "`!메뉴얼` · `!매뉴얼` · `!도움말` · `!help`",
  ].join("\n");
}

function commandLabel(command: SlackWorkCommand, t: Translator) {
  const labels: Record<SlackWorkCommand, string> = {
    help: "도움말", my_work: "내 업무", work_create: "업무 생성", project_create: "Project 생성", project_view: "Project 조회",
    project_edit: "Project 수정", project_status: "Project 상태 변경", task_create: "Task 생성",
    task_view: "Task 조회", task_edit: "Task 수정", task_complete: "Task 완료", task_reopen: "Task 다시 열기",
  };
  return t(labels[command]);
}
function submitLabel(command: SlackWorkCommand) {
  if (command.endsWith("_view")) return "조회";
  if (command.endsWith("_create")) return "생성";
  if (command === "task_complete") return "완료";
  if (command === "task_reopen") return "다시 열기";
  return "변경 저장";
}
function targetAction(command: SlackWorkCommand) {
  if (command.startsWith("project_")) return "work_target_project";
  if (command === "task_complete") return "work_target_task_open";
  if (command === "task_reopen") return "work_target_task_done";
  return "work_target_task_any";
}
function isWriteCommand(command: SlackWorkCommand) { return !["help", "my_work", "project_view", "task_view"].includes(command); }
function priorityOptions(t: Translator) { return ITEM_PRIORITIES.map((value) => option(t(({ low: "낮음", medium: "보통", high: "높음", urgent: "긴급" } as Record<string, string>)[value]), value)); }
function projectStatusOptions(t: Translator) { return ITEM_STATUSES.filter((value) => value !== "archived").map((value) => option(t(projectStatusLabel(value)), value)); }
function textValue(state: SlackState, id: string) { return state[id]?.[id]?.value ?? ""; }
function dateValue(state: SlackState, id: string) { return state[id]?.[id]?.selected_date ?? ""; }
function selectedValue(state: SlackState, id: string, actionId = id) { return state[id]?.[actionId]?.selected_option?.value ?? ""; }
function selectedValues(state: SlackState, id: string) { return (state[id]?.[id]?.selected_options ?? []).flatMap((entry) => entry.value ? [entry.value] : []); }

function parseCommandMetadata(raw: string, authorization: RequestAuthorization, memberId: string, teamId: string, slackUserId: string) {
  let metadata: CommandMetadata;
  try { metadata = JSON.parse(raw) as CommandMetadata; } catch { throw new Error("명령 정보가 만료되었습니다. 다시 입력해 주세요."); }
  if (!SLACK_WORK_COMMANDS.includes(metadata.command)
    || metadata.ownerId !== authorization.ownerId
    || metadata.memberId !== memberId
    || metadata.teamId !== teamId
    || metadata.slackUserId !== slackUserId) throw new Error("다른 사용자 또는 워크스페이스의 명령은 실행할 수 없습니다.");
  if (!metadata.createdAt || Date.now() - metadata.createdAt > 15 * 60_000) throw new Error("명령 정보가 만료되었습니다. 다시 입력해 주세요.");
  if (metadata.sourceThread && (!/^[A-Z0-9]{1,32}$/i.test(metadata.sourceThread.channel)
    || !/^\d{1,16}\.\d{1,16}$/.test(metadata.sourceThread.ts))) throw new Error("Slack 스레드 정보가 올바르지 않습니다.");
  return metadata;
}
async function claimOperation(metadata: CommandMetadata) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO slack_work_command_operations
    (request_id, owner_id, team_id, slack_user_id, command, status, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'processing', '{}', ?, ?)`).bind(metadata.requestId, metadata.ownerId, metadata.teamId, metadata.slackUserId, metadata.command, now, now).run();
  if (result.meta.changes) return { claimed: true, message: "" };
  const existing = await env.DB.prepare("SELECT status, result_json FROM slack_work_command_operations WHERE request_id = ? AND owner_id = ? AND team_id = ? AND slack_user_id = ?")
    .bind(metadata.requestId, metadata.ownerId, metadata.teamId, metadata.slackUserId).first<{ status: string; result_json: string }>();
  if (!existing) throw new Error("명령을 다시 입력해 주세요.");
  let message = "이미 처리 중인 요청입니다.";
  try { message = (JSON.parse(existing.result_json) as { message?: string }).message || message; } catch { /* keep safe message */ }
  return { claimed: false, message };
}
async function completeOperation(requestId: string, targetId: string | null, message: string) {
  await env.DB.prepare("UPDATE slack_work_command_operations SET target_id = ?, status = 'succeeded', result_json = ?, updated_at = ? WHERE request_id = ? AND status = 'processing'")
    .bind(targetId, JSON.stringify({ message }), new Date().toISOString(), requestId).run();
}
async function failOperation(requestId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
  await env.DB.prepare("UPDATE slack_work_command_operations SET status = 'failed', result_json = ?, updated_at = ? WHERE request_id = ? AND status = 'processing'")
    .bind(JSON.stringify({ message: message.slice(0, 300) }), new Date().toISOString(), requestId).run();
}

function resultView(message: string, t: Translator) {
  return { type: "modal", title: { type: "plain_text", text: "OKRI" }, close: { type: "plain_text", text: t("닫기") }, blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }] };
}
function detailMessage(item: Record<string, unknown>, t: Translator) {
  const assignments = Array.isArray(item.assignments) ? item.assignments as Array<{ displayName?: string; role?: string }> : [];
  const people = assignments.map((entry) => entry.displayName).filter(Boolean).join(", ") || "-";
  return `*${escapeSlack(String(item.title ?? ""))}*\n${t("종류")}: ${item.kind === "project" ? "Project" : "Task"}\n${t("상태")}: ${t(projectStatusLabel(String(item.status ?? "-")))}\n${t("우선순위")}: ${t(priorityLabel(String(item.priority ?? "-")))}\n${t("담당")}: ${escapeSlack(people)}\n${t("마감일")}: ${String(item.dueDate ?? "-")}`;
}
function projectStatusLabel(status: string) { return ({ backlog: "백로그", todo: "할 일", policy_discussion: "정책 논의 중", in_progress: "진행 중", developing: "개발 중", development_done: "개발 완료", done: "완료", blocked: "막힘" } as Record<string, string>)[status] ?? status; }
function priorityLabel(priority: string) { return ({ low: "낮음", medium: "보통", high: "높음", urgent: "긴급" } as Record<string, string>)[priority] ?? priority; }
async function memberTranslator(authorization: RequestAuthorization) {
  const language = (await readLanguagePreferences(env.DB, authorization.userId)).resolvedLanguage;
  return serverTranslator(language);
}
async function postPrivate(token: string, event: WorkMessageEvent, text: string, blocks?: unknown[]) {
  const method = event.channelType === "im" ? "chat.postMessage" : "chat.postEphemeral";
  await slackApi(token, method, {
    channel: event.channel, text, blocks,
    ...(method === "chat.postEphemeral" ? { user: event.user } : {}),
    ...(event.threadTs || event.ts ? { thread_ts: event.threadTs || event.ts } : {}),
  });
}
function escapeSlack(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function commandMetadata(connection: SlackConnection, event: WorkMessageEvent, memberId: string, draft: SlackWorkDraft): CommandMetadata {
  return {
    command: draft.kind === "project" ? "project_create" : "task_create",
    query: draft.title,
    requestId: crypto.randomUUID(),
    ownerId: connection.ownerId,
    teamId: connection.teamId,
    slackUserId: event.user,
    memberId,
    createdAt: Date.now(),
    draft,
    ...(draft.imageCount && sourceThread(event) ? { sourceThread: sourceThread(event)! } : {}),
  };
}

function alternateDraftMetadata(metadata: CommandMetadata): CommandMetadata {
  if (!metadata.draft) return metadata;
  const project = metadata.draft.kind !== "project";
  return {
    ...metadata,
    command: project ? "project_create" : "task_create",
    requestId: crypto.randomUUID(),
    draft: {
      ...metadata.draft,
      kind: project ? "project" : "task",
      parentKind: project ? "initiative" : "routine",
      parentId: "",
      parentLabel: "",
      parentReason: "",
      participantMemberIds: project ? metadata.draft.participantMemberIds : [],
    },
  };
}

function serializeMetadata(metadata: CommandMetadata) {
  let value = JSON.stringify(metadata);
  if (value.length <= 1900 || !metadata.draft) return value;
  const draft = {
    ...metadata.draft,
    description: metadata.draft.description.slice(0, 240),
    parentLabel: metadata.draft.parentLabel.slice(0, 120),
    parentReason: metadata.draft.parentReason.slice(0, 80),
    typeReason: metadata.draft.typeReason.slice(0, 80),
    participantMemberIds: metadata.draft.participantMemberIds.slice(0, 5),
  };
  value = JSON.stringify({ ...metadata, draft });
  if (value.length > 1900) value = JSON.stringify({ ...metadata, draft: { ...draft, description: "", parentReason: "", typeReason: "", participantMemberIds: [] } });
  return value;
}

function reviewDraftText(draft: SlackWorkDraft, t: Translator) {
  const parent = draft.parentId
    ? `${escapeSlack(draft.parentLabel)}${draft.parentReason ? `\n_${escapeSlack(draft.parentReason)}_` : ""}`
    : t(draft.kind === "project" ? "연결할 Initiative를 선택해 주세요." : "General Routine에 연결합니다.");
  return [
    `*${t(draft.kind === "project" ? "Project 생성 초안" : "Task 생성 초안")}*`,
    `*${escapeSlack(draft.title)}*`,
    draft.description ? escapeSlack(draft.description) : "",
    `${t("구분")}: ${draft.kind === "project" ? "Project" : "Task"}${draft.typeReason ? ` · ${escapeSlack(draft.typeReason)}` : ""}`,
    `${t("연결")}: ${parent}`,
    `${t(draft.kind === "project" ? "책임자" : "담당자")}: ${escapeSlack(draft.responsibleLabel)}`,
    `${t("기한")}: ${draft.dueDate || "-"}`,
    `${t("우선순위")}: ${t(priorityLabel(draft.priority))}`,
    draft.imageCount ? t("이미지 {count}개 · 생성 후 Project에 저장", { count: `${draft.imageCount}${draft.imagesTruncated ? "+" : ""}` }) : "",
    draft.kind === "task" && draft.imageCount ? t("이미지는 Task가 연결된 Project에 저장됩니다. Routine을 선택하면 저장되지 않습니다.") : "",
    draft.threadTruncated ? t("긴 스레드의 최근 내용 중심으로 초안을 만들었습니다.") : "",
    `_${t("아직 저장되지 않았습니다. 검토 후 생성해 주세요.")}_`,
  ].filter(Boolean).join("\n");
}

async function attachSlackThreadImages(
  authorization: RequestAuthorization,
  metadata: CommandMetadata,
  projectId: string | null,
  t: Translator,
) {
  if (!metadata.sourceThread) return "";
  try {
    const connection = await getSlackConnection(authorization.ownerId);
    if (!connection || connection.teamId !== metadata.teamId) {
      return `\n${t("Slack 연결이 변경되어 이미지는 저장하지 못했습니다.")}`;
    }
    const token = await slackTokenForConnection(connection);
    const thread = await readSlackThread(token, {
      channel: metadata.sourceThread.channel,
      channelType: "channel",
      user: metadata.slackUserId,
      text: "",
      threadTs: metadata.sourceThread.ts,
    });
    if (!thread.imageFiles.length) return "";
    if (!projectId) return `\n${t("이미지는 Project에만 저장됩니다. 이번 이미지는 저장하지 않았습니다.")}`;
    const result = await saveSlackProjectImages({
      ownerId: authorization.ownerId,
      projectId,
      createdByUserId: authorization.userId,
      teamId: metadata.teamId,
      token,
      files: thread.imageFiles,
      imagesTruncated: thread.imagesTruncated,
    });
    const stored = result.saved + result.reused;
    const notStored = result.skipped + result.failed;
    return [
      stored ? `\n${t("이미지 {count}개를 Project에 저장했습니다.", { count: stored })}` : "",
      notStored ? `\n${t("형식·크기 또는 Slack 권한 때문에 이미지 {count}개는 저장하지 못했습니다.", { count: notStored })}` : "",
    ].join("");
  } catch (error) {
    console.error("Slack thread image attachment failed", error);
    return `\n${t("Project 생성은 완료됐지만 이미지를 읽지 못했습니다. Slack 연결 권한을 갱신한 뒤 다시 시도해 주세요.")}`;
  }
}

function sourceThread(event: WorkMessageEvent) {
  const ts = event.threadTs || event.ts;
  return ts ? { channel: event.channel, ts } : null;
}

function isCreateCommand(command: SlackWorkCommand) {
  return command === "project_create" || command === "task_create";
}
