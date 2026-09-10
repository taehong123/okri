export const SLACK_AUTOMATION_TRIGGERS = ["task_created", "task_status_changed", "task_changed"] as const;

export type SlackAutomationTrigger = (typeof SLACK_AUTOMATION_TRIGGERS)[number];

export type SlackAutomationContext = {
  title: string;
  status: string;
  fromStatus?: string | null;
  priority: string;
  kind: string;
  workspace: string;
  changes?: string;
  parent?: string;
};

const statusLabels: Record<string, string> = {
  backlog: "백로그",
  todo: "할 일",
  policy_discussion: "정책 논의",
  in_progress: "진행 중",
  developing: "개발 중",
  development_done: "개발 완료",
  done: "완료",
  blocked: "막힘",
  archived: "보관됨",
};

const priorityLabels: Record<string, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  urgent: "긴급",
};

const kindLabels: Record<string, string> = {
  objective: "목표",
  key_result: "핵심 결과",
  initiative: "이니셔티브",
  project: "프로젝트",
  task: "업무",
};

export function isSlackAutomationTrigger(value: string): value is SlackAutomationTrigger {
  return (SLACK_AUTOMATION_TRIGGERS as readonly string[]).includes(value);
}

export function isSupportedTaskAutomation(triggerType: string, triggerStatus: string) {
  return triggerType === "task_created" || triggerType === "task_changed"
    || (triggerType === "task_status_changed" && ["todo", "done"].includes(triggerStatus));
}

export function defaultSlackAutomationTemplate(triggerType: SlackAutomationTrigger) {
  if (triggerType === "task_changed") return "*{{title}}*\n{{changes}}\n{{parent}} · {{workspace}}";
  if (triggerType === "task_status_changed") {
    return "*{{title}}* 상태가 `{{from_status}}` → `{{status}}`로 바뀌었습니다.\n우선순위: {{priority}} · {{workspace}}";
  }
  return "새 업무가 등록되었습니다.\n*{{title}}*\n상태: {{status}} · 우선순위: {{priority}} · {{workspace}}";
}

export type AutomationMessageKind = "custom" | "default" | "blocked";
export function systemAutomationTemplate(kind: Exclude<AutomationMessageKind, "custom">, trigger: SlackAutomationTrigger, t: Translator = (key) => key) {
  if (kind === "blocked") return t("업무가 막힘 상태로 변경되었습니다.\n*{{title}}*\n우선순위: {{priority}} · {{workspace}}");
  return t(defaultSlackAutomationTemplate(trigger));
}

export function renderSlackAutomationMessage(template: string, context: SlackAutomationContext, t: Translator = (key) => key) {
  const variables: Record<string, string> = {
    title: context.title,
    status: t(statusLabels[context.status] ?? context.status),
    from_status: context.fromStatus ? t(statusLabels[context.fromStatus] ?? context.fromStatus) : "-",
    priority: t(priorityLabels[context.priority] ?? context.priority),
    kind: t(kindLabels[context.kind] ?? context.kind),
    workspace: context.workspace,
    changes: context.changes ?? t("Task 변경"),
    parent: context.parent ?? "-",
  };

  const message = template.replace(/{{\s*(title|status|from_status|priority|kind|workspace|changes|parent)\s*}}/g, (_, key: string) => escapeSlackText(variables[key] ?? ""));
  return `*${t("Task 변동 알림 봇")}*\n${message}`;
}

export function slackAutomationMatches(input: {
  triggerType: string;
  triggerStatus: string;
}, event: {
  triggerType: SlackAutomationTrigger;
  status: string;
}) {
  if (input.triggerType !== event.triggerType) return false;
  return event.triggerType !== "task_status_changed" || !input.triggerStatus || input.triggerStatus === event.status;
}

export function normalizeSlackChannelId(value: string) {
  const channelId = value.trim();
  if (!/^[A-Z][A-Z0-9]{5,31}$/.test(channelId)) {
    throw new Error("Slack 채널 ID를 입력해 주세요. 예: C0123456789");
  }
  return channelId;
}

export class SlackMessageError extends Error {
  constructor(message: string, public outcome: "rejected" | "uncertain", public retryAfterSeconds = 0, public code?: string) {
    super(message);
  }
}

export async function postSlackMessage(token: string, channel: string, text: string, options: { blocks?: unknown[]; clientMsgId?: string; messageTs?: string } = {}) {
  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${options.messageTs ? "chat.update" : "chat.postMessage"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text: text.slice(0, 3900), blocks: options.blocks, client_msg_id: options.clientMsgId, ts: options.messageTs, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SlackMessageError("Slack 전송 결과를 확인하지 못했습니다. 중복 방지를 위해 자동 재발송하지 않습니다.", "uncertain");
  }
  if (response.status === 429) {
    const delay = Number(response.headers.get("Retry-After"));
    throw new SlackMessageError("Slack 요청 한도에 도달했습니다. 잠시 후 자동 재시도합니다.", "rejected", Number.isFinite(delay) && delay > 0 ? delay : 60);
  }
  let result: { ok?: boolean; error?: string; ts?: string };
  try { result = await response.json() as typeof result; }
  catch { throw new SlackMessageError("Slack 응답을 확인하지 못했습니다. 중복 방지를 위해 자동 재발송하지 않습니다.", "uncertain"); }
  if (response.status >= 500 || ["internal_error", "fatal_error", "request_timeout"].includes(result.error ?? "")) {
    throw new SlackMessageError(`${slackErrorMessage(result.error)} · 처리 결과 확인 필요`, "uncertain");
  }
  if (!response.ok || !result.ok) throw new SlackMessageError(slackErrorMessage(result.error), "rejected", result.error === "ratelimited" ? 60 : 0, result.error);
  if (!result.ts) throw new SlackMessageError("Slack 전송 영수증이 없습니다. 처리 결과 확인이 필요합니다.", "uncertain");
  return { timestamp: result.ts };
}

export async function postSlackEphemeral(token: string, channel: string, user: string, threadTs: string,
  text: string, blocks?: unknown[]) {
  let response: Response;
  try {
    response = await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, user, thread_ts: threadTs, text: text.slice(0, 3900), blocks }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SlackMessageError("개인 완료 처리를 표시하지 못했습니다.", "uncertain");
  }
  if (response.status === 429) {
    const delay = Number(response.headers.get("Retry-After"));
    throw new SlackMessageError("Slack 요청 한도에 도달했습니다.", "rejected", Number.isFinite(delay) && delay > 0 ? delay : 60);
  }
  let result: { ok?: boolean; error?: string; message_ts?: string; ts?: string };
  try { result = await response.json() as typeof result; }
  catch { throw new SlackMessageError("개인 완료 처리 응답을 확인하지 못했습니다.", "uncertain"); }
  if (!response.ok || !result.ok) throw new SlackMessageError(slackErrorMessage(result.error), "rejected", 0, result.error);
  return { timestamp: result.message_ts || result.ts || "" };
}

function escapeSlackText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackErrorMessage(code?: string) {
  if (code === "channel_not_found") return "채널을 찾을 수 없습니다. 채널 ID와 봇 초대 여부를 확인해 주세요.";
  if (code === "not_in_channel") return "OKRI 봇을 이 채널에 먼저 초대해 주세요.";
  if (code === "invalid_auth" || code === "token_revoked") return "Slack 연결이 만료되었습니다. 다시 연결해 주세요.";
  if (code === "missing_scope") return "Slack 앱에 메시지 전송 권한이 없습니다. 앱을 다시 연결해 주세요.";
  return `Slack 전송에 실패했습니다${code ? ` (${code})` : ""}`;
}
import type { Translator } from "./server-language";
