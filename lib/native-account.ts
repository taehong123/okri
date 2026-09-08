// The first statement aborts the whole D1 batch if ownership or membership changed
// after external subscription/token revocation. Never delete shared team content.
export function accountDeletionStatements(db: D1Database, userId: string, ownedIds: string[]) {
  const guardId = crypto.randomUUID(), expected = JSON.stringify(ownedIds);
  const statements = [db.prepare(`INSERT INTO native_account_deletion_guards(id,valid) SELECT ?,
    NOT EXISTS (SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
      WHERE w.owner_user_id=? AND m.status='active' AND (m.user_id IS NULL OR m.user_id != ?))
    AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_user_id=? AND id NOT IN (SELECT value FROM json_each(?)))
    AND NOT EXISTS (SELECT 1 FROM json_each(?) e LEFT JOIN workspaces w ON w.id=e.value WHERE w.id IS NULL OR w.owner_user_id != ?)`)
    .bind(guardId, userId, userId, userId, expected, expected, userId)];
  const ownerTables = ["google_calendar_events", "google_connections", "google_oauth_states", "slack_connections", "slack_oauth_states",
    "ai_usage_events", "activity_log", "routine_completions", "routine_property_definitions", "routines",
    "checklist_items", "item_property_values", "item_assignments", "project_hidden_properties", "project_documents", "project_templates",
    "property_definitions", "trash_records", "items", "workspace_backup_state"];
  for (const id of ownedIds) {
    for (const table of ownerTables) statements.push(db.prepare(`DELETE FROM ${table} WHERE owner_id=?`).bind(id));
    statements.push(db.prepare("UPDATE user_workspace_preferences SET active_workspace_id=NULL WHERE active_workspace_id=?").bind(id));
    // Foreign-key cascades remove workspace-owned groups, daily records and bot settings.
    statements.push(db.prepare("DELETE FROM workspaces WHERE id=? AND owner_user_id=?").bind(id, userId));
  }
  for (const table of ["native_sessions", "native_auth_codes", "integration_tokens", "assistant_drafts", "mcp_oauth_approvals",
    "google_calendar_events", "google_connections", "google_oauth_states", "slack_oauth_states", "billing_sessions", "billing_notifications", "user_workspace_preferences"]) {
    statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(userId));
  }
  statements.push(db.prepare("DELETE FROM mcp_oauth_codes WHERE json_valid(authorization_json) AND json_extract(authorization_json,'$.userId')=?").bind(userId));
  for (const table of ["slack_member_links", "slack_daily_preferences", "slack_daily_reminders", "slack_daily_checklists", "workspace_group_members", "item_assignments"]) {
    statements.push(db.prepare(`DELETE FROM ${table} WHERE member_id IN (SELECT id FROM workspace_members WHERE user_id=?)`).bind(userId));
  }
  statements.push(db.prepare("UPDATE workspace_members SET user_id=NULL,email=NULL,display_name='Deleted member',status='inactive',updated_at=? WHERE user_id=?").bind(new Date().toISOString(), userId));
  statements.push(db.prepare("DELETE FROM users WHERE id=?").bind(userId));
  statements.push(db.prepare("DELETE FROM native_account_deletion_guards WHERE id=?").bind(guardId));
  return statements;
}
