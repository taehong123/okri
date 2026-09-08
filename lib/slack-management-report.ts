import type { ManagementBotGroup } from "./workspace-management-bot";
import type { Translator } from "./server-language";

export const managementSignalOrder = ["overdue", "due_today", "missing_owner", "missing_due_date", "completed_yesterday"] as const;
const labels = { overdue: "기한 초과", due_today: "오늘 마감", missing_owner: "책임자·담당자 없음", missing_due_date: "기한 없음", completed_yesterday: "어제 완료" };
export type ManagementAssignee = { name: string; slackId: string | null };
export const slackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export type ManagementReportMessage = { blocks: Record<string, unknown>[]; itemIds: string[] };

// An item needs one interactive section block, so keeping 20 items per
// message leaves room for shared and signal headings below Slack's 50-block
// message limit.
const ITEMS_PER_MESSAGE = 20;

// Keep one short, actionable row per work item. Counts remain per signal (not a
// misleading sum of overlapping groups); no body is cut halfway through a row.
export function managementReportMessages(input: {
  workspace: string; date: string; groups: ManagementBotGroup[]; appUrl: string; test?: boolean;
  assignees: Record<string, ManagementAssignee[]>; mentions?: boolean;
}, t: Translator): ManagementReportMessage[] {
  const summaryUrl = `${input.appUrl}/?settings=workspace&tab=summary`;
  const groups = managementSignalOrder.flatMap((signal) => input.groups.filter((group) => group.signal === signal && group.count));
  const seen = new Set<string>();
  const rows = groups.flatMap((group) => group.items
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map((item) => ({ group, item })));
  const pageCount = Math.max(1, Math.ceil(rows.length / ITEMS_PER_MESSAGE));
  const mentioned = new Set<string>();
  const messages: ManagementReportMessage[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const pageRows = rows.slice(pageIndex * ITEMS_PER_MESSAGE, (pageIndex + 1) * ITEMS_PER_MESSAGE);
    const pageLabel = pageCount > 1 ? ` (${pageIndex + 1}/${pageCount})` : "";
    const blocks: Record<string, unknown>[] = [
      { type: "header", text: { type: "plain_text", text: `${input.test ? `${t("테스트")} · ` : ""}${t("관리 봇")}${pageLabel}` } },
      { type: "context", elements: [{ type: "plain_text", text: `${input.workspace.slice(0, 300)} · ${input.date}` }] },
    ];
    if (!groups.length) blocks.push({ type: "section", text: { type: "plain_text", text: t("현재 선택한 관리 항목은 모두 정리되어 있습니다. ✅") } });
    else blocks.push({ type: "section", text: { type: "mrkdwn", text: groups.map((g) => `${t(labels[g.signal])} *${g.count}*`).join("  ·  ") } });
    let currentSignal: ManagementBotGroup["signal"] | null = null;
    for (const { group, item } of pageRows) {
      if (group.signal !== currentSignal) {
        currentSignal = group.signal;
        blocks.push({ type: "divider" });
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${t(labels[group.signal])}*` } });
      }
      const names = (input.assignees[item.id] ?? []).map((person) => {
        if (item.isOverdue && input.mentions !== false && person.slackId && /^[UW][A-Z0-9]+$/.test(person.slackId) && !mentioned.has(person.slackId)) {
          mentioned.add(person.slackId); return `<@${person.slackId}>`;
        }
        return slackText(person.name.slice(0, 100));
      }).join(", ") || t("담당자 지정 필요");
      const days = item.isOverdue && item.dueDate ? Math.max(1, Math.round((Date.parse(`${input.date}T00:00:00Z`) - Date.parse(`${item.dueDate}T00:00:00Z`)) / 86400000)) : 0;
      const due = days ? `*${t("{count}일 지연", { count: days })}* · ${item.dueDate}` : item.dueDate || t("기한 없음");
      const url = `${input.appUrl}/?view=${item.kind === "project" ? "work" : "inbox"}&${item.kind}=${encodeURIComponent(item.id)}`;
      const parent = item.parentProject ? `\n${t("Project")} · ${slackText(item.parentProject.title.slice(0, 180))}` : "";
      blocks.push({ type: "section", block_id: `management_item_${item.id}`, text: { type: "mrkdwn", text:
        `<${url}|${slackText(item.title.slice(0, 300))}>\n${t(item.kind === "project" ? "Project" : "Task")} · ${names} · ${due}${parent}` },
        accessory: { type: "button", action_id: "management_edit", text: { type: "plain_text", text: t("정보 입력·수정") }, value: item.id } });
    }
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: t("전체 보기") }, url: summaryUrl }] });
    messages.push({ blocks, itemIds: pageRows.map(({ item }) => item.id) });
  }
  return messages;
}

// Compatibility helper for callers that still expect one Block Kit array.
// Delivery code uses managementReportMessages so continuation pages are sent.
export function managementReportBlocks(input: Parameters<typeof managementReportMessages>[0], t: Translator) {
  return managementReportMessages(input, t)[0].blocks;
}
