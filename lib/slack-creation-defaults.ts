type ToolArguments = Record<string, unknown>;

function missingMember(value: unknown) {
  return typeof value !== "string" || !value.trim();
}

/**
 * Slack @OKRI creation treats the invoking linked member as the responsible
 * person unless the conversation selected another active workspace member.
 * Keep this boundary-specific so ordinary MCP clients retain their existing
 * explicit assignment semantics.
 */
export function applySlackCreationActorDefaults(toolName: string, args: ToolArguments, actorMemberId: string) {
  const next = { ...args };
  if (!actorMemberId.trim()) return next;

  if (["capture_item", "create_tasks", "create_routine"].includes(toolName)
    && missingMember(next.assignee_member_id)) {
    next.assignee_member_id = actorMemberId;
  }

  if (toolName === "create_item") {
    if (next.kind === "task" && missingMember(next.assignee_member_id)) next.assignee_member_id = actorMemberId;
    if (next.kind === "project" && missingMember(next.dri_member_id)) next.dri_member_id = actorMemberId;
  }

  if (["manage_project", "propose_project"].includes(toolName)
    && (next.action === undefined || next.action === "propose")
    && missingMember(next.dri_member_id)) {
    next.dri_member_id = actorMemberId;
  }

  return next;
}
