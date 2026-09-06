import type { ManagementBotGroup } from "./workspace-management-bot";
import type { Translator } from "./server-language";

export const managementSignalOrder = ["overdue", "due_today", "missing_owner", "missing_due_date", "completed_yesterday"] as const;
const labels = { overdue: "기한 초과", due_today: "오늘 마감", missing_owner: "책임자·담당자 없음", missing_due_date: "기한 없음", completed_yesterday: "어제 완료" };
export type ManagementAssignee = { name: string; slackId: string | null };
export const slackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Keep one short, actionable row per work item. Counts remain per signal (not a
// misleading sum of overlapping groups); no body is cut halfway through a row.
export function managementReportBlocks(input: {
  workspace: string; date: string; groups: ManagementBotGroup[]; appUrl: string; test?: boolean;
  assignees: Record<string, ManagementAssignee[]>; mentions?: boolean;
}, t: Translator) {
  const summaryUrl = `${input.appUrl}/?settings=workspace&tab=summary`;
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `${input.test ? `${t("테스트")} · ` : ""}${t("관리 봇")}` } },
    { type: "context", elements: [{ type: "plain_text", text: `${input.workspace.slice(0, 300)} · ${input.date}` }] },
  ];
  const groups = managementSignalOrder.flatMap((signal) => input.groups.filter((group) => group.signal === signal && group.count));
  if (!groups.length) blocks.push({ type: "section", text: { type: "plain_text", text: t("현재 선택한 관리 항목은 모두 정리되어 있습니다. ✅") } });
  else blocks.push({ type: "section", text: { type: "mrkdwn", text: groups.map((g) => `${t(labels[g.signal])} *${g.count}*`).join("  ·  ") } });
  const seen = new Set<string>(), mentioned = new Set<string>();
  for (const group of groups) {
    const rows = group.items.filter((item) => !seen.has(item.id)).slice(0, Math.min(group.signal === "completed_yesterday" ? 3 : 10, 10 - seen.size));
    if (!rows.length) continue;
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${t(labels[group.signal])}*` } });
    for (const item of rows) {
      seen.add(item.id);
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
  }
  blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: t("전체 보기") }, url: summaryUrl }] });
  return blocks;
}
