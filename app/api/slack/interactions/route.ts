import { env, waitUntil } from "cloudflare:workers";
import { createExplicitDailyTask, currentDailyMember, normalizeDailySkipReason, saveDailyDraft, submitDailyDraft } from "@/lib/daily-bot";
import { getSlackConnectionByTeam } from "@/lib/pace-data";
import { createSlackMemberLinkUrl, dailyMemberBySlack, externalTaskOptions, openDailyModal, publishDailySubmission, reconcileDailyReminders, updateDailyChecklistView } from "@/lib/slack-daily";
import { handleDailyChecklist, retryDailyChecklist } from "@/lib/slack-daily-checklist";
import { slackConfigured, verifySlackRequest, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { memberMessageLanguage, workspaceMessageLanguage } from "@/lib/language-preferences";
import { serverTranslator, type Translator } from "@/lib/server-language";
import { openSlackWorkCommandModal, slackWorkCommandOptions, submitSlackWorkCommand } from "@/lib/slack-work-command";

type SlackInteraction = {
  type?: string;
  trigger_id?: string;
  team?: { id?: string };
  user?: { id?: string };
  action_id?: string;
  value?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: {
    id?: string;
    hash?: string;
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, Record<string, unknown>>> };
  };
};

export async function POST(request: Request) {
  const runtime = env as SlackRuntimeEnv;
  if (!slackConfigured(runtime)) return new Response("Slack is not configured", { status: 503 });
  const rawBody = await request.text();
  if (!await verifySlackRequest(request, rawBody, runtime.SLACK_SIGNING_SECRET!)) return new Response("invalid Slack signature", { status: 401 });
  const encoded = new URLSearchParams(rawBody).get("payload") ?? "{}";
  let payload: SlackInteraction;
  try { payload = JSON.parse(encoded) as SlackInteraction; } catch { return new Response("invalid payload", { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Response("invalid payload", { status: 400 });
  if (payload?.type === "block_actions" && payload.actions?.length === 1
    && ["okri_summon_link", "okri_summon_open", "okrptr_summon_link", "okrptr_summon_open"].includes(payload.actions[0].action_id ?? "")) {
    return new Response(null, { status: 200 });
  }
  const teamId = payload.team?.id ?? "";
  const slackUserId = payload.user?.id ?? "";
  const connection = teamId ? await getSlackConnectionByTeam(teamId) : null;
  if (!connection) return Response.json({ error: "Slack workspace is not connected" }, { status: 403 });
  const workspaceT = await serverTranslator(await workspaceMessageLanguage(env.DB, connection.ownerId));
  const linked = await dailyMemberBySlack(teamId, slackUserId);
  if (!linked) {
    const link = await createSlackMemberLinkUrl(connection.ownerId, teamId, slackUserId, request);
    return Response.json({ response_type: "ephemeral", text: workspaceT("OKRI 계정을 먼저 연결해 주세요: {link}", { link }) });
  }
  const t = await serverTranslator(await memberMessageLanguage(env.DB, linked.authorization.ownerId, linked.memberId));

  if (payload.type === "block_suggestion") {
    if (payload.action_id?.startsWith("work_")) {
      return Response.json(await slackWorkCommandOptions(linked.authorization, linked.memberId, payload.action_id, payload.value ?? ""));
    }
    const mode = payload.action_id === "selected_yesterday_work" ? "yesterday"
      : payload.action_id === "selected_today_work" ? "today"
        : payload.action_id === "selected_more_work" ? true : false;
    return Response.json({ options: await externalTaskOptions(linked.authorization, payload.value ?? "", mode, parseMetadata(payload.view?.private_metadata).date) });
  }
  if (payload.type === "block_actions") {
    const action = payload.actions?.find((entry) => entry.action_id === "work_command_open");
    if (action?.value && payload.trigger_id) {
      await openSlackWorkCommandModal(payload.trigger_id, linked.authorization, linked.memberId, action.value, teamId, slackUserId);
      return new Response(null, { status: 200 });
    }
  }
  if (payload.type === "block_actions" && payload.actions?.some((action) => action.action_id === "daily_open")) {
    if (payload.trigger_id) await openDailyModal(payload.trigger_id, linked.authorization);
    return new Response(null, { status: 200 });
  }
  if (payload.type === "view_submission" && payload.view?.callback_id === "daily_submit") {
    return submitFromModal(payload, linked.authorization, t);
  }
  const previousPage = payload.type === "block_actions" && payload.actions?.some((action) => action.action_id === "daily_checklist_previous");
  if (payload.view?.callback_id === "daily_checklist_submit" && (payload.type === "view_submission" || previousPage)) {
    if (linked.authorization.role === "viewer") return Response.json({ response_action: "errors", errors: { no_planned: t("읽기 전용 멤버는 데일리를 제출할 수 없습니다.") } });
    const { id: viewId, hash, private_metadata: metadata = "", state } = payload.view;
    if (!viewId) return new Response(null, { status: 400 });
    const statusView = (text: string) => ({ type: "modal", title: { type: "plain_text", text: t("데일리") },
      close: { type: "plain_text", text: t("닫기") }, blocks: [{ type: "section", text: { type: "plain_text", text } }] });
    // Acknowledge before D1 work and downstream automation can exceed Slack's deadline.
    waitUntil((async () => {
      try {
        const result = await handleDailyChecklist(linked.authorization, metadata, state?.values ?? {}, Boolean(previousPage), t);
        waitUntil(import("@/lib/slack-task-changes").then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB)));
        await updateDailyChecklistView(linked.authorization.ownerId, viewId, previousPage ? hash : undefined, result.view ?? statusView(t("제출 완료")));
        if (result.submission) await Promise.allSettled([publishDailySubmission(linked.authorization.ownerId, result.submission.id), reconcileDailyReminders(linked.authorization.ownerId)]);
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "";
        const translated = t(rawMessage);
        const message = translated !== rawMessage || /^[가-힣\s·]+[가-힣\s·‘’]*[.?!]?$/.test(rawMessage) ? translated : t("데일리를 저장하지 못했습니다.");
        const retry = await retryDailyChecklist(linked.authorization, metadata, state?.values ?? {}, message, t).catch(() => null);
        await updateDailyChecklistView(linked.authorization.ownerId, viewId, undefined, retry ?? statusView(t("데일리를 다시 열어 주세요."))).catch(() => undefined);
      }
    })());
    return previousPage ? new Response(null, { status: 200 }) : Response.json({ response_action: "update", view: statusView(t("처리 중")) });
  }
  if (payload.type === "view_submission" && payload.view?.callback_id === "work_command_submit") {
    try {
      const view = await submitSlackWorkCommand(linked.authorization, linked.memberId, payload.view.private_metadata ?? "", payload.view.state?.values ?? {}, teamId, slackUserId);
      return Response.json({ response_action: "update", view });
    } catch (error) {
      let command = "";
      try { command = (JSON.parse(payload.view.private_metadata ?? "{}") as { command?: string }).command ?? ""; } catch { /* use target field */ }
      const errorBlock = command.endsWith("_create") ? "work_title" : "work_target";
      return Response.json({ response_action: "errors", errors: { [errorBlock]: t(error instanceof Error ? error.message : "요청을 처리하지 못했습니다.") } });
    }
  }
  return new Response(null, { status: 200 });
}

async function submitFromModal(payload: SlackInteraction, authorization: Awaited<ReturnType<typeof dailyMemberBySlack>> extends infer T ? T extends { authorization: infer A } ? A : never : never, t: Translator) {
  const metadata = parseMetadata(payload.view?.private_metadata);
  const state = payload.view?.state?.values ?? {};
  const selectedTaskIds = selectedOptions(state, "daily_tasks", "selected_tasks");
  const selectedWorkIds = metadata.workVersion === 2
    ? selectedOptions(state, "today_work", "selected_today_work")
    : metadata.workVersion === 1 ? [...new Set(Object.keys(state).filter((id) => id.startsWith("daily_work_"))
      .flatMap((id) => selectedOptions(state, id, id === "daily_work_more" ? "selected_more_work" : "selected_work")))] : undefined;
  const selectedYesterdayWorkIds = metadata.workVersion === 2
    ? selectedOptions(state, "yesterday_work", "selected_yesterday_work") : undefined;
  const workErrorBlock = Object.keys(state).find((id) => id.startsWith("daily_work_")) || "no_planned";
  if (authorization.role === "viewer") return Response.json({ response_action: "errors", errors: { [workErrorBlock]: t("읽기 전용 멤버는 데일리를 제출할 수 없습니다.") } });
  const todayNote = stringValue(state, "today_note", "value");
  const yesterdayNote = stringValue(state, "yesterday_note", "value");
  const blockersNote = stringValue(state, "blockers_note", "value");
  const noPlannedTasks = selectedOptions(state, "no_planned", "value").includes("yes");
  const rawSkipReason = selectedValue(state, "skip_reason", "value").replace(/^none$/, "");
  let skipReason;
  try {
    skipReason = normalizeDailySkipReason(rawSkipReason);
  } catch {
    return Response.json({ response_action: "errors", errors: { skip_reason: t("올바른 데일리 스킵 사유를 선택해 주세요.") } });
  }
  const skipNote = stringValue(state, "skip_note", "value").trim();
  const newTaskTitle = stringValue(state, "new_task_title", "value").trim();
  const parentValue = selectedValue(state, "new_task_parent", "value");
  if (newTaskTitle && !parentValue) {
    return Response.json({ response_action: "errors", errors: { new_task_parent: t("새 Task의 상위 항목을 선택해 주세요.") } });
  }
  if (skipReason && newTaskTitle) {
    return Response.json({ response_action: "errors", errors: { new_task_title: t("스킵하는 날에는 새 Task를 함께 만들 수 없습니다.") } });
  }
  if (skipReason === "other" && !skipNote) {
    return Response.json({ response_action: "errors", errors: { skip_note: t("기타 스킵 사유를 입력해 주세요.") } });
  }
  if ((selectedWorkIds?.length ?? selectedTaskIds.length) > 50) {
    return Response.json({ response_action: "errors", errors: { [workErrorBlock]: t("오늘 할 업무는 최대 50개까지 선택할 수 있습니다.") } });
  }
  if ((selectedYesterdayWorkIds?.length ?? 0) > 50) {
    return Response.json({ response_action: "errors", errors: { yesterday_work: t("완료한 일은 최대 50개까지 선택할 수 있습니다.") } });
  }
  if (selectedYesterdayWorkIds?.some((key) => selectedWorkIds?.includes(key))) {
    return Response.json({ response_action: "errors", errors: {
      yesterday_work: t("같은 업무를 완료한 일과 오늘 할 일에 동시에 선택할 수 없습니다."),
      today_work: t("같은 업무가 완료한 일에도 선택되어 있습니다."),
    } });
  }
  if (!skipReason && !noPlannedTasks && (selectedWorkIds?.length ?? selectedTaskIds.length) === 0 && !newTaskTitle && !todayNote.trim()) {
    return Response.json({ response_action: "errors", errors: { [metadata.workVersion === 2 ? "today_work" : metadata.workVersion === 1 ? workErrorBlock : "daily_tasks"]: t("오늘 할 업무 또는 ‘오늘 예정 없음’을 선택해 주세요.") } });
  }
  try {
    const member = await currentDailyMember(authorization);
    if ((metadata.ownerId && metadata.ownerId !== authorization.ownerId) || (metadata.memberId && metadata.memberId !== member.id)) {
      throw new Error("daily_recipient_mismatch");
    }
    const draft = await env.DB.prepare("SELECT yesterday_note FROM daily_scrums WHERE owner_id = ? AND member_id = ? AND scrum_date = ?")
      .bind(authorization.ownerId, member.id, metadata.date).first<{ yesterday_note: string }>();
    await saveDailyDraft(authorization, {
      date: metadata.date,
      yesterdayNote: metadata.workVersion === 2 ? yesterdayNote : draft?.yesterday_note || "",
      todayNote,
      blockersNote,
      selectedTaskIds,
      selectedWorkIds,
      selectedYesterdayWorkIds,
      noPlannedTasks,
      skipReason,
      skipNote,
      source: "slack",
    }, false);
    if (newTaskTitle) {
      const [parentKind, parentId = ""] = parentValue.split(":", 2);
      await createExplicitDailyTask(authorization, {
        date: metadata.date,
        title: newTaskTitle,
        parentKind: parentKind === "project" || parentKind === "routine" ? parentKind : "general",
        parentId: parentId || null,
        requestId: metadata.requestId,
      });
    }
    const submission = await submitDailyDraft(authorization, metadata.date, "slack", metadata.requestId);
    waitUntil(Promise.all([publishDailySubmission(authorization.ownerId, submission.id), reconcileDailyReminders(authorization.ownerId)]).then(() => undefined));
    return new Response(null, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "데일리를 저장하지 못했습니다.";
    return Response.json({ response_action: "errors", errors: { [metadata.workVersion === 1 ? workErrorBlock : "today_work"]: t(message) } });
  }
}

function action(state: Record<string, Record<string, Record<string, unknown>>>, blockId: string, actionId: string) {
  return state[blockId]?.[actionId] ?? {};
}

function stringValue(state: Record<string, Record<string, Record<string, unknown>>>, blockId: string, actionId: string) {
  const value = action(state, blockId, actionId).value;
  return typeof value === "string" ? value : "";
}

function selectedValue(state: Record<string, Record<string, Record<string, unknown>>>, blockId: string, actionId: string) {
  const selected = action(state, blockId, actionId).selected_option as { value?: unknown } | undefined;
  return typeof selected?.value === "string" ? selected.value : "";
}

function selectedOptions(state: Record<string, Record<string, Record<string, unknown>>>, blockId: string, actionId: string) {
  const selected = action(state, blockId, actionId).selected_options;
  if (!Array.isArray(selected)) return [];
  return selected.flatMap((option) => option && typeof option === "object" && typeof (option as { value?: unknown }).value === "string" ? [(option as { value: string }).value] : []);
}

function parseMetadata(value: string | undefined) {
  try {
    const parsed = JSON.parse(value ?? "{}") as { date?: string; requestId?: string; workVersion?: number; ownerId?: string; memberId?: string };
    return { ...parsed, date: parsed.date ?? new Date().toISOString().slice(0, 10), requestId: parsed.requestId ?? crypto.randomUUID() };
  } catch {
    return { date: new Date().toISOString().slice(0, 10), requestId: crypto.randomUUID() };
  }
}
