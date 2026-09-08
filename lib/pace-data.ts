import { env } from "cloudflare:workers";
import { newAccountLanguage, readLanguagePreferences, workspaceMessageLanguage } from "./language-preferences";
import { serverTranslator } from "./server-language";
import { parseRoutineProperties, prepareRoutineProperties } from "./routine-properties";
import { effectiveIntegrationProvider, type IntegrationProvider } from "@/lib/integration-providers";
import { and, asc, desc, eq, inArray, isNull, like, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { readGoogleSession } from "@/lib/google-session";
import {
  activityLog,
  aiUsageEvents,
  authIdentities,
  checklistItems,
  dailyScrums,
  googleCalendarEvents,
  googleConnections,
  googleOAuthStates,
  itemAssignments,
  itemPropertyValues,
  items,
  integrationTokens,
  krDataConnections,
  okrCycles,
  propertyDefinitions,
  projectDocuments,
  projectHiddenProperties,
  projectTemplates,
  routineCompletions,
  routines,
  slackAutomationDeliveries,
  slackAutomations,
  slackConnections,
  slackOAuthStates,
  trashRecords,
  users,
  userWorkspacePreferences,
  workspaceRules,
  workspaceGroupMembers,
  workspaceGroups,
  workspaceMembers,
  workspaceInvitations,
  workspaces,
  type PaceItem,
  type PropertyDefinition,
  type ProjectDocument,
  type ProjectTemplate,
  type WorkspaceGroup,
  type WorkspaceGroupMember,
  type WorkspaceMember,
  type WorkspaceInvitation,
  type WorkspaceRule,
  type IntegrationToken,
  type KrDataConnection,
  type OkrCycle,
  type GoogleConnection,
  type SlackConnection,
  type SlackAutomation,
  type SlackAutomationDelivery,
  type TrashRecord,
} from "@/db/schema";
import { syncDueKrDataConnectionsWithDb, syncKrDataConnectionWithDb } from "@/lib/kr-data-sync";
import {
  isSlackAutomationTrigger,
  isSupportedTaskAutomation,
  normalizeSlackChannelId,
  renderSlackAutomationMessage,
  systemAutomationTemplate,
  type AutomationMessageKind,
  slackAutomationMatches,
  type SlackAutomationContext,
  type SlackAutomationTrigger,
} from "@/lib/slack-automation";
import {
  cancelSubscription,
  ensureBillingSchema,
  memberCanWrite,
  releaseEditorSeat,
  releaseProjectCreation,
  reserveEditorSeat,
  reserveProjectCreation,
} from "@/lib/billing";

export const ITEM_KINDS = ["objective", "key_result", "initiative", "project", "task"] as const;
export const ITEM_STATUSES = ["backlog", "todo", "policy_discussion", "in_progress", "developing", "development_done", "done", "blocked", "archived"] as const;
export const ITEM_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const ITEM_CADENCES = ["daily", "weekly", "monthly", "quarterly"] as const;
export const OKR_CYCLE_STATUSES = ["planned", "active", "closed"] as const;
export const PROPERTY_TYPES = ["text", "number", "select", "date", "checkbox", "member", "members"] as const;
export const ITEM_ASSIGNMENT_ROLES = ["project_dri", "project_worker", "task_assignee"] as const;
export const ROUTINE_CADENCES = ["daily", "weekly", "monthly"] as const;
export const KR_DATA_CADENCES = ["hourly", "daily", "weekly", "manual"] as const;
export const DATA_CONNECTION_TARGET_KINDS = ["key_result", "project"] as const;
export const GENERAL_ROUTINE_SYSTEM_KEY = "general";
const LEGACY_SEED_OBJECTIVE_TITLE = "셀프 서브 도입으로 팀의 성장 속도를 높인다";
const LEGACY_SEED_ITEM_TITLES = [
  LEGACY_SEED_OBJECTIVE_TITLE,
  "신규 사용자의 첫 주 활성화율 32% → 48%",
  "가입 후 10분 안에 첫 가치 경험 만들기",
  "온보딩 활성화 개선",
  "온보딩 체크리스트 실험",
  "결제 화면 카피 확정",
  "활성화 이벤트 QA",
  "신규 사용자 5명 인터뷰",
  "가격 정책 페이지 개선 아이디어",
  "모바일 가입 이탈 구간 확인",
];
const LEGACY_SEED_ROUTINE_TITLES = ["오늘의 최우선 Task 정리", "주간 회고 작성"];
export const TEAM_ROLES = ["owner", "admin", "member", "viewer"] as const;
export const GROUP_COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple"] as const;
export const GROUP_VISIBILITIES = ["open", "private"] as const;
export const GROUP_ROLES = ["lead", "member"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemPriority = (typeof ITEM_PRIORITIES)[number];
export type ItemCadence = (typeof ITEM_CADENCES)[number];
export type OkrCycleStatus = (typeof OKR_CYCLE_STATUSES)[number];
export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type PropertyValue = string | number | boolean | string[] | null;
export type ItemAssignmentRole = (typeof ITEM_ASSIGNMENT_ROLES)[number];
export type RoutineCadence = (typeof ROUTINE_CADENCES)[number];
export type KrDataCadence = (typeof KR_DATA_CADENCES)[number];
export type WorkspaceRuleInput = Partial<{
  captureInstruction: string;
  structureInstruction: string;
  routineInstruction: string;
  defaultPriority: ItemPriority;
  defaultCadence: ItemCadence;
  reviewBeforeCreate: boolean;
  configured: boolean;
}>;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type InvitationDeliveryStatus = "not_sent" | "sent" | "failed" | "unavailable";
export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";
export type WorkspaceInvitationSummary = {
  id: string;
  email: string;
  displayName: string;
  role: Exclude<TeamRole, "owner">;
  status: InvitationStatus;
  deliveryStatus: InvitationDeliveryStatus;
  expiresAt: string;
  lastSentAt: string | null;
  createdAt: string;
};
export type GroupColor = (typeof GROUP_COLORS)[number];
export type GroupVisibility = (typeof GROUP_VISIBILITIES)[number];
export type GroupRole = (typeof GROUP_ROLES)[number];
export type AiUsageSummary = {
  spentWonMicros: number;
  requestsToday: number;
  requestsThisMinute: number;
};

export type OkrPlanInput = {
  cycleId: string;
  targetId?: string | null;
  targetKind?: "objective" | "key_result" | "initiative" | null;
  tree?: {
    objectiveTitle?: string;
    keyResults?: Array<{ title: string; initiatives?: Array<{ title: string }> }>;
    targetInitiatives?: Array<{ title: string }>;
  };
  objective?: string;
  keyResult?: string;
  initiative?: string;
  project?: string;
  driMemberId?: string | null;
};

export type RequestAuthorization = {
  ownerId: string;
  userId: string;
  email: string | null;
  displayName: string;
  role: TeamRole;
  apiToken: boolean;
  oauthScopes?: string;
};

export type IntegrationTokenSummary = Pick<IntegrationToken, "id" | "name" | "tokenPrefix" | "createdAt" | "lastUsedAt" | "revokedAt"> & { provider: IntegrationProvider };

const DEFAULT_PROJECT_EXECUTION_PROPERTIES: { name: string; type: PropertyType; systemKey?: string; options?: string[]; defaultValue?: PropertyValue }[] = [
  { name: "상위 Initiative", type: "text", systemKey: "parent_id" },
  { name: "상태", type: "select", systemKey: "status", options: [...ITEM_STATUSES.filter((status) => status !== "archived")] },
  { name: "우선순위", type: "select", systemKey: "priority", options: [...ITEM_PRIORITIES] },
  { name: "기한", type: "date", systemKey: "due_date" },
  { name: "책임자", type: "member", systemKey: "project_dri" },
  { name: "하위 업무자", type: "members", systemKey: "project_workers" },
  { name: "KR 기여 예상치", type: "number" },
];

type RuntimeEnv = typeof env & {
  OKRI_API_TOKEN?: string;
  OKRPTR_API_TOKEN?: string;
  OKITA_API_TOKEN?: string;
  PACE_API_TOKEN?: string;
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
  ACCOUNT_REGISTRATION_REQUIRED?: string;
  ACCOUNT_DATA_ENCRYPTION_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  RESEND_API_KEY?: string;
  OKRI_PUBLIC_URL?: string;
  OKRPTR_PUBLIC_URL?: string;
  OKRI_INVITE_FROM?: string;
  OKRPTR_INVITE_FROM?: string;
  WORKSPACE_AVATARS?: R2Bucket;
};
let schemaReady: Promise<void> | null = null;
const workspaceReady = new Map<string, Promise<void>>();
let invitationDomainCache: { verified: boolean; checkedAt: number } | null = null;

const parentKind: Record<ItemKind, ItemKind | null> = {
  objective: null,
  key_result: "objective",
  initiative: "key_result",
  project: "initiative",
  task: "project",
};
const completedStatuses = new Set<ItemStatus>(["done", "development_done"]);
const okrKinds = new Set<ItemKind>(["objective", "key_result", "initiative"]);
const reservedAssignmentPropertyNames = new Set(["dri", "owner", "assignee", "담당", "담당자", "책임자", "worker", "workers", "하위 업무자", "업무자", "작업자", "참여자"]);

export function normalizeTaskStatus(status?: ItemStatus) {
  return status && completedStatuses.has(status) ? "done" as const : "todo" as const;
}

async function ensureSchema() {
  if (!schemaReady) {
    const d1 = (env as RuntimeEnv).DB;
    schemaReady = (async () => {
      // Slack checklist storage must exist even when all older schema sentinels pass.
      await d1.batch([
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_daily_checklists (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          revision INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_daily_checklists_expiry ON slack_daily_checklists(expires_at)"),
      ]);
      if (await schemaIsCurrent(d1)) {
        return;
      }
      await d1.batch([
        d1.prepare(`CREATE TABLE IF NOT EXISTS app_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'team',
          deletion_requested_at TEXT,
          scheduled_deletion_at TEXT,
          deletion_requested_by_user_id TEXT,
          avatar_key TEXT,
          avatar_updated_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("DROP INDEX IF EXISTS idx_workspaces_owner_user"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email_normalized TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users(email_normalized)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS auth_identities (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          provider_subject TEXT NOT NULL,
          email TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_subject ON auth_identities(provider, provider_subject)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS account_registrations (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          encrypted_phone TEXT NOT NULL DEFAULT '',
          phone_hash TEXT NOT NULL DEFAULT '',
          phone_last_four TEXT NOT NULL DEFAULT '',
          verification_provider TEXT NOT NULL DEFAULT '',
          phone_verified_at TEXT,
          required_privacy_consent_at TEXT,
          age_14_confirmed_at TEXT,
          marketing_data_consent INTEGER NOT NULL DEFAULT 0,
          marketing_data_consent_at TEXT,
          electronic_marketing_consent INTEGER NOT NULL DEFAULT 0,
          electronic_marketing_consent_at TEXT,
          consent_version TEXT NOT NULL DEFAULT '2026-09-01',
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_account_registrations_phone_hash ON account_registrations(phone_hash)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS account_consent_events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          consent_type TEXT NOT NULL,
          granted INTEGER NOT NULL,
          policy_version TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'signup',
          occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_account_consent_events_user_type ON account_consent_events(user_id, consent_type, occurred_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS phone_verification_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          encrypted_phone TEXT NOT NULL,
          phone_hash TEXT NOT NULL,
          phone_last_four TEXT NOT NULL,
          provider_sid TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT NOT NULL,
          verified_at TEXT
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_phone_verification_requests_user_time ON phone_verification_requests(user_id, requested_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_phone_verification_requests_phone_time ON phone_verification_requests(phone_hash, requested_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT,
          email TEXT,
          display_name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'member',
          status TEXT NOT NULL DEFAULT 'invited',
          invited_by_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("DROP INDEX IF EXISTS idx_workspace_members_user"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_workspace_user ON workspace_members(workspace_id, user_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_members_user_lookup ON workspace_members(user_id, status)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_workspace_email ON workspace_members(workspace_id, email)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_status ON workspace_members(workspace_id, status)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_invitations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'member',
          token_hash TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          delivery_status TEXT NOT NULL DEFAULT 'not_sent',
          provider_message_id TEXT,
          invited_by_user_id TEXT NOT NULL,
          accepted_by_user_id TEXT,
          expires_at TEXT NOT NULL,
          last_sent_at TEXT,
          accepted_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invitations_pending_email ON workspace_invitations(workspace_id, email) WHERE status = 'pending'"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invitations_token ON workspace_invitations(token_hash) WHERE token_hash <> ''"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_status ON workspace_invitations(workspace_id, status)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email_status ON workspace_invitations(email, status)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS user_workspace_preferences (
          user_id TEXT PRIMARY KEY,
          active_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_user_workspace_preferences_active ON user_workspace_preferences(active_workspace_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_rules (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          capture_instruction TEXT NOT NULL DEFAULT '',
          structure_instruction TEXT NOT NULL DEFAULT '',
          routine_instruction TEXT NOT NULL DEFAULT '',
          default_priority TEXT NOT NULL DEFAULT 'medium',
          default_cadence TEXT NOT NULL DEFAULT 'weekly',
          review_before_create INTEGER NOT NULL DEFAULT 1,
          configured INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare(`CREATE TABLE IF NOT EXISTS integration_tokens (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT 'Codex',
          token_hash TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at TEXT,
          revoked_at TEXT
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_tokens_hash ON integration_tokens(token_hash)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_integration_tokens_workspace_user ON integration_tokens(workspace_id, user_id, revoked_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS okr_cycles (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          department TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_okr_cycles_owner_status ON okr_cycles(owner_id, status)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_okr_cycles_owner_version ON okr_cycles(owner_id, version)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_groups (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          handle TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'gray',
          visibility TEXT NOT NULL DEFAULT 'open',
          archived INTEGER NOT NULL DEFAULT 0,
          created_by_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_groups_workspace_handle ON workspace_groups(workspace_id, handle)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_groups_workspace_archived ON workspace_groups(workspace_id, archived)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_group_members (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES workspace_groups(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_group_members_unique ON workspace_group_members(group_id, member_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_group_members_member ON workspace_group_members(member_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_group_members_group_role ON workspace_group_members(group_id, role)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          cycle_id TEXT REFERENCES okr_cycles(id) ON DELETE SET NULL,
          parent_id TEXT,
          routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'todo',
          priority TEXT NOT NULL DEFAULT 'medium',
          cadence TEXT NOT NULL DEFAULT 'weekly',
          progress INTEGER NOT NULL DEFAULT 0,
          due_date TEXT,
          source TEXT NOT NULL DEFAULT 'web',
          source_ref TEXT,
          created_by_user_id TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          archived_at TEXT,
          archived_from_status TEXT,
          archive_root_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_status ON items(owner_id, status)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_parent ON items(owner_id, parent_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_cadence ON items(owner_id, cadence)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS kr_data_connections (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          kr_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          endpoint_url TEXT NOT NULL,
          value_path TEXT NOT NULL DEFAULT '',
          baseline_value REAL NOT NULL DEFAULT 0,
          target_value REAL NOT NULL,
          unit TEXT NOT NULL DEFAULT '',
          cadence TEXT NOT NULL DEFAULT 'daily',
          active INTEGER NOT NULL DEFAULT 1,
          last_value REAL,
          last_sync_status TEXT NOT NULL DEFAULT 'never',
          last_error TEXT NOT NULL DEFAULT '',
          last_synced_at TEXT,
          next_sync_at TEXT,
          created_by_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_kr_data_connections_owner_kr ON kr_data_connections(owner_id, kr_item_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_kr_data_connections_due ON kr_data_connections(active, next_sync_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS item_assignments (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_item_assignments_unique ON item_assignments(owner_id, item_id, member_id, role)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_item_assignments_single_role ON item_assignments(owner_id, item_id, role) WHERE role IN ('project_dri', 'task_assignee')"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_item_assignments_owner_item ON item_assignments(owner_id, item_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_item_assignments_member ON item_assignments(member_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS activity_log (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          action TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_activity_owner_created ON activity_log(owner_id, created_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_activity_item ON activity_log(item_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS property_definitions (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          options TEXT NOT NULL DEFAULT '[]',
          default_value TEXT NOT NULL DEFAULT 'null',
          system_key TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_property_definitions_owner_name ON property_definitions(owner_id, name)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS item_property_values (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          property_id TEXT NOT NULL REFERENCES property_definitions(id) ON DELETE CASCADE,
          value TEXT NOT NULL DEFAULT 'null',
          legacy_value TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_item_property_values_unique ON item_property_values(owner_id, item_id, property_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_item_property_values_owner_item ON item_property_values(owner_id, item_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_item_property_values_owner_property ON item_property_values(owner_id, property_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS project_hidden_properties (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          property_id TEXT NOT NULL REFERENCES property_definitions(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_hidden_properties_unique ON project_hidden_properties(owner_id, project_id, property_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_hidden_properties_project ON project_hidden_properties(owner_id, project_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_hidden_properties_property ON project_hidden_properties(owner_id, property_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS project_documents (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          content TEXT NOT NULL DEFAULT '[]',
          plain_text TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          updated_by_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(owner_id, project_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_documents_owner_updated ON project_documents(owner_id, updated_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS project_templates (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '[]',
          plain_text TEXT NOT NULL DEFAULT '',
          created_by_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_templates_owner_name ON project_templates(owner_id, name)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_templates_owner_updated ON project_templates(owner_id, updated_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS checklist_items (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_checklist_owner_task ON checklist_items(owner_id, task_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS daily_scrums (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          member_id TEXT REFERENCES workspace_members(id) ON DELETE CASCADE,
          scrum_date TEXT NOT NULL,
          yesterday_note TEXT NOT NULL DEFAULT '',
          today_note TEXT NOT NULL DEFAULT '',
          blockers_note TEXT NOT NULL DEFAULT '',
          no_planned_tasks INTEGER NOT NULL DEFAULT 0,
          work_status TEXT NOT NULL DEFAULT 'office',
          skip_reason TEXT,
          skip_note TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'web',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_scrums_owner_date ON daily_scrums(owner_id, scrum_date)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS routines (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          system_key TEXT,
          assignee_member_id TEXT REFERENCES workspace_members(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          trigger_point TEXT NOT NULL DEFAULT '',
          action_place TEXT NOT NULL DEFAULT '',
          action_steps TEXT NOT NULL DEFAULT '',
          cadence TEXT NOT NULL DEFAULT 'daily',
          active INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_routines_owner_active ON routines(owner_id, active)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_routines_owner_sort ON routines(owner_id, sort_order)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS routine_completions (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
          completion_date TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_completions_unique ON routine_completions(owner_id, routine_id, completion_date)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_routine_completions_owner_date ON routine_completions(owner_id, completion_date)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS ai_usage_events (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          model TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          input_chars INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost_won_micros INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_created ON ai_usage_events(owner_id, created_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage_events(user_id, created_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS google_connections (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          google_account_id TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          display_name TEXT NOT NULL DEFAULT '',
          encrypted_refresh_token TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT '',
          connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_google_connections_owner_user ON google_connections(owner_id, user_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_google_connections_user ON google_connections(user_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS google_oauth_states (
          state TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          return_to TEXT NOT NULL DEFAULT '/',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT NOT NULL
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expires ON google_oauth_states(expires_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS google_calendar_events (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          calendar_id TEXT NOT NULL DEFAULT 'primary',
          google_event_id TEXT NOT NULL,
          html_link TEXT NOT NULL DEFAULT '',
          synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_google_calendar_events_item ON google_calendar_events(owner_id, user_id, item_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_google_calendar_events_owner ON google_calendar_events(owner_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_connections (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          team_id TEXT NOT NULL,
          team_name TEXT NOT NULL DEFAULT '',
          bot_user_id TEXT NOT NULL DEFAULT '',
          app_id TEXT NOT NULL DEFAULT '',
          encrypted_bot_token TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT '',
          connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_connections_team ON slack_connections(team_id)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_connections_owner ON slack_connections(owner_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_automations (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          created_by_user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          trigger_status TEXT NOT NULL DEFAULT '',
          channel_id TEXT NOT NULL,
          message_template TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          last_triggered_at TEXT,
          last_delivery_status TEXT NOT NULL DEFAULT 'never',
          last_error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_automations_owner ON slack_automations(owner_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_automations_owner_active_trigger ON slack_automations(owner_id, active, trigger_type)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_automation_deliveries (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          automation_id TEXT NOT NULL REFERENCES slack_automations(id) ON DELETE CASCADE,
          item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
          event_key TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sent_at TEXT
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_automation_deliveries_event ON slack_automation_deliveries(event_key)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_automation_deliveries_owner_created ON slack_automation_deliveries(owner_id, created_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_automation_deliveries_automation_created ON slack_automation_deliveries(automation_id, created_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_oauth_states (
          state TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          return_to TEXT NOT NULL DEFAULT '/',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT NOT NULL
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_oauth_states_expires ON slack_oauth_states(expires_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS trash_records (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          payload TEXT NOT NULL,
          item_count INTEGER NOT NULL DEFAULT 0,
          routine_count INTEGER NOT NULL DEFAULT 0,
          cycle_count INTEGER NOT NULL DEFAULT 0,
          created_by_user_id TEXT,
          archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_trash_records_owner_archived ON trash_records(owner_id, archived_at)"),
        d1.prepare("PRAGMA optimize"),
      ]);
      await addColumnIfMissing(d1, "ALTER TABLE routines ADD COLUMN trigger_point TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(d1, "ALTER TABLE routines ADD COLUMN action_place TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(d1, "ALTER TABLE routines ADD COLUMN action_steps TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(d1, "ALTER TABLE routines ADD COLUMN system_key TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE routines ADD COLUMN assignee_member_id TEXT REFERENCES workspace_members(id) ON DELETE SET NULL");
      await addColumnIfMissing(d1, "ALTER TABLE okr_cycles ADD COLUMN department TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(d1, "ALTER TABLE items ADD COLUMN cycle_id TEXT REFERENCES okr_cycles(id) ON DELETE SET NULL");
      await addColumnIfMissing(d1, "ALTER TABLE items ADD COLUMN routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL");
      await addColumnIfMissing(d1, "ALTER TABLE items ADD COLUMN archived_at TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE items ADD COLUMN archived_from_status TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE items ADD COLUMN archive_root_id TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE items ADD COLUMN created_by_user_id TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE integration_tokens ADD COLUMN last_used_at TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE workspaces ADD COLUMN deletion_requested_at TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE workspaces ADD COLUMN scheduled_deletion_at TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE workspaces ADD COLUMN deletion_requested_by_user_id TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE workspaces ADD COLUMN avatar_key TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE workspaces ADD COLUMN avatar_updated_at TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'team'");
      await addColumnIfMissing(d1, "ALTER TABLE property_definitions ADD COLUMN default_value TEXT NOT NULL DEFAULT 'null'");
      await addColumnIfMissing(d1, "ALTER TABLE property_definitions ADD COLUMN system_key TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE property_definitions ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
      await addColumnIfMissing(d1, "ALTER TABLE item_property_values ADD COLUMN legacy_value TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE daily_scrums ADD COLUMN member_id TEXT REFERENCES workspace_members(id) ON DELETE CASCADE");
      await addColumnIfMissing(d1, "ALTER TABLE daily_scrums ADD COLUMN no_planned_tasks INTEGER NOT NULL DEFAULT 0");
      await addColumnIfMissing(d1, "ALTER TABLE daily_scrums ADD COLUMN work_status TEXT NOT NULL DEFAULT 'office'");
      await addColumnIfMissing(d1, "ALTER TABLE daily_scrums ADD COLUMN skip_reason TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE daily_scrums ADD COLUMN skip_note TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(d1, "ALTER TABLE daily_scrums ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
      await d1.prepare("DROP INDEX IF EXISTS idx_daily_scrums_owner_date").run();
      await d1.batch([
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_scrums_owner_member_date ON daily_scrums(owner_id, member_id, scrum_date) WHERE member_id IS NOT NULL"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_scrums_legacy_owner_date ON daily_scrums(owner_id, scrum_date) WHERE member_id IS NULL"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_scrums_owner_date ON daily_scrums(owner_id, scrum_date)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS daily_scrum_task_selections (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          daily_scrum_id TEXT NOT NULL REFERENCES daily_scrums(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_scrum_task_selections_unique ON daily_scrum_task_selections(daily_scrum_id, task_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_scrum_task_selections_member ON daily_scrum_task_selections(owner_id, member_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS daily_submissions (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          member_id TEXT REFERENCES workspace_members(id) ON DELETE SET NULL,
          member_name TEXT NOT NULL DEFAULT '', member_email TEXT NOT NULL DEFAULT '', scrum_date TEXT NOT NULL,
           version INTEGER NOT NULL, yesterday_note TEXT NOT NULL DEFAULT '', today_note TEXT NOT NULL DEFAULT '',
           blockers_note TEXT NOT NULL DEFAULT '', no_planned_tasks INTEGER NOT NULL DEFAULT 0,
           work_status TEXT NOT NULL DEFAULT 'office',
           skip_reason TEXT, skip_note TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'web', submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_submissions_owner_member_date_version ON daily_submissions(owner_id, member_id, scrum_date, version)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_submissions_owner_date ON daily_submissions(owner_id, scrum_date, submitted_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS daily_task_snapshots (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          submission_id TEXT NOT NULL REFERENCES daily_submissions(id) ON DELETE CASCADE,
          task_id TEXT, task_title TEXT NOT NULL, parent_kind TEXT NOT NULL DEFAULT 'general', parent_id TEXT,
          parent_title TEXT NOT NULL DEFAULT 'General', status TEXT NOT NULL DEFAULT 'todo',
          is_new INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_task_snapshots_submission ON daily_task_snapshots(submission_id, sort_order)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_member_links (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
          team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, slack_email TEXT NOT NULL DEFAULT '',
          slack_display_name TEXT NOT NULL DEFAULT '', dm_channel_id TEXT NOT NULL DEFAULT '', matched_by TEXT NOT NULL DEFAULT 'email',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_member_links_owner_member ON slack_member_links(owner_id, member_id)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_member_links_team_user ON slack_member_links(team_id, slack_user_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_member_links_owner ON slack_member_links(owner_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_daily_settings (
          owner_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0,
          weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]', reminder_time TEXT NOT NULL DEFAULT '09:00',
           summary_enabled INTEGER NOT NULL DEFAULT 1, summary_time TEXT NOT NULL DEFAULT '12:00',
           work_statuses TEXT NOT NULL DEFAULT '["office","remote","skip"]',
           timezone TEXT NOT NULL DEFAULT 'Asia/Seoul', install_status TEXT NOT NULL DEFAULT 'not_connected',
          required_scopes TEXT NOT NULL DEFAULT '', onboarding_completed_at TEXT, last_synced_at TEXT, last_error TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_management_bot_settings (
          owner_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0, weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
          report_time TEXT NOT NULL DEFAULT '09:00', timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
          channel_id TEXT NOT NULL DEFAULT '', channel_name TEXT NOT NULL DEFAULT '',
          signals TEXT NOT NULL DEFAULT '["missing_due_date","missing_owner","overdue","completed_yesterday","due_today"]',
          last_sent_date TEXT, last_sent_at TEXT, last_error TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_management_bot_due ON workspace_management_bot_settings(enabled, last_sent_date)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_daily_preferences (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1,
          reminder_time TEXT, timezone TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_daily_preferences_owner_member ON slack_daily_preferences(owner_id, member_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_daily_channels (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL, channel_name TEXT NOT NULL DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_daily_channels_owner_channel ON slack_daily_channels(owner_id, channel_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_daily_channels_owner ON slack_daily_channels(owner_id)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_daily_reminders (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE, slack_user_id TEXT NOT NULL,
          dm_channel_id TEXT NOT NULL, scheduled_message_id TEXT NOT NULL, post_at INTEGER NOT NULL, block_id TEXT NOT NULL,
          bot_user_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'scheduled', last_error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_daily_reminders_owner_member ON slack_daily_reminders(owner_id, member_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_daily_reminders_post_at ON slack_daily_reminders(status, post_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_daily_publications (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          member_id TEXT REFERENCES workspace_members(id) ON DELETE SET NULL,
          submission_id TEXT NOT NULL REFERENCES daily_submissions(id) ON DELETE CASCADE, scrum_date TEXT NOT NULL,
          channel_id TEXT NOT NULL, slack_message_ts TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
          attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_daily_publications_submission_channel ON slack_daily_publications(submission_id, channel_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_daily_publications_owner_status ON slack_daily_publications(owner_id, status, updated_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_event_receipts (
          event_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT '',
          received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_event_receipts_received ON slack_event_receipts(received_at)"),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_work_command_operations (
          request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, command TEXT NOT NULL, target_id TEXT,
          status TEXT NOT NULL DEFAULT 'processing', result_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_work_commands_owner_created ON slack_work_command_operations(owner_id, created_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_work_commands_actor ON slack_work_command_operations(team_id, slack_user_id, created_at)"),
        d1.prepare(`UPDATE slack_automations SET active = 0, updated_at = CURRENT_TIMESTAMP
          WHERE trigger_type = 'task_status_changed' AND trigger_status NOT IN ('todo', 'done') AND active = 1`),
        d1.prepare(`CREATE TABLE IF NOT EXISTS slack_link_tokens (
          token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, slack_email TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, used_at TEXT
        )`),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_slack_link_tokens_expires ON slack_link_tokens(expires_at)"),
        d1.prepare(`UPDATE items
          SET created_by_user_id = (
            SELECT owner_user_id FROM workspaces
            WHERE workspaces.id = items.owner_id
              AND workspaces.id = workspaces.owner_user_id
          )
          WHERE created_by_user_id IS NULL
            AND EXISTS (
              SELECT 1 FROM workspaces
              WHERE workspaces.id = items.owner_id
                AND workspaces.id = workspaces.owner_user_id
            )`),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_owner_system_key ON routines(owner_id, system_key) WHERE system_key IS NOT NULL"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_routines_assignee ON routines(assignee_member_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspaces_scheduled_deletion ON workspaces(scheduled_deletion_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_routine ON items(owner_id, routine_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_cycle ON items(owner_id, cycle_id)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_archived ON items(owner_id, archived_at)"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_items_owner_archive_root ON items(owner_id, archive_root_id)"),
        d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_property_definitions_owner_system ON property_definitions(owner_id, system_key) WHERE system_key IS NOT NULL"),
        d1.prepare("CREATE INDEX IF NOT EXISTS idx_property_definitions_owner_active_sort ON property_definitions(owner_id, active, sort_order)"),
        d1.prepare(`UPDATE items
          SET archived_at = COALESCE(updated_at, CURRENT_TIMESTAMP),
              archived_from_status = CASE kind WHEN 'project' THEN 'backlog' ELSE 'todo' END,
              archive_root_id = CASE kind WHEN 'project' THEN id ELSE parent_id END
          WHERE status = 'archived' AND archived_at IS NULL`),
        d1.prepare("UPDATE items SET progress = 0 WHERE kind IN ('objective', 'initiative') AND progress <> 0"),
      ]);
      await addColumnIfMissing(d1, "ALTER TABLE daily_submissions ADD COLUMN skip_reason TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE daily_submissions ADD COLUMN skip_note TEXT NOT NULL DEFAULT ''");
      await addColumnIfMissing(d1, "ALTER TABLE daily_submissions ADD COLUMN work_status TEXT NOT NULL DEFAULT 'office'");
      await addColumnIfMissing(d1, "ALTER TABLE slack_daily_settings ADD COLUMN onboarding_completed_at TEXT");
      await addColumnIfMissing(d1, "ALTER TABLE slack_daily_settings ADD COLUMN summary_enabled INTEGER NOT NULL DEFAULT 1");
      await addColumnIfMissing(d1, "ALTER TABLE slack_daily_settings ADD COLUMN summary_time TEXT NOT NULL DEFAULT '12:00'");
      await addColumnIfMissing(d1, "ALTER TABLE slack_daily_settings ADD COLUMN work_statuses TEXT NOT NULL DEFAULT '[\"office\",\"remote\",\"skip\"]'");
      await d1.prepare(`UPDATE slack_daily_settings
        SET onboarding_completed_at = COALESCE(last_synced_at, updated_at)
        WHERE install_status = 'connected'
          AND onboarding_completed_at IS NULL
          AND EXISTS (SELECT 1 FROM slack_daily_preferences WHERE slack_daily_preferences.owner_id = slack_daily_settings.owner_id)`).run();
      await migrateIdentityAndInvitations(d1);
      await migrateLegacyAccountRegistrations(d1);
      await ensureAssistantDraftSchema(d1);
    })()
      .catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
  }

  await schemaReady;
}

async function ensureAssistantDraftSchema(d1: D1Database) {
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS assistant_drafts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      draft_key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_drafts_owner_user_key ON assistant_drafts(owner_id, user_id, draft_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_assistant_drafts_owner_user_updated ON assistant_drafts(owner_id, user_id, updated_at)"),
  ]);
}

async function schemaIsCurrent(d1: RuntimeEnv["DB"]) {
  try {
    // Validate every runtime compatibility sentinel in one D1 round trip.
    await d1.prepare(`SELECT
      workspace.deletion_requested_at,
      workspace.scheduled_deletion_at,
      workspace.deletion_requested_by_user_id,
      workspace.kind,
      workspace.avatar_key,
      workspace.avatar_updated_at,
      routine.system_key,
      routine.assignee_member_id,
      property.default_value,
      property.system_key,
      property.active,
      item.created_by_user_id,
      project_document.version,
      kr_data_connection.target_value,
      daily_scrum.member_id,
      daily_scrum.no_planned_tasks,
      daily_scrum.skip_reason,
      daily_submission.skip_reason,
      slack_daily_setting.reminder_time,
      slack_daily_setting.summary_enabled,
      slack_daily_setting.summary_time,
      slack_daily_setting.onboarding_completed_at
      ,slack_daily_checklist.revision
      ,management_bot.report_time
      ,assistant_draft.updated_at
      ,account_registration.completed_at
      ,app_migration.applied_at
    FROM workspaces AS workspace
    LEFT JOIN routines AS routine ON 1 = 0
    LEFT JOIN property_definitions AS property ON 1 = 0
    LEFT JOIN items AS item ON 1 = 0
    LEFT JOIN project_documents AS project_document ON 1 = 0
    LEFT JOIN kr_data_connections AS kr_data_connection ON 1 = 0
    LEFT JOIN daily_scrums AS daily_scrum ON 1 = 0
    LEFT JOIN daily_submissions AS daily_submission ON 1 = 0
    LEFT JOIN slack_daily_settings AS slack_daily_setting ON 1 = 0
    LEFT JOIN slack_daily_checklists AS slack_daily_checklist ON 1 = 0
    LEFT JOIN workspace_management_bot_settings AS management_bot ON 1 = 0
    LEFT JOIN users AS app_user ON 1 = 0
    LEFT JOIN auth_identities AS auth_identity ON 1 = 0
    LEFT JOIN workspace_invitations AS invitation ON 1 = 0
    LEFT JOIN assistant_drafts AS assistant_draft ON 1 = 0
    LEFT JOIN account_registrations AS account_registration ON 1 = 0
    LEFT JOIN app_migrations AS app_migration ON 1 = 0
    LIMIT 0`).first();
    return true;
  } catch {
    return false;
  }
}

async function addColumnIfMissing(d1: RuntimeEnv["DB"], statement: string) {
  try {
    await d1.prepare(statement).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column|already exists/i.test(message)) throw error;
  }
}

async function migrateLegacyAccountRegistrations(d1: RuntimeEnv["DB"]) {
  const migrationId = "account_registration_legacy_v1";
  const applied = await d1.prepare("SELECT id FROM app_migrations WHERE id = ?").bind(migrationId).first();
  if (applied) return;
  await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO account_registrations
      (user_id, verification_provider, consent_version, completed_at, created_at, updated_at)
      SELECT id, 'legacy', 'legacy-2026-09-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM users`),
    d1.prepare("INSERT OR IGNORE INTO app_migrations (id, applied_at) VALUES (?, CURRENT_TIMESTAMP)").bind(migrationId),
  ]);
}

async function migrateIdentityAndInvitations(d1: RuntimeEnv["DB"]) {
  const migrationId = "identity_invitations_v1";
  const applied = await d1.prepare("SELECT id FROM app_migrations WHERE id = ?").bind(migrationId).first();
  if (applied) return;
  const duplicateWorkspaceId = "E6WSfoIlmC4YdGCMeD5Pcc0vPe4WgTmCKlJhSyb96ovmjgAzTmphTT";
  const canonicalPodongUserId = "google:110361141304883691643";
  const allVibeWorkspaceId = "07a2ec53-447a-4e2c-9403-175815cb7bca";
  const duplicate = await d1.prepare(`SELECT
    EXISTS(SELECT 1 FROM workspaces WHERE id = ?) AS present,
    (SELECT count(*) FROM items WHERE owner_id = ?) AS item_count,
    (SELECT count(*) FROM routines WHERE owner_id = ? AND coalesce(system_key, '') <> 'general') AS custom_routine_count,
    (SELECT count(*) FROM daily_scrums WHERE owner_id = ?) AS daily_count,
    (SELECT count(*) FROM trash_records WHERE owner_id = ?) AS trash_count,
    (SELECT count(*) FROM integration_tokens WHERE workspace_id = ?) AS token_count,
    (SELECT count(*) FROM google_connections WHERE owner_id = ?) AS google_count,
    (SELECT count(*) FROM slack_connections WHERE owner_id = ?) AS slack_count
  `).bind(
    duplicateWorkspaceId,
    duplicateWorkspaceId,
    duplicateWorkspaceId,
    duplicateWorkspaceId,
    duplicateWorkspaceId,
    duplicateWorkspaceId,
    duplicateWorkspaceId,
    duplicateWorkspaceId,
  ).first<Record<string, number>>();
  if (Number(duplicate?.present ?? 0)) {
    const unsafeCount = ["item_count", "custom_routine_count", "daily_count", "trash_count", "token_count", "google_count", "slack_count"]
      .reduce((sum, key) => sum + Number(duplicate?.[key] ?? 0), 0);
    if (unsafeCount > 0) throw new Error("Duplicate personal workspace contains user data; automatic repair stopped.");
    await permanentlyDeleteWorkspace(duplicateWorkspaceId);
  }

  await d1.batch([
    d1.prepare("UPDATE workspaces SET kind = CASE WHEN id = owner_user_id THEN 'personal' ELSE 'team' END"),
    d1.prepare(`INSERT OR IGNORE INTO users (id, email_normalized, display_name, created_at, updated_at)
      SELECT
        coalesce(max(CASE WHEN user_id LIKE 'google:%' THEN user_id END), min(user_id)),
        lower(trim(email)), max(display_name), min(created_at), max(updated_at)
      FROM workspace_members
      WHERE status = 'active' AND user_id IS NOT NULL AND trim(coalesce(email, '')) <> ''
      GROUP BY lower(trim(email))`),
    d1.prepare(`INSERT OR IGNORE INTO auth_identities
      (id, user_id, provider, provider_subject, email, created_at, last_used_at)
      SELECT lower(hex(randomblob(16))), user_id, 'google', substr(user_id, 8), lower(trim(email)), created_at, updated_at
      FROM workspace_members
      WHERE status = 'active' AND user_id LIKE 'google:%' AND trim(coalesce(email, '')) <> ''`),
    d1.prepare(`INSERT OR IGNORE INTO workspace_invitations
      (id, workspace_id, email, display_name, role, token_hash, status, delivery_status,
       invited_by_user_id, expires_at, created_at, updated_at)
      SELECT id, workspace_id, lower(trim(email)), display_name, role, '', 'pending', 'not_sent',
        coalesce(invited_by_user_id, (SELECT owner_user_id FROM workspaces WHERE workspaces.id = workspace_members.workspace_id), 'legacy'),
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+30 days'), created_at, updated_at
      FROM workspace_members
      WHERE status = 'invited' AND trim(coalesce(email, '')) <> ''`),
    d1.prepare("DELETE FROM workspace_members WHERE status = 'invited'"),
    d1.prepare(`DELETE FROM workspace_members
      WHERE user_id = ? AND EXISTS (
        SELECT 1 FROM workspace_members AS canonical
        WHERE canonical.workspace_id = workspace_members.workspace_id
          AND canonical.user_id = ?
          AND canonical.status = 'active'
      )`).bind(duplicateWorkspaceId, canonicalPodongUserId),
    d1.prepare("UPDATE workspace_members SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE workspace_members SET invited_by_user_id = ? WHERE invited_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE workspace_invitations SET invited_by_user_id = ? WHERE invited_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE workspace_invitations SET accepted_by_user_id = ? WHERE accepted_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE workspaces SET owner_user_id = ? WHERE owner_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE workspaces SET deletion_requested_by_user_id = ? WHERE deletion_requested_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE workspace_groups SET created_by_user_id = ? WHERE created_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE items SET created_by_user_id = ? WHERE created_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE kr_data_connections SET created_by_user_id = ? WHERE created_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE project_templates SET created_by_user_id = ? WHERE created_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE slack_automations SET created_by_user_id = ? WHERE created_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE trash_records SET created_by_user_id = ? WHERE created_by_user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE integration_tokens SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE mcp_oauth_codes SET authorization_json = replace(authorization_json, ?, ?) WHERE instr(authorization_json, ?) > 0")
      .bind(duplicateWorkspaceId, canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE ai_usage_events SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE google_connections SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE google_oauth_states SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE google_calendar_events SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE slack_connections SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("UPDATE slack_oauth_states SET user_id = ? WHERE user_id = ?").bind(canonicalPodongUserId, duplicateWorkspaceId),
    d1.prepare("DELETE FROM user_workspace_preferences WHERE user_id = ?").bind(duplicateWorkspaceId),
    d1.prepare(`INSERT INTO user_workspace_preferences (user_id, active_workspace_id, updated_at)
      SELECT ?, ?, CURRENT_TIMESTAMP
      WHERE EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'
      )
      ON CONFLICT(user_id) DO UPDATE SET active_workspace_id = excluded.active_workspace_id, updated_at = excluded.updated_at`)
      .bind(canonicalPodongUserId, allVibeWorkspaceId, allVibeWorkspaceId, canonicalPodongUserId),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_personal_owner ON workspaces(owner_user_id) WHERE kind = 'personal'"),
    d1.prepare("INSERT INTO app_migrations (id, applied_at) VALUES (?, CURRENT_TIMESTAMP)").bind(migrationId),
    d1.prepare("PRAGMA optimize"),
  ]);
}

export async function ensureWorkspace(ownerId: string) {
  let ready = workspaceReady.get(ownerId);
  if (!ready) {
    ready = (async () => {
      await ensureSchema();
      if (await workspaceInitializationIsCurrent(ownerId)) return;
      await migrateLegacyHierarchy(ownerId);
      await removeLegacySeedWorkspaceData(ownerId);
      await seedProjectExecutionProperties(ownerId);
      await migrateLegacyItemAssignments(ownerId);
      await ensureActiveOkrCycle(ownerId);
      const general = await ensureGeneralRoutine(ownerId);
      await migrateInboxTasksToGeneral(ownerId, general.id);
      await migratePersonalWorkspaceAssignments(ownerId);
    })();
    workspaceReady.set(ownerId, ready);
    void ready.catch(() => workspaceReady.delete(ownerId));
  }
  await ready;
}

function generalRoutineId(ownerId: string) {
  return `general-${ownerId}`;
}

export async function ensureGeneralRoutine(ownerId: string) {
  const now = new Date().toISOString();
  await getDb().insert(routines).values({
    id: generalRoutineId(ownerId),
    ownerId,
    systemKey: GENERAL_ROUTINE_SYSTEM_KEY,
    assigneeMemberId: null,
    title: "General",
    description: "Project나 개별 Routine에 속하지 않는 일반 업무",
    cadence: "daily",
    active: true,
    sortOrder: -1000,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const [general] = await getDb()
    .select()
    .from(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.systemKey, GENERAL_ROUTINE_SYSTEM_KEY)))
    .limit(1);
  if (!general) throw new Error("General routine could not be initialized");
  return general;
}

async function migrateInboxTasksToGeneral(ownerId: string, routineId: string) {
  await getDb().update(items).set({
    routineId,
    cycleId: null,
    status: "todo",
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(items.ownerId, ownerId),
    eq(items.kind, "task"),
    isNull(items.parentId),
    isNull(items.routineId),
  ));
  await getDb().update(items).set({ status: "todo", updatedAt: new Date().toISOString() })
    .where(and(eq(items.ownerId, ownerId), eq(items.status, "inbox")));
  await getDb().update(items).set({ archivedFromStatus: "todo", updatedAt: new Date().toISOString() })
    .where(and(eq(items.ownerId, ownerId), eq(items.archivedFromStatus, "inbox")));
  await getDb().update(slackAutomations).set({ triggerStatus: "todo", updatedAt: new Date().toISOString() })
    .where(and(eq(slackAutomations.ownerId, ownerId), eq(slackAutomations.triggerStatus, "inbox")));
}

async function migratePersonalWorkspaceAssignments(ownerId: string) {
  const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, ownerId)).limit(1);
  if (!workspace || workspace.kind !== "personal") return;
  const members = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, ownerId),
    eq(workspaceMembers.status, "active"),
  ));
  if (members.length !== 1) return;
  const memberId = members[0].id;
  const d1 = (env as RuntimeEnv).DB;
  const now = new Date().toISOString();
  await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO item_assignments
      (id, owner_id, item_id, member_id, role, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), owner_id, id, ?,
        CASE kind WHEN 'project' THEN 'project_dri' ELSE 'task_assignee' END, ?, ?
      FROM items
      WHERE owner_id = ? AND kind IN ('project', 'task') AND archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM item_assignments AS assignment
          WHERE assignment.owner_id = items.owner_id AND assignment.item_id = items.id
            AND assignment.role = CASE items.kind WHEN 'project' THEN 'project_dri' ELSE 'task_assignee' END
        )`).bind(memberId, now, now, ownerId),
    d1.prepare(`UPDATE routines SET assignee_member_id = ?, updated_at = ?
      WHERE owner_id = ? AND system_key IS NULL AND assignee_member_id IS NULL`).bind(memberId, now, ownerId),
  ]);
}

async function workspaceInitializationIsCurrent(ownerId: string) {
  // Keep the cold-path initialization audit to one D1 round trip.
  const executionPropertyNames = DEFAULT_PROJECT_EXECUTION_PROPERTIES.map((property) => property.name);
  const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");
  const row = await (env as RuntimeEnv).DB.prepare(`SELECT
      (SELECT COUNT(*) FROM property_definitions
        WHERE owner_id = ? AND name IN (${placeholders(executionPropertyNames)})) AS property_count,
      EXISTS(SELECT 1 FROM routines
        WHERE owner_id = ? AND system_key = ?) AS general_exists,
      EXISTS(SELECT 1 FROM items
        WHERE owner_id = ? AND title IN (${placeholders(LEGACY_SEED_ITEM_TITLES)})) AS seed_item_exists,
      EXISTS(SELECT 1 FROM routines
        WHERE owner_id = ? AND title IN (${placeholders(LEGACY_SEED_ROUTINE_TITLES)})) AS seed_routine_exists,
      EXISTS(SELECT 1
      FROM items AS current_item
      WHERE current_item.owner_id = ? AND (
        current_item.kind = 'action'
        OR (current_item.kind = 'project' AND current_item.id LIKE 'legacy-project-%' AND current_item.source = 'migration')
        OR (current_item.kind = 'task' AND current_item.parent_id IS NULL AND current_item.routine_id IS NULL)
        OR (current_item.kind = 'task' AND current_item.parent_id IN (
          SELECT parent_item.id FROM items AS parent_item
          WHERE parent_item.owner_id = current_item.owner_id AND parent_item.kind = 'initiative'
        ))
      )
      LIMIT 1) AS legacy_hierarchy_exists`).bind(
    ownerId,
    ...executionPropertyNames,
    ownerId,
    GENERAL_ROUTINE_SYSTEM_KEY,
    ownerId,
    ...LEGACY_SEED_ITEM_TITLES,
    ownerId,
    ...LEGACY_SEED_ROUTINE_TITLES,
    ownerId,
  ).first<{
    property_count: number;
    general_exists: number;
    seed_item_exists: number;
    seed_routine_exists: number;
    legacy_hierarchy_exists: number;
  }>();
  return Number(row?.property_count ?? 0) === executionPropertyNames.length
    && Boolean(row?.general_exists)
    && !row?.seed_item_exists
    && !row?.seed_routine_exists
    && !row?.legacy_hierarchy_exists;
}

export async function listOkrCycles(ownerId: string) {
  await ensureSchema();
  const rows = await getDb()
    .select()
    .from(okrCycles)
    .where(eq(okrCycles.ownerId, ownerId))
    .orderBy(desc(okrCycles.version), desc(okrCycles.createdAt));
  return rows.map(serializeOkrCycle);
}

export async function getActiveOkrCycle(ownerId: string) {
  await ensureSchema();
  return ensureActiveOkrCycle(ownerId);
}

export async function createOkrCycle(ownerId: string, input: { name?: string; department?: string; startDate?: string; endDate?: string; status?: OkrCycleStatus }) {
  await ensureSchema();
  const existing = await getDb().select().from(okrCycles).where(eq(okrCycles.ownerId, ownerId));
  const version = (existing.reduce((max, cycle) => Math.max(max, cycle.version), 0) || 0) + 1;
  const period = defaultQuarterPeriod(new Date());
  const [created] = await getDb()
    .insert(okrCycles)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      name: normalizeCycleName(input.name, version, period),
      department: input.department?.trim() ?? "",
      version,
      startDate: input.startDate || period.startDate,
      endDate: input.endDate || period.endDate,
      status: input.status ?? "planned",
    })
    .returning();
  return serializeOkrCycle(created);
}

export async function updateOkrCycle(ownerId: string, id: string, patch: Partial<{ name: string; department: string; startDate: string; endDate: string; status: OkrCycleStatus }>) {
  await ensureSchema();
  if (patch.status !== undefined && !OKR_CYCLE_STATUSES.includes(patch.status)) throw new Error("Unsupported OKR cycle status");
  if (patch.status === "active") {
    await getDb()
      .update(okrCycles)
      .set({ status: "planned", updatedAt: new Date().toISOString() })
      .where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.status, "active")));
  }
  const values = {
    name: patch.name?.trim(),
    department: patch.department?.trim(),
    startDate: patch.startDate,
    endDate: patch.endDate,
    status: patch.status,
    updatedAt: new Date().toISOString(),
  };
  const [updated] = await getDb()
    .update(okrCycles)
    .set(values)
    .where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, id)))
    .returning();
  if (!updated) throw new Error("OKR cycle not found");
  return serializeOkrCycle(updated);
}

export async function deleteOkrCycle(ownerId: string, id: string) {
  await ensureSchema();
  const [[target], [countRow]] = await Promise.all([
    getDb().select().from(okrCycles).where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, id))).limit(1),
    getDb().select({ count: sql<number>`count(*)` }).from(okrCycles).where(eq(okrCycles.ownerId, ownerId)),
  ]);
  if (!target) throw new Error("OKR cycle not found");
  if ((countRow?.count ?? 0) <= 1) throw new Error("At least one OKR file is required");

  const { createWorkspaceBackup } = await import("@/lib/workspace-backups");
  await createWorkspaceBackup(env, ownerId, "before_okr_delete");

  await getDb()
    .update(items)
    .set({ cycleId: null, updatedAt: new Date().toISOString() })
    .where(and(eq(items.ownerId, ownerId), eq(items.cycleId, id)));
  await getDb().delete(okrCycles).where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, id)));

  let nextActiveId: string | null = null;
  if (target.status === "active") {
    const [nextCycle] = await getDb()
      .select()
      .from(okrCycles)
      .where(eq(okrCycles.ownerId, ownerId))
      .orderBy(desc(okrCycles.version), desc(okrCycles.createdAt))
      .limit(1);
    if (nextCycle) {
      nextActiveId = nextCycle.id;
      await getDb()
        .update(okrCycles)
        .set({ status: "active", updatedAt: new Date().toISOString() })
        .where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, nextCycle.id)));
    }
  }

  return { deletedId: id, nextActiveId };
}

export async function cleanupWorkspaceExecutionData(ownerId: string, createdByUserId: string | null = null) {
  await ensureSchema();
  const { createWorkspaceBackup } = await import("@/lib/workspace-backups");
  await createWorkspaceBackup(env, ownerId, "before_cleanup", createdByUserId);
  const [itemCount, routineCount, cycleCount] = await Promise.all([
    getDb().select({ count: sql<number>`count(*)` }).from(items).where(eq(items.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(routines).where(eq(routines.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(okrCycles).where(eq(okrCycles.ownerId, ownerId)),
  ]);
  const protectedBefore = await protectedWorkspaceCounts(ownerId);
  const archivedRecord = await archiveWorkspaceExecutionData(ownerId, createdByUserId);

  await getDb().delete(slackAutomationDeliveries).where(eq(slackAutomationDeliveries.ownerId, ownerId));
  await getDb().delete(checklistItems).where(eq(checklistItems.ownerId, ownerId));
  await getDb().delete(itemAssignments).where(eq(itemAssignments.ownerId, ownerId));
  await getDb().delete(projectHiddenProperties).where(eq(projectHiddenProperties.ownerId, ownerId));
  await getDb().delete(itemPropertyValues).where(eq(itemPropertyValues.ownerId, ownerId));
  await getDb().delete(googleCalendarEvents).where(eq(googleCalendarEvents.ownerId, ownerId));
  await getDb().delete(activityLog).where(eq(activityLog.ownerId, ownerId));
  await getDb().delete(dailyScrums).where(eq(dailyScrums.ownerId, ownerId));
  await getDb().delete(routineCompletions).where(eq(routineCompletions.ownerId, ownerId));
  await getDb().delete(routines).where(eq(routines.ownerId, ownerId));
  await getDb().delete(items).where(eq(items.ownerId, ownerId));
  await getDb().delete(okrCycles).where(eq(okrCycles.ownerId, ownerId));

  const activeCycle = await ensureActiveOkrCycle(ownerId);
  const protectedAfter = await protectedWorkspaceCounts(ownerId);
  for (const key of Object.keys(protectedBefore) as Array<keyof typeof protectedBefore>) {
    if (protectedAfter[key] < protectedBefore[key]) {
      throw new Error("Cleanup touched protected workspace data");
    }
  }
  return {
    deletedItems: itemCount[0]?.count ?? 0,
    deletedRoutines: routineCount[0]?.count ?? 0,
    deletedCycles: cycleCount[0]?.count ?? 0,
    archivedRecord: archivedRecord ? serializeTrashRecord(archivedRecord) : null,
    protectedData: protectedAfter,
    activeCycle: serializeOkrCycle(activeCycle),
  };
}

async function archiveWorkspaceExecutionData(ownerId: string, createdByUserId: string | null) {
  const [
    itemRows,
    itemAssignmentRows,
    propertyValueRows,
    hiddenPropertyRows,
    checklistRows,
    calendarEventRows,
    activityRows,
    scrumRows,
    routineCompletionRows,
    routineRows,
    cycleRows,
  ] = await Promise.all([
    getDb().select().from(items).where(eq(items.ownerId, ownerId)),
    getDb().select().from(itemAssignments).where(eq(itemAssignments.ownerId, ownerId)),
    getDb().select().from(itemPropertyValues).where(eq(itemPropertyValues.ownerId, ownerId)),
    getDb().select().from(projectHiddenProperties).where(eq(projectHiddenProperties.ownerId, ownerId)),
    getDb().select().from(checklistItems).where(eq(checklistItems.ownerId, ownerId)),
    getDb().select().from(googleCalendarEvents).where(eq(googleCalendarEvents.ownerId, ownerId)),
    getDb().select().from(activityLog).where(eq(activityLog.ownerId, ownerId)),
    getDb().select().from(dailyScrums).where(eq(dailyScrums.ownerId, ownerId)),
    getDb().select().from(routineCompletions).where(eq(routineCompletions.ownerId, ownerId)),
    getDb().select().from(routines).where(eq(routines.ownerId, ownerId)),
    getDb().select().from(okrCycles).where(eq(okrCycles.ownerId, ownerId)),
  ]);
  if (!itemRows.length && !routineRows.length && !cycleRows.length && !scrumRows.length) return null;

  const archivedAt = new Date().toISOString();
  const [record] = await getDb()
    .insert(trashRecords)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      category: "workspace_cleanup",
      title: `OKR cleanup ${archivedAt.slice(0, 10)}`,
      payload: JSON.stringify({
        items: itemRows,
        itemAssignments: itemAssignmentRows,
        itemPropertyValues: propertyValueRows,
        projectHiddenProperties: hiddenPropertyRows,
        checklistItems: checklistRows,
        googleCalendarEvents: calendarEventRows,
        activityLog: activityRows,
        dailyScrums: scrumRows,
        routineCompletions: routineCompletionRows,
        routines: routineRows,
        okrCycles: cycleRows,
      }),
      itemCount: itemRows.length,
      routineCount: routineRows.length,
      cycleCount: cycleRows.length,
      createdByUserId,
      archivedAt,
    })
    .returning();
  return record;
}

async function protectedWorkspaceCounts(ownerId: string) {
  const [
    workspaceCount,
    memberCount,
    groupCount,
    groupMemberCount,
    propertyCount,
    googleConnectionCount,
    slackConnectionCount,
    slackAutomationCount,
    trashRecordCount,
  ] = await Promise.all([
    getDb().select({ count: sql<number>`count(*)` }).from(workspaces).where(eq(workspaces.id, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(workspaceGroups).where(eq(workspaceGroups.workspaceId, ownerId)),
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(workspaceGroupMembers)
      .innerJoin(workspaceGroups, eq(workspaceGroupMembers.groupId, workspaceGroups.id))
      .where(eq(workspaceGroups.workspaceId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(propertyDefinitions).where(eq(propertyDefinitions.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(googleConnections).where(eq(googleConnections.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(slackConnections).where(eq(slackConnections.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(slackAutomations).where(eq(slackAutomations.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(trashRecords).where(eq(trashRecords.ownerId, ownerId)),
  ]);

  return {
    workspaces: workspaceCount[0]?.count ?? 0,
    members: memberCount[0]?.count ?? 0,
    groups: groupCount[0]?.count ?? 0,
    groupMembers: groupMemberCount[0]?.count ?? 0,
    properties: propertyCount[0]?.count ?? 0,
    googleConnections: googleConnectionCount[0]?.count ?? 0,
    slackConnections: slackConnectionCount[0]?.count ?? 0,
    slackAutomations: slackAutomationCount[0]?.count ?? 0,
    trashRecords: trashRecordCount[0]?.count ?? 0,
  };
}

export async function listTrashRecords(ownerId: string) {
  await ensureSchema();
  const rows = await getDb()
    .select()
    .from(trashRecords)
    .where(eq(trashRecords.ownerId, ownerId))
    .orderBy(desc(trashRecords.archivedAt))
    .limit(100);
  return rows.map(serializeTrashRecord);
}

export async function deleteTrashRecord(ownerId: string, id: string) {
  await ensureSchema();
  const [record] = await getDb()
    .delete(trashRecords)
    .where(and(eq(trashRecords.ownerId, ownerId), eq(trashRecords.id, id)))
    .returning();
  if (!record) throw new Error("Trash record not found");
  return serializeTrashRecord(record);
}

type WorkspaceCleanupArchive = {
  items: Array<typeof items.$inferInsert>;
  itemAssignments: Array<typeof itemAssignments.$inferInsert>;
  itemPropertyValues: Array<typeof itemPropertyValues.$inferInsert>;
  projectHiddenProperties: Array<typeof projectHiddenProperties.$inferInsert>;
  checklistItems: Array<typeof checklistItems.$inferInsert>;
  googleCalendarEvents: Array<typeof googleCalendarEvents.$inferInsert>;
  activityLog: Array<typeof activityLog.$inferInsert>;
  dailyScrums: Array<typeof dailyScrums.$inferInsert>;
  routineCompletions: Array<typeof routineCompletions.$inferInsert>;
  routines: Array<typeof routines.$inferInsert>;
  okrCycles: Array<typeof okrCycles.$inferInsert>;
};

export async function restoreTrashRecord(ownerId: string, id: string) {
  const [record] = await getDb().select().from(trashRecords).where(and(eq(trashRecords.ownerId, ownerId), eq(trashRecords.id, id))).limit(1);
  if (!record) throw new Error("Trash record not found");
  if (record.category !== "workspace_cleanup") throw new Error("This trash record cannot be restored");

  const payload = JSON.parse(record.payload) as Partial<WorkspaceCleanupArchive>;
  const [currentItems, currentRoutines, currentScrums] = await Promise.all([
    getDb().select({ count: sql<number>`count(*)` }).from(items).where(eq(items.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(routines).where(eq(routines.ownerId, ownerId)),
    getDb().select({ count: sql<number>`count(*)` }).from(dailyScrums).where(eq(dailyScrums.ownerId, ownerId)),
  ]);
  if ((currentItems[0]?.count ?? 0) > 0 || (currentRoutines[0]?.count ?? 0) > 0 || (currentScrums[0]?.count ?? 0) > 0) {
    throw new Error("Restore requires an empty execution workspace");
  }

  await getDb().delete(okrCycles).where(eq(okrCycles.ownerId, ownerId));
  if (payload.okrCycles?.length) await getDb().insert(okrCycles).values(payload.okrCycles).onConflictDoNothing();
  if (payload.routines?.length) await getDb().insert(routines).values(payload.routines).onConflictDoNothing();
  if (payload.items?.length) await getDb().insert(items).values(payload.items).onConflictDoNothing();

  await Promise.all([
    payload.itemAssignments?.length ? getDb().insert(itemAssignments).values(payload.itemAssignments).onConflictDoNothing() : Promise.resolve(),
    payload.itemPropertyValues?.length ? getDb().insert(itemPropertyValues).values(payload.itemPropertyValues).onConflictDoNothing() : Promise.resolve(),
    payload.projectHiddenProperties?.length ? getDb().insert(projectHiddenProperties).values(payload.projectHiddenProperties).onConflictDoNothing() : Promise.resolve(),
    payload.checklistItems?.length ? getDb().insert(checklistItems).values(payload.checklistItems).onConflictDoNothing() : Promise.resolve(),
    payload.googleCalendarEvents?.length ? getDb().insert(googleCalendarEvents).values(payload.googleCalendarEvents).onConflictDoNothing() : Promise.resolve(),
    payload.activityLog?.length ? getDb().insert(activityLog).values(payload.activityLog).onConflictDoNothing() : Promise.resolve(),
    payload.dailyScrums?.length ? getDb().insert(dailyScrums).values(payload.dailyScrums).onConflictDoNothing() : Promise.resolve(),
    payload.routineCompletions?.length ? getDb().insert(routineCompletions).values(payload.routineCompletions).onConflictDoNothing() : Promise.resolve(),
  ]);
  await getDb().delete(trashRecords).where(and(eq(trashRecords.ownerId, ownerId), eq(trashRecords.id, id)));
  return serializeTrashRecord(record);
}

export function serializeTrashRecord(record: TrashRecord) {
  return {
    id: record.id,
    category: record.category,
    title: record.title,
    itemCount: record.itemCount,
    routineCount: record.routineCount,
    cycleCount: record.cycleCount,
    archivedAt: record.archivedAt,
  };
}

async function ensureActiveOkrCycle(ownerId: string) {
  const [active] = await getDb()
    .select()
    .from(okrCycles)
    .where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.status, "active")))
    .orderBy(desc(okrCycles.version))
    .limit(1);
  if (active) return active;

  const existing = await getDb().select().from(okrCycles).where(eq(okrCycles.ownerId, ownerId));
  const version = (existing.reduce((max, cycle) => Math.max(max, cycle.version), 0) || 0) + 1;
  const period = defaultQuarterPeriod(new Date());
  const [created] = await getDb()
    .insert(okrCycles)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      name: normalizeCycleName(undefined, version, period),
      version,
      startDate: period.startDate,
      endDate: period.endDate,
      status: "active",
    })
    .returning();
  return created;
}

async function defaultCycleIdForKind(ownerId: string, kind: ItemKind) {
  if (!okrKinds.has(kind)) return null;
  const cycle = await ensureActiveOkrCycle(ownerId);
  return cycle.id;
}

function serializeOkrCycle(cycle: OkrCycle) {
  return {
    id: cycle.id,
    name: cycle.name,
    department: cycle.department,
    version: cycle.version,
    startDate: cycle.startDate,
    endDate: cycle.endDate,
    status: cycle.status as OkrCycleStatus,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
  };
}

function defaultQuarterPeriod(date: Date) {
  const year = date.getFullYear();
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3, 0));
  return {
    year,
    quarter,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function normalizeCycleName(name: string | undefined, version: number, period: ReturnType<typeof defaultQuarterPeriod>) {
  return name?.trim() || `${period.year} Q${period.quarter} OKR v${version}`;
}

export async function getWorkspaceRules(ownerId: string) {
  const [saved] = await getDb().select().from(workspaceRules).where(eq(workspaceRules.workspaceId, ownerId)).limit(1);
  if (saved) return serializeWorkspaceRules(saved);
  const [created] = await getDb()
    .insert(workspaceRules)
    .values({
      workspaceId: ownerId,
      captureInstruction: "대화에서 나온 일은 우선 있는 그대로 잡고, 실행 구조가 명확할 때만 Project 또는 독립 Routine 아래 Task로 연결합니다.",
      structureInstruction: "OKR은 Objective > Key Result > Initiative > Project > Task로 정리합니다. Routine은 Project처럼 Task를 담는 실행 컨테이너지만 OKR 계층과 독립적으로 관리합니다.",
      routineInstruction: "Routine은 트리거 포인트, 어디서/어떤 도구로, 무엇을 어떻게 할지까지 함께 정리합니다.",
      defaultPriority: "medium",
      defaultCadence: "weekly",
      reviewBeforeCreate: true,
      configured: false,
    })
    .returning();
  return serializeWorkspaceRules(created);
}

export async function saveWorkspaceRules(ownerId: string, input: WorkspaceRuleInput) {
  const current = await getWorkspaceRules(ownerId);
  const defaultPriority = input.defaultPriority ?? current.defaultPriority;
  const defaultCadence = input.defaultCadence ?? current.defaultCadence;
  if (!ITEM_PRIORITIES.includes(defaultPriority)) throw new Error("Unsupported default priority");
  if (!ITEM_CADENCES.includes(defaultCadence)) throw new Error("Unsupported default cadence");
  const values = {
    captureInstruction: normalizeRuleText(input.captureInstruction ?? current.captureInstruction),
    structureInstruction: normalizeRuleText(input.structureInstruction ?? current.structureInstruction),
    routineInstruction: normalizeRuleText(input.routineInstruction ?? current.routineInstruction),
    defaultPriority,
    defaultCadence,
    reviewBeforeCreate: input.reviewBeforeCreate ?? current.reviewBeforeCreate,
    configured: input.configured ?? true,
    updatedAt: new Date().toISOString(),
  };
  const [saved] = await getDb()
    .insert(workspaceRules)
    .values({ workspaceId: ownerId, ...values })
    .onConflictDoUpdate({
      target: workspaceRules.workspaceId,
      set: values,
    })
    .returning();
  return serializeWorkspaceRules(saved);
}

function normalizeRuleText(value: string) {
  return value.trim().slice(0, 2000);
}

export function serializeWorkspaceRules(rule: WorkspaceRule) {
  return {
    workspaceId: rule.workspaceId,
    captureInstruction: rule.captureInstruction,
    structureInstruction: rule.structureInstruction,
    routineInstruction: rule.routineInstruction,
    defaultPriority: rule.defaultPriority as ItemPriority,
    defaultCadence: rule.defaultCadence as ItemCadence,
    reviewBeforeCreate: rule.reviewBeforeCreate,
    configured: rule.configured,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export async function getAiUsageSummary(ownerId: string, userId: string): Promise<AiUsageSummary> {
  await ensureSchema();
  const ownerAndUser = and(eq(aiUsageEvents.ownerId, ownerId), eq(aiUsageEvents.userId, userId));
  const [lifetime] = await getDb()
    .select({ spentWonMicros: sql<number>`coalesce(sum(${aiUsageEvents.estimatedCostWonMicros}), 0)` })
    .from(aiUsageEvents)
    .where(ownerAndUser);
  const [today] = await getDb()
    .select({ requestsToday: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(and(ownerAndUser, sql`${aiUsageEvents.createdAt} >= datetime('now', 'start of day')`));
  const [minute] = await getDb()
    .select({ requestsThisMinute: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(and(ownerAndUser, sql`${aiUsageEvents.createdAt} >= datetime('now', '-1 minute')`));
  return {
    spentWonMicros: Number(lifetime?.spentWonMicros ?? 0),
    requestsToday: Number(today?.requestsToday ?? 0),
    requestsThisMinute: Number(minute?.requestsThisMinute ?? 0),
  };
}

export async function recordAiUsageEvent(input: {
  ownerId: string;
  userId: string;
  model: string;
  source?: string;
  inputChars: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostWonMicros: number;
}) {
  await ensureSchema();
  await getDb().insert(aiUsageEvents).values({
    id: crypto.randomUUID(),
    ownerId: input.ownerId,
    userId: input.userId,
    model: input.model,
    source: input.source ?? "web",
    inputChars: Math.max(0, Math.round(input.inputChars)),
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    estimatedCostWonMicros: Math.max(0, Math.round(input.estimatedCostWonMicros)),
  });
}

export async function createGoogleOAuthState(ownerId: string, userId: string, returnTo = "/") {
  await ensureSchema();
  const state = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const d1 = (env as RuntimeEnv).DB;
  await d1.batch([
    d1.prepare("DELETE FROM google_oauth_states WHERE expires_at <= ?").bind(now),
    d1.prepare(`INSERT INTO google_oauth_states (state, owner_id, user_id, return_to, expires_at)
      VALUES (?, ?, ?, ?, ?)`).bind(state, ownerId, userId, normalizeReturnTo(returnTo), expiresAt),
  ]);
  return state;
}

export async function consumeGoogleOAuthState(state: string) {
  await ensureSchema();
  const [saved] = await getDb().delete(googleOAuthStates).where(eq(googleOAuthStates.state, state)).returning();
  if (!saved) return null;
  if (saved.expiresAt <= new Date().toISOString()) return null;
  return saved;
}

export async function getGoogleConnection(ownerId: string, userId: string) {
  await ensureSchema();
  const [connection] = await getDb()
    .select()
    .from(googleConnections)
    .where(and(eq(googleConnections.ownerId, ownerId), eq(googleConnections.userId, userId)))
    .limit(1);
  return connection ?? null;
}

export async function saveGoogleConnection(input: {
  ownerId: string;
  userId: string;
  googleAccountId: string;
  email: string;
  displayName: string;
  encryptedRefreshToken: string;
  scope: string;
}) {
  await ensureSchema();
  const now = new Date().toISOString();
  const values = {
    googleAccountId: input.googleAccountId,
    email: input.email,
    displayName: input.displayName,
    encryptedRefreshToken: input.encryptedRefreshToken,
    scope: input.scope,
    updatedAt: now,
  };
  const [connection] = await getDb()
    .insert(googleConnections)
    .values({
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      userId: input.userId,
      connectedAt: now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [googleConnections.ownerId, googleConnections.userId],
      set: values,
    })
    .returning();
  return connection;
}

export async function deleteGoogleConnection(ownerId: string, userId: string) {
  await ensureSchema();
  const current = await getGoogleConnection(ownerId, userId);
  await getDb().delete(googleConnections).where(and(eq(googleConnections.ownerId, ownerId), eq(googleConnections.userId, userId)));
  return current;
}

export function serializeGoogleConnection(connection: GoogleConnection | null, configured: boolean) {
  return {
    configured,
    connected: Boolean(connection),
    email: connection?.email ?? null,
    displayName: connection?.displayName ?? null,
    scope: connection?.scope ?? "",
    connectedAt: connection?.connectedAt ?? null,
    updatedAt: connection?.updatedAt ?? null,
  };
}

export async function getGoogleCalendarEvent(ownerId: string, userId: string, itemId: string) {
  await ensureSchema();
  const [event] = await getDb()
    .select()
    .from(googleCalendarEvents)
    .where(and(eq(googleCalendarEvents.ownerId, ownerId), eq(googleCalendarEvents.userId, userId), eq(googleCalendarEvents.itemId, itemId)))
    .limit(1);
  return event ?? null;
}

export async function saveGoogleCalendarEvent(input: {
  ownerId: string;
  userId: string;
  itemId: string;
  calendarId: string;
  googleEventId: string;
  htmlLink: string;
}) {
  await ensureSchema();
  const syncedAt = new Date().toISOString();
  const values = {
    calendarId: input.calendarId,
    googleEventId: input.googleEventId,
    htmlLink: input.htmlLink,
    syncedAt,
  };
  const [event] = await getDb()
    .insert(googleCalendarEvents)
    .values({
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      userId: input.userId,
      itemId: input.itemId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [googleCalendarEvents.ownerId, googleCalendarEvents.userId, googleCalendarEvents.itemId],
      set: values,
    })
    .returning();
  return event;
}

export async function createSlackOAuthState(ownerId: string, userId: string, returnTo = "/?settings=workspace&tab=integrations") {
  await ensureSchema();
  const state = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await getDb().delete(slackOAuthStates).where(lte(slackOAuthStates.expiresAt, new Date().toISOString()));
  await getDb().insert(slackOAuthStates).values({
    state,
    ownerId,
    userId,
    returnTo: normalizeReturnTo(returnTo),
    expiresAt,
  });
  return state;
}

export async function consumeSlackOAuthState(state: string) {
  await ensureSchema();
  const [saved] = await getDb().select().from(slackOAuthStates).where(eq(slackOAuthStates.state, state)).limit(1);
  if (!saved) return null;
  await getDb().delete(slackOAuthStates).where(eq(slackOAuthStates.state, state));
  if (saved.expiresAt <= new Date().toISOString()) return null;
  return saved;
}

export async function hasWorkspaceAdminAccess(workspaceId: string, userId: string) {
  await ensureSchema();
  const [membership] = await getDb()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaces.scheduledDeletionAt),
    ))
    .limit(1);
  return membership?.role === "owner" || membership?.role === "admin";
}

export async function getSlackConnection(ownerId: string) {
  await ensureSchema();
  const [row] = await getDb()
    .select({ connection: slackConnections })
    .from(slackConnections)
    .innerJoin(workspaces, eq(slackConnections.ownerId, workspaces.id))
    .where(and(
      eq(slackConnections.ownerId, ownerId),
      isNull(workspaces.scheduledDeletionAt),
    ))
    .orderBy(desc(slackConnections.updatedAt))
    .limit(1);
  return row?.connection ?? null;
}

export async function getSlackConnectionByTeam(teamId: string) {
  await ensureSchema();
  const [row] = await getDb()
    .select({ connection: slackConnections })
    .from(slackConnections)
    .innerJoin(workspaces, eq(slackConnections.ownerId, workspaces.id))
    .where(and(
      eq(slackConnections.teamId, teamId),
      isNull(workspaces.scheduledDeletionAt),
    ))
    .limit(1);
  return row?.connection ?? null;
}

export class SlackWorkspaceConnectionError extends Error {
  readonly code: "workspace_already_connected";

  constructor(code: "workspace_already_connected", message: string) {
    super(message);
    this.name = "SlackWorkspaceConnectionError";
    this.code = code;
  }
}

export async function saveSlackConnection(input: {
  ownerId: string;
  userId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  appId: string;
  encryptedBotToken: string;
  scope: string;
}) {
  await ensureSchema();
  const previousConnection = await getSlackConnection(input.ownerId);
  const [teamConnection] = await getDb().select().from(slackConnections).where(eq(slackConnections.teamId, input.teamId)).limit(1);
  if (teamConnection && teamConnection.ownerId !== input.ownerId) {
    throw new SlackWorkspaceConnectionError(
      "workspace_already_connected",
      "이 Slack 워크스페이스는 다른 OKRI 워크스페이스에 연결되어 있습니다. 기존 연결을 해제한 뒤 다시 시도해 주세요.",
    );
  }
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM slack_connections WHERE owner_id = ?").bind(input.ownerId),
      env.DB.prepare(`INSERT INTO slack_connections (
        id, owner_id, user_id, team_id, team_name, bot_user_id, app_id,
        encrypted_bot_token, scope, connected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          crypto.randomUUID(), input.ownerId, input.userId, input.teamId, input.teamName,
          input.botUserId, input.appId, input.encryptedBotToken, input.scope, now, now,
        ),
    ]);
  } catch (error) {
    const [conflict] = await getDb().select().from(slackConnections).where(eq(slackConnections.teamId, input.teamId)).limit(1);
    if (conflict && conflict.ownerId !== input.ownerId) {
      throw new SlackWorkspaceConnectionError(
        "workspace_already_connected",
        "이 Slack 워크스페이스는 다른 OKRI 워크스페이스에 연결되어 있습니다. 기존 연결을 해제한 뒤 다시 시도해 주세요.",
      );
    }
    throw error;
  }
  const connection = await getSlackConnection(input.ownerId);
  if (!connection) throw new Error("Slack 연결 저장 결과를 확인하지 못했습니다.");
  return { connection, previousConnection };
}

export async function deleteSlackConnection(ownerId: string, expectedConnectionId?: string) {
  await ensureSchema();
  const current = await getSlackConnection(ownerId);
  if (!current) return null;
  if (expectedConnectionId && current.id !== expectedConnectionId) throw new Error("Slack 연결이 변경되었습니다. 현재 연결을 확인해 주세요.");
  const result = expectedConnectionId
    ? await env.DB.prepare(`DELETE FROM slack_connections WHERE owner_id = ? AND id = ?
        AND NOT EXISTS (SELECT 1 FROM slack_daily_reminders WHERE owner_id = ?)
        AND NOT EXISTS (SELECT 1 FROM slack_daily_settings WHERE owner_id = ? AND enabled = 1)`)
        .bind(ownerId, current.id, ownerId, ownerId).run()
    : await env.DB.prepare("DELETE FROM slack_connections WHERE owner_id = ? AND id = ?").bind(ownerId, current.id).run();
  if (!result.meta.changes) throw new Error("Slack 연결이 변경되었습니다. 현재 연결을 확인해 주세요.");
  return current;
}

export function serializeSlackConnection(connection: SlackConnection | null, urls: { redirectUrl: string; commandUrl: string; interactionUrl?: string; eventsUrl?: string }) {
  return {
    connected: Boolean(connection),
    teamName: connection?.teamName ?? null,
    teamId: connection?.teamId ?? null,
    botUserId: connection?.botUserId ?? null,
    scope: connection?.scope ?? "",
    connectedAt: connection?.connectedAt ?? null,
    updatedAt: connection?.updatedAt ?? null,
    redirectUrl: urls.redirectUrl,
    commandUrl: urls.commandUrl,
    interactionUrl: urls.interactionUrl ?? null,
    eventsUrl: urls.eventsUrl ?? null,
  };
}

export type SlackAutomationInput = {
  name?: string;
  triggerType?: string;
  triggerStatus?: string;
  channelId?: string;
  messageTemplate?: string;
  messageTemplateKind?: AutomationMessageKind;
  active?: boolean;
};

export async function listSlackAutomations(ownerId: string) {
  await ensureSchema();
  const rows = await getDb()
    .select()
    .from(slackAutomations)
    .where(eq(slackAutomations.ownerId, ownerId))
    .orderBy(desc(slackAutomations.createdAt));
  return rows.map(serializeSlackAutomation);
}

export async function listSlackAutomationDeliveries(ownerId: string, limit = 20) {
  await ensureSchema();
  const rows = await getDb()
    .select()
    .from(slackAutomationDeliveries)
    .where(eq(slackAutomationDeliveries.ownerId, ownerId))
    .orderBy(desc(slackAutomationDeliveries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map(serializeSlackAutomationDelivery);
}

export async function createSlackAutomation(ownerId: string, userId: string, input: SlackAutomationInput) {
  await ensureSchema();
  if (!await getSlackConnection(ownerId)) throw new Error("Slack을 먼저 연결해 주세요");
  const requestedTrigger = input.triggerType?.trim();
  const messageTemplateKind = input.messageTemplateKind ?? (input.messageTemplate?.trim() ? "custom" : "default");
  if (!["custom", "default", "blocked"].includes(messageTemplateKind)) throw new Error("지원하지 않는 메시지 종류입니다.");
  const values = validateSlackAutomationInput({
    ...input,
    messageTemplate: messageTemplateKind !== "custom" && requestedTrigger && isSlackAutomationTrigger(requestedTrigger)
      ? systemAutomationTemplate(messageTemplateKind, requestedTrigger) : input.messageTemplate,
  }, false);
  await validateSlackAutomationChannel(ownerId, values.channelId!);
  const now = new Date().toISOString();
  const [created] = await getDb().insert(slackAutomations).values({
    id: crypto.randomUUID(),
    ownerId,
    createdByUserId: userId,
    name: values.name!,
    triggerType: values.triggerType!,
    triggerStatus: values.triggerStatus!,
    channelId: values.channelId!,
    messageTemplate: values.messageTemplate!,
    messageTemplateKind,
    active: values.active ?? true,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return serializeSlackAutomation(created);
}

export async function updateSlackAutomation(ownerId: string, id: string, input: SlackAutomationInput) {
  await ensureSchema();
  const current = await getSlackAutomation(ownerId, id);
  if (!current) throw new Error("Slack 자동화를 찾을 수 없습니다");
  const messageTemplateKind = input.messageTemplateKind ?? (input.messageTemplate !== undefined && input.messageTemplate !== current.messageTemplate ? "custom" : current.messageTemplateKind) as AutomationMessageKind;
  if (!["custom", "default", "blocked"].includes(messageTemplateKind)) throw new Error("지원하지 않는 메시지 종류입니다.");
  const trigger = input.triggerType ?? current.triggerType;
  const next = validateSlackAutomationInput({
    name: input.name ?? current.name,
    triggerType: input.triggerType ?? current.triggerType,
    triggerStatus: input.triggerStatus ?? current.triggerStatus,
    channelId: input.channelId ?? current.channelId,
    messageTemplate: messageTemplateKind !== "custom" && isSlackAutomationTrigger(trigger)
      ? systemAutomationTemplate(messageTemplateKind, trigger) : input.messageTemplate ?? current.messageTemplate,
    active: input.active ?? current.active,
  }, false);
  if (next.channelId !== current.channelId || (next.active && !current.active)) await validateSlackAutomationChannel(ownerId, next.channelId!);
  const [updated] = await getDb().update(slackAutomations).set({
    name: next.name,
    triggerType: next.triggerType,
    triggerStatus: next.triggerStatus,
    channelId: next.channelId,
    messageTemplate: next.messageTemplate,
    messageTemplateKind,
    active: next.active,
    updatedAt: new Date().toISOString(),
  }).where(and(eq(slackAutomations.ownerId, ownerId), eq(slackAutomations.id, id))).returning();
  return serializeSlackAutomation(updated);
}

export async function deleteSlackAutomation(ownerId: string, id: string) {
  await ensureSchema();
  const [deleted] = await getDb().delete(slackAutomations)
    .where(and(eq(slackAutomations.ownerId, ownerId), eq(slackAutomations.id, id)))
    .returning();
  if (!deleted) throw new Error("Slack 자동화를 찾을 수 없습니다");
  return { deleted: true, id };
}

export async function testSlackAutomation(ownerId: string, id: string) {
  await ensureSchema();
  const automation = await getSlackAutomation(ownerId, id);
  if (!automation) throw new Error("Slack 자동화를 찾을 수 없습니다");
  if (!isSupportedTaskAutomation(automation.triggerType, automation.triggerStatus)) throw new Error("현재 Task 상태 모델에서는 사용할 수 없는 규칙입니다");
  const workspace = await getWorkspaceName(ownerId);
  const context: SlackAutomationContext = {
    title: "Slack 자동화 테스트 업무",
    status: automation.triggerStatus || "in_progress",
    fromStatus: "todo",
    priority: "high",
    kind: "task",
    workspace,
  };
  const delivery = await deliverSlackAutomation(automation, context, null, `test:${ownerId}:${automation.id}:${crypto.randomUUID()}`, "test");
  if (!delivery) throw new Error("테스트 전송을 시작하지 못했습니다");
  if (delivery.status !== "sent") throw new Error(delivery.error || "테스트 발송 결과를 확인하지 못했습니다.");
  return serializeSlackAutomationDelivery(delivery);
}

export async function dispatchSlackAutomationEvent(ownerId: string, event: {
  triggerType: SlackAutomationTrigger;
  item: Pick<PaceItem, "id" | "ownerId" | "kind" | "title" | "status" | "priority" | "updatedAt">;
  fromStatus?: string | null;
}) {
  if (event.item.kind !== "task" || event.item.ownerId !== ownerId) return;
  try {
    await ensureSchema();
    const automations = await getDb().select().from(slackAutomations).where(and(
      eq(slackAutomations.ownerId, ownerId),
      eq(slackAutomations.active, true),
      eq(slackAutomations.triggerType, event.triggerType),
    ));
    if (!automations.length) return;
    const workspace = await getWorkspaceName(ownerId);
    const context: SlackAutomationContext = {
      title: event.item.title,
      status: event.item.status,
      fromStatus: event.fromStatus,
      priority: event.item.priority,
      kind: event.item.kind,
      workspace,
    };
    for (const automation of automations) {
      if (!isSupportedTaskAutomation(automation.triggerType, automation.triggerStatus)) continue;
      if (!slackAutomationMatches(automation, { triggerType: event.triggerType, status: event.item.status })) continue;
      const eventKey = `${ownerId}:${event.triggerType}:${automation.id}:${event.item.id}:${event.fromStatus ?? ""}:${event.item.status}:${event.item.updatedAt}`;
      try { await deliverSlackAutomation(automation, context, event.item.id, eventKey, event.triggerType); }
      catch (error) { console.error("Slack automation delivery failed", automation.id, error instanceof Error ? error.message : "Unknown failure"); }
    }
  } catch (error) {
    console.error("Slack automation dispatch failed", error);
  }
}

function validateSlackAutomationInput(input: SlackAutomationInput, partial: boolean) {
  const name = input.name?.trim();
  if (!partial && !name) throw new Error("자동화 이름을 입력해 주세요");
  if (name && name.length > 80) throw new Error("자동화 이름은 80자 이하여야 합니다");
  const triggerType = input.triggerType?.trim();
  if (!partial && (!triggerType || !isSlackAutomationTrigger(triggerType))) throw new Error("지원하지 않는 트리거입니다");
  if (triggerType && !isSlackAutomationTrigger(triggerType)) throw new Error("지원하지 않는 트리거입니다");
  const triggerStatus = triggerType === "task_status_changed" ? input.triggerStatus?.trim() ?? "" : "";
  if (triggerStatus && !ITEM_STATUSES.includes(triggerStatus as ItemStatus)) throw new Error("지원하지 않는 업무 상태입니다");
  if (triggerType && !isSupportedTaskAutomation(triggerType, triggerStatus)) throw new Error("현재 Task 상태 모델에서는 사용할 수 없는 규칙입니다");
  const channelId = input.channelId === undefined && partial ? undefined : normalizeSlackChannelId(input.channelId ?? "");
  const messageTemplate = input.messageTemplate?.trim();
  if (!partial && !messageTemplate) throw new Error("Slack 메시지를 입력해 주세요");
  if (messageTemplate && messageTemplate.length > 3000) throw new Error("Slack 메시지는 3,000자 이하여야 합니다");
  return { name, triggerType, triggerStatus, channelId, messageTemplate, active: input.active };
}

async function getSlackAutomation(ownerId: string, id: string) {
  const [automation] = await getDb().select().from(slackAutomations)
    .where(and(eq(slackAutomations.ownerId, ownerId), eq(slackAutomations.id, id))).limit(1);
  return automation ?? null;
}

async function validateSlackAutomationChannel(ownerId: string, channelId: string) {
  const { canAutoJoinSlackChannel, listSlackChannels, slackApi, slackTokenForConnection } = await import("@/lib/slack-daily");
  const channels = await listSlackChannels(ownerId, { includeJoinablePublic: true });
  const channel = channels.find((value) => value.id === channelId);
  if (!channel) throw new Error("현재 워크스페이스의 공개 채널 또는 봇이 참여한 비공개·공유 채널을 선택해 주세요.");
  if (canAutoJoinSlackChannel(channel)) {
    const connection = await getSlackConnection(ownerId);
    if (!connection) throw new Error("Slack을 먼저 연결해 주세요.");
    await slackApi(await slackTokenForConnection(connection), "conversations.join", { channel: channelId });
  }
}

async function getWorkspaceName(ownerId: string) {
  const [workspace] = await getDb().select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ownerId)).limit(1);
  return workspace?.name ?? "OKRI";
}

async function deliverSlackAutomation(
  automation: SlackAutomation,
  context: SlackAutomationContext,
  itemId: string | null,
  eventKey: string,
  triggerType: string,
) {
  const now = new Date().toISOString();
  const t = await serverTranslator(await workspaceMessageLanguage(env.DB, automation.ownerId));
  const systemKind = automation.messageTemplateKind === "default" || automation.messageTemplateKind === "blocked" ? automation.messageTemplateKind : null;
  // Historical and custom templates have no reliable provenance. Never translate them.
  const template = systemKind && isSlackAutomationTrigger(automation.triggerType)
    ? systemAutomationTemplate(systemKind, automation.triggerType, t) : automation.messageTemplate;
  const message = renderSlackAutomationMessage(template, context, t);
  const [created] = await getDb().insert(slackAutomationDeliveries).values({
    id: crypto.randomUUID(),
    ownerId: automation.ownerId,
    automationId: automation.id,
    itemId,
    eventKey,
    triggerType,
    channelId: automation.channelId,
    message,
    status: "pending",
    createdAt: now,
  }).onConflictDoNothing({ target: slackAutomationDeliveries.eventKey }).returning();
  const delivery = created ?? (await getDb().select().from(slackAutomationDeliveries).where(and(eq(slackAutomationDeliveries.ownerId, automation.ownerId), eq(slackAutomationDeliveries.eventKey, eventKey))).limit(1))[0];
  if (!delivery) return null;
  // Historical attempts have no receipt and must not be replayed blindly.
  if (!created) {
    if (delivery.status !== "pending") return delivery;
    const receipt = await env.DB.prepare("SELECT id FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = 'automation' AND event_key = ?")
      .bind(automation.ownerId, eventKey).first();
    if (!receipt) return delivery;
  }

  try {
    const { deliverSlackBotMessage } = await import("@/lib/slack-bot-delivery");
    await deliverSlackBotMessage(env.DB, {
      ownerId: automation.ownerId, botKind: "automation", subjectId: delivery.id, eventKey,
      payload: { channel: delivery.channelId, text: delivery.message, test: triggerType === "test" },
      expiresAt: new Date(new Date(delivery.createdAt).getTime() + 24 * 60 * 60_000).toISOString(),
    });
    return (await getDb().select().from(slackAutomationDeliveries).where(and(eq(slackAutomationDeliveries.ownerId, automation.ownerId), eq(slackAutomationDeliveries.id, delivery.id))).limit(1))[0];
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const failedAt = new Date().toISOString();
    const [failed] = await getDb().update(slackAutomationDeliveries).set({ status: "failed", error: message })
      .where(and(eq(slackAutomationDeliveries.ownerId, automation.ownerId), eq(slackAutomationDeliveries.id, delivery.id))).returning();
    await getDb().update(slackAutomations).set({ lastTriggeredAt: failedAt, lastDeliveryStatus: "failed", lastError: message, updatedAt: failedAt })
      .where(and(eq(slackAutomations.ownerId, automation.ownerId), eq(slackAutomations.id, automation.id)));
    return failed;
  }
}

function serializeSlackAutomation(automation: SlackAutomation) {
  return {
    id: automation.id,
    name: automation.name,
    triggerType: automation.triggerType,
    triggerStatus: automation.triggerStatus,
    channelId: automation.channelId,
    messageTemplate: automation.messageTemplate,
    messageTemplateKind: automation.messageTemplateKind,
    supported: isSupportedTaskAutomation(automation.triggerType, automation.triggerStatus),
    active: automation.active,
    lastTriggeredAt: automation.lastTriggeredAt,
    lastDeliveryStatus: automation.lastDeliveryStatus,
    lastError: automation.lastError,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function serializeSlackAutomationDelivery(delivery: SlackAutomationDelivery) {
  return {
    id: delivery.id,
    automationId: delivery.automationId,
    itemId: delivery.itemId,
    triggerType: delivery.triggerType,
    channelId: delivery.channelId,
    message: delivery.message,
    status: delivery.status,
    error: delivery.error,
    createdAt: delivery.createdAt,
    sentAt: delivery.sentAt,
  };
}

export async function createIntegrationToken(
  authorization: RequestAuthorization,
  name = "Codex",
  provider: IntegrationProvider = "other",
  scopes = "okri:read okri:write",
) {
  await ensureSchema();
  const token = `okri_${randomTokenPart(32)}`;
  const now = new Date().toISOString();
  const [record] = await getDb().insert(integrationTokens).values({
    id: crypto.randomUUID(),
    workspaceId: authorization.ownerId,
    userId: authorization.userId,
    name: name.trim().slice(0, 50) || "Codex",
    provider,
    scopes,
    tokenHash: await hashIntegrationToken(token),
    tokenPrefix: `${token.slice(0, 14)}...`,
    createdAt: now,
  }).returning();
  const activeTokens = await getDb().select({ id: integrationTokens.id }).from(integrationTokens).where(and(
    eq(integrationTokens.workspaceId, authorization.ownerId),
    eq(integrationTokens.userId, authorization.userId),
    isNull(integrationTokens.revokedAt),
    integrationProviderCondition(provider),
  )).orderBy(desc(integrationTokens.createdAt));
  const staleIds = activeTokens.slice(10).map((entry) => entry.id);
  if (staleIds.length) {
    await getDb().update(integrationTokens).set({ revokedAt: now }).where(inArray(integrationTokens.id, staleIds));
  }
  return { token, connection: serializeIntegrationToken(record) };
}

export async function listIntegrationTokens(authorization: RequestAuthorization, provider?: IntegrationProvider) {
  await ensureSchema();
  const rows = await getDb().select().from(integrationTokens).where(and(
    eq(integrationTokens.workspaceId, authorization.ownerId),
    eq(integrationTokens.userId, authorization.userId),
    isNull(integrationTokens.revokedAt),
    provider ? integrationProviderCondition(provider) : undefined,
  )).orderBy(desc(integrationTokens.createdAt));
  return rows.map(serializeIntegrationToken);
}

export async function revokeIntegrationTokens(authorization: RequestAuthorization, id?: string, provider?: IntegrationProvider) {
  await ensureSchema();
  const now = new Date().toISOString();
  const baseCondition = and(
    eq(integrationTokens.workspaceId, authorization.ownerId),
    eq(integrationTokens.userId, authorization.userId),
    isNull(integrationTokens.revokedAt),
    provider ? integrationProviderCondition(provider) : undefined,
  );
  const condition = id ? and(baseCondition, eq(integrationTokens.id, id)) : baseCondition;
  const revoked = await getDb().update(integrationTokens).set({ revokedAt: now }).where(condition).returning({ id: integrationTokens.id });
  return { revoked: revoked.length, ids: revoked.map((entry) => entry.id) };
}

function serializeIntegrationToken(record: IntegrationToken): IntegrationTokenSummary {
  return {
    id: record.id,
    name: record.name,
    provider: effectiveIntegrationProvider(record),
    tokenPrefix: record.tokenPrefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

function integrationProviderCondition(provider: IntegrationProvider) {
  // NULL is a legacy record; preserve every legacy token and classify only the known OAuth name.
  return sql`COALESCE(${integrationTokens.provider}, CASE WHEN ${integrationTokens.name} = 'ChatGPT OAuth' THEN 'chatgpt' ELSE 'other' END) = ${provider}`;
}

function randomTokenPart(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashIntegrationToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authorizeRequest(
  request: Request,
  options: { allowViewerWrite?: boolean } = {},
): Promise<RequestAuthorization | Response> {
  // Run idempotent schema and account repairs before choosing an authentication
  // mechanism. This lets the first post-deploy session check complete the repair
  // without treating an unauthenticated request as a user or creating an account.
  await ensureSchema();
  await ensureBillingSchema();
  const configuredToken = (env as RuntimeEnv).OKRI_API_TOKEN
    ?? (env as RuntimeEnv).OKRPTR_API_TOKEN
    ?? (env as RuntimeEnv).OKITA_API_TOKEN
    ?? (env as RuntimeEnv).PACE_API_TOKEN;
  const suppliedToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (suppliedToken?.startsWith("okri_native_")) {
    const { readNativeIdentity } = await import("@/lib/native-session");
    const identity = await readNativeIdentity(env.DB, suppliedToken);
    if (!identity) return Response.json({ error: "Sign in again", code: "native_session_expired" }, { status: 401 });
    const requested = requestedWorkspaceId(request);
    const membership = await resolveWorkspaceMembership(identity.id, identity.email, identity.displayName, requested);
    if (!membership || membership.status !== "active" || (requested && membership.workspaceId !== requested)) {
      return Response.json({ error: "Workspace access denied" }, { status: 403 });
    }
    const role = membership.role as TeamRole;
    if (!options.allowViewerWrite && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (role === "viewer") return Response.json({ error: "Viewer access is read-only." }, { status: 403 });
      if (!(await memberCanWrite(membership.workspaceId, identity.id, role))) return Response.json({ error: "Read-only access", code: "editor_read_only" }, { status: 403 });
    }
    return { ownerId: membership.workspaceId, userId: identity.id, email: identity.email, displayName: membership.displayName, role, apiToken: false };
  }
  if (suppliedToken && (suppliedToken.startsWith("okri_") || suppliedToken.startsWith("okrptr_"))) {
    const [tokenRow] = await getDb()
      .select({ token: integrationTokens })
      .from(integrationTokens)
      .innerJoin(workspaces, eq(integrationTokens.workspaceId, workspaces.id))
      .where(and(
        eq(integrationTokens.tokenHash, await hashIntegrationToken(suppliedToken)),
        isNull(integrationTokens.revokedAt),
        isNull(workspaces.scheduledDeletionAt),
      ))
      .limit(1);
    const token = tokenRow?.token;
    if (token) {
      const [membership] = await getDb().select().from(workspaceMembers).where(and(
        eq(workspaceMembers.workspaceId, token.workspaceId),
        eq(workspaceMembers.userId, token.userId),
        eq(workspaceMembers.status, "active"),
      )).limit(1);
      if (!membership) {
        return Response.json({ error: "This OKRI connection no longer has workspace access." }, { status: 403 });
      }
      const role = membership.role as TeamRole;
      if (!options.allowViewerWrite && !["GET", "HEAD", "OPTIONS"].includes(request.method) && token.scopes
        && !token.scopes.split(" ").some((scope) => scope === "okri:write" || scope === "okrptr:write")) {
        return Response.json({ error: "This connection only permits read access." }, { status: 403 });
      }
      if (!options.allowViewerWrite && role === "viewer" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        return Response.json({ error: "Viewer access is read-only." }, { status: 403 });
      }
      if (!options.allowViewerWrite && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !(await memberCanWrite(token.workspaceId, token.userId, role))) {
        return Response.json({ error: "플랜에서 선택된 활성 편집자가 아니므로 읽기 전용입니다.", code: "editor_read_only", upgradeUrl: "/?view=billing" }, { status: 403 });
      }
      await getDb().update(integrationTokens).set({ lastUsedAt: new Date().toISOString() }).where(eq(integrationTokens.id, token.id));
      return {
        ownerId: token.workspaceId,
        userId: token.userId,
        email: membership.email,
        displayName: membership.displayName,
        role,
        apiToken: true,
        oauthScopes: token.scopes ?? "okri:read okri:write",
      };
    }
  }
  if (configuredToken && suppliedToken === configuredToken) {
    const ownerId = requestedWorkspaceId(request)
      || request.headers.get("x-okri-user-id")
      || request.headers.get("x-okrptr-user-id")
      || request.headers.get("x-okita-user-id")
      || request.headers.get("x-pace-user-id")
      || "api-workspace";
    await ensureWorkspaceShell(ownerId, null, "API");
    return { ownerId, userId: "api-token", email: null, displayName: "API", role: "owner", apiToken: true };
  }

  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    const membership = await resolveWorkspaceMembership("local-user", "local@okri.ai", "Local Owner", requestedWorkspaceId(request));
    return { ownerId: membership?.workspaceId ?? "local-user", userId: "local-user", email: "local@okri.ai", displayName: "Local Owner", role: (membership?.role as TeamRole | undefined) ?? "owner", apiToken: false };
  }

  const googleSession = await readGoogleSession(request, (env as RuntimeEnv).GOOGLE_TOKEN_ENCRYPTION_KEY);
  if (googleSession) {
    try {
      const canonicalUserId = await canonicalUserIdForVerifiedIdentity(googleSession.sub, googleSession.email, googleSession.name, request, "google", googleSession.expiresAt - 7 * 24 * 60 * 60);
      const membership = await resolveWorkspaceMembership(canonicalUserId, googleSession.email, googleSession.name, requestedWorkspaceId(request));
      if (!membership || membership.status !== "active") {
        return Response.json({ error: "This Google account is not an active workspace member." }, { status: 403 });
      }
      const role = membership.role as TeamRole;
      if (!options.allowViewerWrite && role === "viewer" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        return Response.json({ error: "Viewer access is read-only." }, { status: 403 });
      }
      if (!options.allowViewerWrite && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !(await memberCanWrite(membership.workspaceId, canonicalUserId, role))) {
        return Response.json({ error: "플랜에서 선택된 활성 편집자가 아니므로 읽기 전용입니다.", code: "editor_read_only", upgradeUrl: "/?view=billing" }, { status: 403 });
      }
      return { ownerId: membership.workspaceId, userId: canonicalUserId, email: googleSession.email, displayName: membership.displayName, role, apiToken: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resolve Google workspace access.";
      if (message === "Sign in again") return Response.json({ error: message }, { status: 401 });
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json(
    { error: "Authentication required. Sign in or provide an OKRI API token." },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function canonicalUserIdForVerifiedIdentity(subject: string, emailInput: string, displayNameInput: string, request: Request, provider: "google" | "apple" = "google", issuedAt?: number) {
  await ensureSchema();
  const { digest } = await import("@/lib/native-session");
  const deleted = await env.DB.prepare("SELECT deleted_at FROM native_identity_revocations WHERE identity_hash = ?").bind(await digest(provider + ":" + subject)).first<{ deleted_at: number }>();
  if (deleted && (!issuedAt || issuedAt <= deleted.deleted_at)) throw new Error("Sign in again");
  const email = normalizeEmail(emailInput);
  if (!email) throw new Error("A verified email is required");
  const now = new Date().toISOString();
  const displayName = cleanDisplayName(displayNameInput) || email.split("@")[0];
  const [linkedIdentity] = await getDb()
    .select({ identity: authIdentities, user: users })
    .from(authIdentities)
    .innerJoin(users, eq(authIdentities.userId, users.id))
    .where(and(
      eq(authIdentities.provider, provider),
      eq(authIdentities.providerSubject, subject),
    ))
    .limit(1);
  if (linkedIdentity) {
    const { identity, user } = linkedIdentity;
    const lastUsedAt = Date.parse(identity.lastUsedAt);
    if (identity.email !== email || !Number.isFinite(lastUsedAt) || Date.now() - lastUsedAt >= 24 * 60 * 60 * 1_000) {
      await getDb().update(authIdentities).set({ email, lastUsedAt: now }).where(eq(authIdentities.id, identity.id));
    }
    if (user.displayName !== displayName) {
      await getDb().update(users).set({ displayName, updatedAt: now }).where(eq(users.id, identity.userId));
    }
    return identity.userId;
  }

  const [emailUser] = await getDb().select().from(users).where(eq(users.emailNormalized, email)).limit(1);
  const userId = emailUser?.id ?? crypto.randomUUID();
  if (!emailUser) {
    await getDb().insert(users).values({ id: userId, emailNormalized: email, displayName, ...newAccountLanguage(request), createdAt: now, updatedAt: now }).onConflictDoNothing();
  }
  await getDb().insert(authIdentities).values({
    id: crypto.randomUUID(),
    userId,
    provider,
    providerSubject: subject,
    email,
    createdAt: now,
    lastUsedAt: now,
  }).onConflictDoNothing();
  const [linked] = await getDb().select().from(authIdentities).where(and(
    eq(authIdentities.provider, provider),
    eq(authIdentities.providerSubject, subject),
  )).limit(1);
  if (!linked) throw new Error("Identity could not be linked");
  return linked.userId;
}

// Keep the original Google-specific export for internal callers and migration tests.
// New providers use the verified-identity entry point above.
export async function canonicalUserIdForGoogle(subject: string, emailInput: string, displayNameInput: string, request: Request, issuedAt?: number) {
  return canonicalUserIdForVerifiedIdentity(subject, emailInput, displayNameInput, request, "google", issuedAt);
}

async function ensureWorkspaceShell(ownerId: string, email: string | null = null, displayName = "Workspace Owner") {
  const now = new Date().toISOString();
  const { resolvedLanguage } = await readLanguagePreferences(env.DB, ownerId);
  const t = await serverTranslator(resolvedLanguage);
  const workspaceName = displayName && displayName !== "Workspace Owner" ? t("{name}의 개인 워크스페이스", { name: displayName }) : t("개인 워크스페이스");
  await getDb().insert(workspaces).values({ id: ownerId, name: workspaceName, ownerUserId: ownerId, kind: "personal", messageLanguage: resolvedLanguage, createdAt: now, updatedAt: now }).onConflictDoNothing();
  await getDb().insert(workspaceMembers).values({
    id: crypto.randomUUID(),
    workspaceId: ownerId,
    userId: ownerId,
    email,
    displayName,
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

async function resolveWorkspaceMembership(userId: string, email: string | null, displayName: string, requestedId: string | null) {
  const [initialMemberships, preferenceRows] = await Promise.all([
    activeWorkspaceMemberships(userId),
    getDb().select().from(userWorkspacePreferences).where(eq(userWorkspacePreferences.userId, userId)).limit(1),
  ]);
  let memberships = initialMemberships;
  if (!memberships.length) {
    await ensureWorkspaceShell(userId, email, displayName);
    memberships = await activeWorkspaceMemberships(userId);
  }

  const now = new Date().toISOString();
  const normalizedMemberships = memberships.map((membership) => ({
    ...membership,
    email,
    displayName: displayNameForExistingMember(membership.displayName, displayName, email),
  }));
  for (const membership of normalizedMemberships) {
    const previous = memberships.find((entry) => entry.id === membership.id);
    if (previous?.email === membership.email && previous.displayName === membership.displayName) continue;
    await getDb().update(workspaceMembers).set({ email: membership.email, displayName: membership.displayName, updatedAt: now }).where(eq(workspaceMembers.id, membership.id));
  }
  const [preference] = preferenceRows;
  const selected = normalizedMemberships.find((entry) => entry.workspaceId === requestedId)
    ?? normalizedMemberships.find((entry) => entry.workspaceId === preference?.activeWorkspaceId)
    ?? normalizedMemberships.find((entry) => entry.workspaceId === userId)
    ?? normalizedMemberships[0]
    ?? null;
  return selected;
}

async function activeWorkspaceMemberships(userId: string) {
  const rows = await getDb()
    .select({ membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaces.scheduledDeletionAt),
    ))
    .orderBy(asc(workspaceMembers.createdAt));
  return rows.map((row) => row.membership);
}

function requestedWorkspaceId(request: Request) {
  const header = request.headers.get("x-okri-workspace-id")?.trim()
    || request.headers.get("x-okrptr-workspace-id")?.trim();
  if (header) return header;
  const cookies = request.headers.get("cookie")
    ?.split(";")
    .map((entry) => entry.trim().split("="));
  const cookie = cookies?.find(([name]) => name === "okri_workspace_id")?.[1]
    ?? cookies?.find(([name]) => name === "okrptr_workspace_id")?.[1];
  return cookie ? decodeURIComponent(cookie) : null;
}

function normalizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 200);
}

export async function listUserWorkspaces(userId: string, currentWorkspaceId: string) {
  await purgeExpiredWorkspaces();
  const rows = await getDb()
    .select({ workspace: workspaces, membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      or(isNull(workspaces.scheduledDeletionAt), eq(workspaceMembers.role, "owner")),
    ))
    .orderBy(asc(workspaces.createdAt));
  return rows.map(({ workspace, membership }) => ({
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    kind: workspace.kind as "personal" | "team",
    personal: workspace.kind === "personal",
    role: membership.role as TeamRole,
    current: workspace.id === currentWorkspaceId && !workspace.scheduledDeletionAt,
    deletionRequestedAt: workspace.deletionRequestedAt,
    scheduledDeletionAt: workspace.scheduledDeletionAt,
    avatarUrl: workspaceAvatarUrl(workspace.id, workspace.avatarKey, workspace.avatarUpdatedAt),
    avatarUpdatedAt: workspace.avatarUpdatedAt,
  }));
}

export async function createWorkspaceForUser(userId: string, email: string | null, displayName: string, nameInput: string) {
  const name = nameInput.trim();
  if (!name) throw new Error("Workspace name is required");
  if (name.length > 80) throw new Error("Workspace name must be 80 characters or fewer");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { resolvedLanguage } = await readLanguagePreferences(env.DB, userId);
  await getDb().insert(workspaces).values({ id, name, ownerUserId: userId, kind: "team", messageLanguage: resolvedLanguage, createdAt: now, updatedAt: now });
  await getDb().insert(workspaceMembers).values({ id: crypto.randomUUID(), workspaceId: id, userId, email, displayName, role: "owner", status: "active", createdAt: now, updatedAt: now });
  await setActiveWorkspace(userId, id);
  return {
    id,
    name,
    createdAt: now,
    kind: "team" as const,
    personal: false,
    role: "owner" as TeamRole,
    current: true,
    deletionRequestedAt: null,
    scheduledDeletionAt: null,
    avatarUrl: null,
    avatarUpdatedAt: null,
  };
}

export async function scheduleWorkspaceDeletionForUser(userId: string, workspaceId: string) {
  await ensureSchema();
  await purgeExpiredWorkspaces();
  const id = workspaceId.trim();
  if (!id) throw new Error("workspaceId is required");
  const [row] = await getDb()
    .select({ workspace: workspaces, membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
    .limit(1);
  if (!row) throw new Error("Workspace not found or access denied");
  if (row.membership.role !== "owner") throw new Error("Only the workspace owner can delete a workspace");
  if (row.workspace.kind === "personal") throw new Error("Personal workspace cannot be deleted");

  const remaining = (await listUserWorkspaces(userId, id)).filter((workspace) => workspace.id !== id && !workspace.scheduledDeletionAt);
  if (!remaining.length) throw new Error("Create or keep another workspace before deleting this one");
  const nextWorkspace = remaining.find((workspace) => workspace.personal) ?? remaining[0];
  await cancelSubscription(id);
  const now = new Date().toISOString();
  const scheduledDeletionAt = row.workspace.scheduledDeletionAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const deletionRequestedAt = row.workspace.deletionRequestedAt ?? now;
  await getDb().update(workspaces).set({
    deletionRequestedAt,
    scheduledDeletionAt,
    deletionRequestedByUserId: userId,
    updatedAt: now,
  }).where(eq(workspaces.id, id));
  await getDb().update(userWorkspacePreferences).set({ activeWorkspaceId: null, updatedAt: now }).where(eq(userWorkspacePreferences.activeWorkspaceId, id));
  await setActiveWorkspace(userId, nextWorkspace.id);
  return {
    deleted: false,
    deletionScheduled: true,
    id,
    deletionRequestedAt,
    scheduledDeletionAt,
    nextWorkspaceId: nextWorkspace.id,
    nextWorkspace,
  };
}

export async function restoreWorkspaceForUser(userId: string, workspaceId: string) {
  await ensureSchema();
  await purgeExpiredWorkspaces();
  const id = workspaceId.trim();
  if (!id) throw new Error("workspaceId is required");
  const [row] = await getDb()
    .select({ workspace: workspaces, membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
    .limit(1);
  if (!row) throw new Error("Workspace not found or access denied");
  if (row.membership.role !== "owner") throw new Error("Only the workspace owner can restore a workspace");
  if (!row.workspace.scheduledDeletionAt) throw new Error("Workspace is not scheduled for deletion");
  const now = new Date().toISOString();
  await getDb().update(workspaces).set({
    deletionRequestedAt: null,
    scheduledDeletionAt: null,
    deletionRequestedByUserId: null,
    updatedAt: now,
  }).where(eq(workspaces.id, id));
  return {
    restored: true,
    workspace: {
      id: row.workspace.id,
      name: row.workspace.name,
      kind: "team" as const,
      personal: false,
      role: "owner" as TeamRole,
      current: false,
      deletionRequestedAt: null,
      scheduledDeletionAt: null,
      avatarUrl: workspaceAvatarUrl(row.workspace.id, row.workspace.avatarKey, row.workspace.avatarUpdatedAt),
      avatarUpdatedAt: row.workspace.avatarUpdatedAt,
    },
  };
}

export async function permanentlyDeleteWorkspaceForUser(userId: string, workspaceId: string, confirmationName: string) {
  await ensureSchema();
  const id = workspaceId.trim();
  if (!id) throw new Error("workspaceId is required");
  const [row] = await getDb()
    .select({ workspace: workspaces, membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
    .limit(1);
  if (!row) throw new Error("Workspace not found or access denied");
  if (row.membership.role !== "owner") throw new Error("Only the workspace owner can permanently delete a workspace");
  if (row.workspace.kind === "personal") throw new Error("Personal workspace cannot be deleted");
  if (!row.workspace.scheduledDeletionAt) throw new Error("Workspace must be scheduled for deletion first");
  if (confirmationName !== row.workspace.name) throw new Error("Workspace name confirmation does not match");

  const remainingRows = await getDb()
    .select({ workspace: workspaces, membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaces.scheduledDeletionAt),
    ))
    .orderBy(asc(workspaces.createdAt));
  const nextRow = remainingRows.find((entry) => entry.workspace.kind === "personal") ?? remainingRows[0];
  if (!nextRow) throw new Error("Keep another workspace before permanently deleting this one");

  await permanentlyDeleteWorkspace(id);
  const nextWorkspace = {
    id: nextRow.workspace.id,
    name: nextRow.workspace.name,
    createdAt: nextRow.workspace.createdAt,
    kind: nextRow.workspace.kind as "personal" | "team",
    personal: nextRow.workspace.kind === "personal",
    role: nextRow.membership.role as TeamRole,
    current: true,
    deletionRequestedAt: null,
    scheduledDeletionAt: null,
    avatarUrl: workspaceAvatarUrl(nextRow.workspace.id, nextRow.workspace.avatarKey, nextRow.workspace.avatarUpdatedAt),
    avatarUpdatedAt: nextRow.workspace.avatarUpdatedAt,
  };
  await setActiveWorkspace(userId, nextWorkspace.id);
  return { deleted: true, id, nextWorkspaceId: nextWorkspace.id, nextWorkspace };
}

async function purgeExpiredWorkspaces() {
  const expired = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(lte(workspaces.scheduledDeletionAt, new Date().toISOString()))
    .limit(10);
  for (const workspace of expired) await permanentlyDeleteWorkspace(workspace.id);
}

async function permanentlyDeleteWorkspace(id: string) {
  await cancelSubscription(id);
  const [workspace] = await getDb()
    .select({ avatarKey: workspaces.avatarKey })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  const groupRows = await getDb().select({ id: workspaceGroups.id }).from(workspaceGroups).where(eq(workspaceGroups.workspaceId, id));
  if (groupRows.length) await getDb().delete(workspaceGroupMembers).where(inArray(workspaceGroupMembers.groupId, groupRows.map((group) => group.id)));
  await getDb().delete(googleCalendarEvents).where(eq(googleCalendarEvents.ownerId, id));
  await getDb().delete(googleConnections).where(eq(googleConnections.ownerId, id));
  await getDb().delete(googleOAuthStates).where(eq(googleOAuthStates.ownerId, id));
  await getDb().delete(slackAutomationDeliveries).where(eq(slackAutomationDeliveries.ownerId, id));
  await getDb().delete(slackAutomations).where(eq(slackAutomations.ownerId, id));
  await getDb().delete(slackConnections).where(eq(slackConnections.ownerId, id));
  await getDb().delete(slackOAuthStates).where(eq(slackOAuthStates.ownerId, id));
  await getDb().delete(integrationTokens).where(eq(integrationTokens.workspaceId, id));
  await getDb().delete(aiUsageEvents).where(eq(aiUsageEvents.ownerId, id));
  await getDb().delete(activityLog).where(eq(activityLog.ownerId, id));
  await getDb().delete(routineCompletions).where(eq(routineCompletions.ownerId, id));
  await getDb().delete(routines).where(eq(routines.ownerId, id));
  await (env as RuntimeEnv).DB.prepare("DELETE FROM routine_property_definitions WHERE owner_id = ?").bind(id).run();
  await getDb().delete(checklistItems).where(eq(checklistItems.ownerId, id));
  await getDb().delete(itemPropertyValues).where(eq(itemPropertyValues.ownerId, id));
  await getDb().delete(itemAssignments).where(eq(itemAssignments.ownerId, id));
  await getDb().delete(projectHiddenProperties).where(eq(projectHiddenProperties.ownerId, id));
  await getDb().delete(projectDocuments).where(eq(projectDocuments.ownerId, id));
  await getDb().delete(projectTemplates).where(eq(projectTemplates.ownerId, id));
  await getDb().delete(propertyDefinitions).where(eq(propertyDefinitions.ownerId, id));
  await getDb().delete(dailyScrums).where(eq(dailyScrums.ownerId, id));
  await getDb().delete(trashRecords).where(eq(trashRecords.ownerId, id));
  await getDb().delete(items).where(eq(items.ownerId, id));
  await getDb().delete(okrCycles).where(eq(okrCycles.ownerId, id));
  await getDb().delete(workspaceRules).where(eq(workspaceRules.workspaceId, id));
  await getDb().delete(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, id));
  await getDb().update(userWorkspacePreferences).set({ activeWorkspaceId: null, updatedAt: new Date().toISOString() }).where(eq(userWorkspacePreferences.activeWorkspaceId, id));
  await getDb().delete(workspaceGroups).where(eq(workspaceGroups.workspaceId, id));
  await getDb().delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, id));
  await getDb().delete(workspaces).where(eq(workspaces.id, id));
  if (workspace?.avatarKey) {
    try {
      await (env as RuntimeEnv).WORKSPACE_AVATARS?.delete(workspace.avatarKey);
    } catch {
      // The workspace is already gone. A missed object is safe to clean up later.
    }
  }
}

export async function deleteNativeUserAccount(userId: string) {
  await ensureSchema();
  const runtime = env as unknown as import("./apple-native").AppleNativeEnv;
  const { revokeAppleGrant } = await import("./apple-native");
  const { digest } = await import("./native-session");
  const { accountDeletionStatements } = await import("./native-account");
  const owned = await env.DB.prepare("SELECT w.id,w.avatar_key FROM workspaces w WHERE w.owner_user_id = ?").bind(userId).all<{ id: string; avatar_key: string | null }>();
  for (const workspace of owned.results) {
    const other = await env.DB.prepare("SELECT id FROM workspace_members WHERE workspace_id = ? AND status = 'active' AND (user_id IS NULL OR user_id != ?) LIMIT 1")
      .bind(workspace.id, userId).first();
    if (other) throw new Error("transfer_workspace_ownership");
  }
  // Keep the account available for retry if cancellation or provider revocation fails.
  for (const workspace of owned.results) await cancelSubscription(workspace.id);
  await revokeAppleGrant(runtime, userId);
  const { decryptSecret } = await import("./google-oauth");
  const connections = await env.DB.prepare("SELECT encrypted_refresh_token FROM google_connections WHERE user_id=?").bind(userId).all<{ encrypted_refresh_token: string }>();
  for (const connection of connections.results) {
    const token = await decryptSecret(connection.encrypted_refresh_token, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!);
    const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15000) });
    if (!response.ok && response.status !== 400) throw new Error("Google authorization could not be revoked");
  }
  const identities = await env.DB.prepare("SELECT provider, provider_subject FROM auth_identities WHERE user_id = ?").bind(userId).all<{ provider: string; provider_subject: string }>();
  const revocations = await Promise.all(identities.results.map(async identity =>
    env.DB.prepare("INSERT INTO native_identity_revocations(identity_hash,deleted_at) VALUES(?,?) ON CONFLICT(identity_hash) DO UPDATE SET deleted_at=excluded.deleted_at")
      .bind(await digest(identity.provider + ":" + identity.provider_subject), Math.floor(Date.now() / 1000))));
  await env.DB.batch([
    ...revocations,
    ...accountDeletionStatements(env.DB, userId, owned.results.map(workspace => workspace.id)),
  ]);
  for (const workspace of owned.results) if (workspace.avatar_key) {
    try { await (env as RuntimeEnv).WORKSPACE_AVATARS?.delete(workspace.avatar_key); }
    catch { /* Account deletion already committed; object retention cleanup is separate. */ }
  }
}

export async function setActiveWorkspace(userId: string, workspaceId: string) {
  await purgeExpiredWorkspaces();
  const [row] = await getDb()
    .select({ membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaces.scheduledDeletionAt),
    )).limit(1);
  if (!row) throw new Error("Workspace not found or access denied");
  await getDb().insert(userWorkspacePreferences).values({ userId, activeWorkspaceId: workspaceId, updatedAt: new Date().toISOString() }).onConflictDoUpdate({
    target: userWorkspacePreferences.userId,
    set: { activeWorkspaceId: workspaceId, updatedAt: new Date().toISOString() },
  });
  return row.membership;
}

function normalizeEmail(value: string | null) {
  const email = value?.trim().toLocaleLowerCase() ?? "";
  return email || null;
}

function cleanDisplayName(value: string | null | undefined) {
  const name = value?.trim().replace(/\s+/g, " ") ?? "";
  if (!name || name.length > 80) return "";
  if (/^\S+@\S+\.\S+$/.test(name)) return "";
  return name;
}

function displayNameForExistingMember(currentName: string, incomingName: string, email: string | null) {
  const current = cleanDisplayName(currentName);
  const incoming = cleanDisplayName(incomingName);
  if (!incoming) return current || email?.split("@")[0] || "Member";
  if (!current || current === "Member" || current === email?.split("@")[0]) return incoming;
  return current;
}

export function canManageTeam(authorization: RequestAuthorization) {
  return authorization.role === "owner" || authorization.role === "admin";
}

function workspaceAvatarUrl(workspaceId: string, avatarKey: string | null, avatarUpdatedAt: string | null) {
  if (!avatarKey) return null;
  const version = encodeURIComponent(avatarUpdatedAt ?? avatarKey);
  return `/api/workspaces/avatar?workspaceId=${encodeURIComponent(workspaceId)}&v=${version}`;
}

export async function getWorkspaceAvatarForUser(authorization: RequestAuthorization, workspaceIdInput: string) {
  await ensureSchema();
  const workspaceId = workspaceIdInput.trim();
  if (!workspaceId) throw new Error("workspaceId is required");
  if (authorization.apiToken && authorization.ownerId === workspaceId) {
    const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace) throw new Error("Workspace not found or access denied");
    return workspace;
  }
  const [row] = await getDb()
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, authorization.userId),
      eq(workspaceMembers.status, "active"),
    ))
    .limit(1);
  if (!row) throw new Error("Workspace not found or access denied");
  return row.workspace;
}

export async function getManageableWorkspaceForAvatar(authorization: RequestAuthorization) {
  await ensureSchema();
  if (authorization.role !== "owner" && authorization.role !== "admin") throw new Error("Owner or Admin access is required");
  const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, authorization.ownerId)).limit(1);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (workspace.id === workspace.ownerUserId) throw new Error("Personal workspace avatars are not supported");
  if (workspace.scheduledDeletionAt) throw new Error("Workspace is scheduled for deletion");
  return workspace;
}

export async function saveWorkspaceAvatar(authorization: RequestAuthorization, avatarKey: string) {
  const workspace = await getManageableWorkspaceForAvatar(authorization);
  const avatarUpdatedAt = new Date().toISOString();
  await getDb().update(workspaces).set({ avatarKey, avatarUpdatedAt, updatedAt: avatarUpdatedAt }).where(eq(workspaces.id, workspace.id));
  return {
    avatarUrl: workspaceAvatarUrl(workspace.id, avatarKey, avatarUpdatedAt),
    avatarUpdatedAt,
    previousAvatarKey: workspace.avatarKey,
  };
}

export async function clearWorkspaceAvatar(authorization: RequestAuthorization) {
  const workspace = await getManageableWorkspaceForAvatar(authorization);
  const avatarUpdatedAt = new Date().toISOString();
  await getDb().update(workspaces).set({ avatarKey: null, avatarUpdatedAt, updatedAt: avatarUpdatedAt }).where(eq(workspaces.id, workspace.id));
  return { avatarUrl: null, avatarUpdatedAt, previousAvatarKey: workspace.avatarKey };
}

export async function countAiUsageEvents(ownerId: string, userId: string, source: string, since: string) {
  await ensureSchema();
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(and(
      eq(aiUsageEvents.ownerId, ownerId),
      eq(aiUsageEvents.userId, userId),
      eq(aiUsageEvents.source, source),
      sql`${aiUsageEvents.createdAt} >= ${since}`,
    ));
  return Number(row?.count ?? 0);
}

export async function getTeam(ownerId: string, currentUserId: string) {
  const now = new Date().toISOString();
  await getDb().update(workspaceInvitations).set({ status: "expired", updatedAt: now }).where(and(
    eq(workspaceInvitations.workspaceId, ownerId),
    eq(workspaceInvitations.status, "pending"),
    lte(workspaceInvitations.expiresAt, now),
  ));
  const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, ownerId)).limit(1);
  if (!workspace) throw new Error("Workspace not found");
  const [members, invitations] = await Promise.all([
    getDb().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ownerId), eq(workspaceMembers.status, "active"))).orderBy(asc(workspaceMembers.createdAt)),
    getDb().select().from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, ownerId)).orderBy(desc(workspaceInvitations.createdAt)),
  ]);
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind as "personal" | "team",
      avatarUrl: workspaceAvatarUrl(workspace.id, workspace.avatarKey, workspace.avatarUpdatedAt),
      avatarUpdatedAt: workspace.avatarUpdatedAt,
    },
    members: members.map((member) => serializeTeamMember(member, currentUserId)),
    invitations: invitations
      .filter((invitation) => invitation.status === "pending" || invitation.status === "expired")
      .map(serializeWorkspaceInvitation),
    invitationEmailConfigured: invitationEmailConfigured(),
  };
}

export async function inviteTeamMember(ownerId: string, actorUserId: string, emailInput: string, role: Exclude<TeamRole, "owner">, displayNameInput = "") {
  return createWorkspaceInvitation(ownerId, actorUserId, emailInput, role, displayNameInput);
}

export async function createWorkspaceInvitation(ownerId: string, actorUserId: string, emailInput: string, role: Exclude<TeamRole, "owner">, displayNameInput = "") {
  const email = normalizeEmail(emailInput);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("A valid email is required");
  if (!(["admin", "member", "viewer"] as TeamRole[]).includes(role)) throw new Error("Unsupported team role");
  const [workspace] = await getDb().select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, ownerId)).limit(1);
  if (!workspace || workspace.kind !== "team") throw new Error("Members can only be invited to a team workspace");
  const [existingMember] = await getDb().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ownerId), sql`lower(${workspaceMembers.email}) = ${email}`)).limit(1);
  if (existingMember) throw new Error("This email is already an active workspace member");
  const [existingInvitation] = await getDb().select().from(workspaceInvitations).where(and(
    eq(workspaceInvitations.workspaceId, ownerId),
    eq(workspaceInvitations.email, email),
    eq(workspaceInvitations.status, "pending"),
  )).limit(1);
  if (existingInvitation) throw new Error("This email already has a pending invitation");
  const now = new Date().toISOString();
  const displayName = cleanDisplayName(displayNameInput) || email.split("@")[0];
  const id = crypto.randomUUID();
  const expiresAt = invitationExpiry();
  const token = await invitationTokenFor(id, email, expiresAt);
  const invitation: WorkspaceInvitation = {
    id,
    workspaceId: ownerId,
    email,
    displayName,
    role,
    tokenHash: await hashIntegrationToken(token),
    status: "pending",
    deliveryStatus: "not_sent",
    providerMessageId: null,
    invitedByUserId: actorUserId,
    acceptedByUserId: null,
    expiresAt,
    lastSentAt: null,
    acceptedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(workspaceInvitations).values(invitation);
  const delivery = await deliverWorkspaceInvitation(invitation, token);
  await logActivity(ownerId, invitation.id, "workspace_invitation_created", "web", {
    email,
    role,
    deliveryStatus: delivery.values.deliveryStatus,
    invitedByUserId: actorUserId,
  });
  return { invitation: serializeWorkspaceInvitation({ ...invitation, ...delivery.values }), inviteUrl: invitationUrl(token) };
}

export async function resendWorkspaceInvitation(ownerId: string, invitationId: string) {
  const invitation = await getPendingWorkspaceInvitation(ownerId, invitationId);
  if (invitation.lastSentAt && Date.now() - new Date(invitation.lastSentAt).getTime() < 60_000) {
    throw new Error("Wait one minute before resending this invitation");
  }
  const expiresAt = invitationExpiry();
  const token = await invitationTokenFor(invitation.id, invitation.email, expiresAt);
  const now = new Date().toISOString();
  const refreshed = { ...invitation, tokenHash: await hashIntegrationToken(token), expiresAt, updatedAt: now };
  await getDb().update(workspaceInvitations).set({ tokenHash: refreshed.tokenHash, expiresAt: refreshed.expiresAt, status: "pending", updatedAt: now }).where(eq(workspaceInvitations.id, invitation.id));
  const delivery = await deliverWorkspaceInvitation(refreshed, token);
  await logActivity(ownerId, invitation.id, "workspace_invitation_resent", "web", {
    email: invitation.email,
    deliveryStatus: delivery.values.deliveryStatus,
  });
  return { invitation: serializeWorkspaceInvitation({ ...refreshed, ...delivery.values }), inviteUrl: invitationUrl(token) };
}

export async function rotateWorkspaceInvitationLink(ownerId: string, invitationId: string) {
  const invitation = await getPendingWorkspaceInvitation(ownerId, invitationId);
  const refresh = !invitation.tokenHash || effectiveInvitationStatus(invitation) === "expired";
  const expiresAt = refresh ? invitationExpiry() : invitation.expiresAt;
  const token = await invitationTokenFor(invitation.id, invitation.email, expiresAt);
  const tokenHash = await hashIntegrationToken(token);
  const now = new Date().toISOString();
  const values = { tokenHash, expiresAt, status: "pending" as const, updatedAt: now };
  if (refresh || invitation.tokenHash !== tokenHash) {
    await getDb().update(workspaceInvitations).set(values).where(eq(workspaceInvitations.id, invitation.id));
  }
  return { invitation: serializeWorkspaceInvitation({ ...invitation, ...values }), inviteUrl: invitationUrl(token) };
}

export async function revokeWorkspaceInvitation(ownerId: string, invitationId: string) {
  const invitation = await getPendingWorkspaceInvitation(ownerId, invitationId);
  const now = new Date().toISOString();
  await getDb().update(workspaceInvitations).set({ status: "revoked", revokedAt: now, updatedAt: now }).where(eq(workspaceInvitations.id, invitation.id));
  await logActivity(ownerId, invitation.id, "workspace_invitation_revoked", "web", { email: invitation.email });
  return { revoked: true, id: invitation.id };
}

export async function previewWorkspaceInvitation(token: string) {
  await ensureSchema();
  const invitation = await invitationByToken(token);
  if (!invitation) throw new Error("Invitation not found");
  const [workspace] = await getDb().select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
  if (!workspace) throw new Error("Workspace not found");
  const [inviter] = await getDb().select({ displayName: workspaceMembers.displayName }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, invitation.workspaceId),
    eq(workspaceMembers.userId, invitation.invitedByUserId),
  )).limit(1);
  return {
    workspace,
    role: invitation.role as Exclude<TeamRole, "owner">,
    inviterName: inviter?.displayName || "Workspace admin",
    emailHint: maskEmail(invitation.email),
    status: effectiveInvitationStatus(invitation),
    expiresAt: invitation.expiresAt,
  };
}

export async function acceptWorkspaceInvitation(authorization: RequestAuthorization, token: string) {
  if (!authorization.email) throw new Error("A verified Google email is required");
  const invitation = await invitationByToken(token);
  if (!invitation) throw new Error("Invitation not found");
  const status = effectiveInvitationStatus(invitation);
  if (status === "accepted" && invitation.acceptedByUserId === authorization.userId) {
    const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
    const [member] = await getDb().select().from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, invitation.workspaceId),
      eq(workspaceMembers.userId, authorization.userId),
      eq(workspaceMembers.status, "active"),
    )).limit(1);
    if (!workspace || !member) throw new Error("Accepted workspace membership could not be found");
    await setActiveWorkspace(authorization.userId, invitation.workspaceId);
    return {
      accepted: true,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      member: serializeTeamMember(member, authorization.userId),
    };
  }
  if (status !== "pending") throw new Error(status === "expired" ? "Invitation has expired" : "Invitation is no longer active");
  if (normalizeEmail(authorization.email) !== invitation.email) throw new Error("Sign in with the Google account that matches the invited email");
  const now = new Date().toISOString();
  let [member] = await getDb().select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, invitation.workspaceId),
    or(eq(workspaceMembers.userId, authorization.userId), sql`lower(${workspaceMembers.email}) = ${invitation.email}`),
  )).limit(1);
  if (member && member.userId !== authorization.userId) throw new Error("This email is linked to another account");
  if (!member) {
    const editorReservation = await reserveEditorSeat(invitation.workspaceId, invitation.role);
    try {
      const [createdMember] = await getDb().insert(workspaceMembers).values({
        id: crypto.randomUUID(),
        workspaceId: invitation.workspaceId,
        userId: authorization.userId,
        email: invitation.email,
        displayName: displayNameForExistingMember(invitation.displayName, authorization.displayName, invitation.email),
        role: invitation.role,
        status: "active",
        invitedByUserId: invitation.invitedByUserId,
        createdAt: now,
        updatedAt: now,
      }).returning();
      member = createdMember;
    } finally {
      await releaseEditorSeat(editorReservation);
    }
  }
  await getDb().update(workspaceInvitations).set({
    status: "accepted",
    acceptedByUserId: authorization.userId,
    acceptedAt: now,
    updatedAt: now,
  }).where(eq(workspaceInvitations.id, invitation.id));
  await logActivity(invitation.workspaceId, invitation.id, "workspace_invitation_accepted", "web", {
    email: invitation.email,
    acceptedByUserId: authorization.userId,
  });
  await setActiveWorkspace(authorization.userId, invitation.workspaceId);
  const [workspace] = await getDb().select().from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
  if (!workspace) throw new Error("Workspace not found");
  return {
    accepted: true,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    member: serializeTeamMember(member, authorization.userId),
  };
}

export async function updateTeamMember(ownerId: string, memberId: string, patch: { role?: Exclude<TeamRole, "owner">; displayName?: string }, currentUserId: string, canManage = false) {
  const member = await getWorkspaceMember(ownerId, memberId);
  const values: { role?: Exclude<TeamRole, "owner">; displayName?: string } = {};
  let editorReservation: string | null = null;
  if (patch.role !== undefined) {
    if (!canManage) throw new Error("Owner or Admin access is required.");
    if (!(["admin", "member", "viewer"] as TeamRole[]).includes(patch.role)) throw new Error("Unsupported team role");
    if (member.role === "owner") throw new Error("The Owner role cannot be changed");
    values.role = patch.role;
  }
  if (patch.displayName !== undefined) {
    const displayName = cleanDisplayName(patch.displayName);
    if (!displayName) throw new Error("Display name is required");
    if (!canManage && member.userId !== currentUserId) throw new Error("You can only update your own display name");
    values.displayName = displayName;
  }
  if (!Object.keys(values).length) throw new Error("No supported team member changes were provided");
  if (member.role === "viewer" && values.role && values.role !== "viewer") editorReservation = await reserveEditorSeat(ownerId, values.role);
  const updated = { ...member, ...values, updatedAt: new Date().toISOString() };
  try {
    await getDb().update(workspaceMembers).set({ ...values, updatedAt: updated.updatedAt }).where(eq(workspaceMembers.id, member.id));
  } finally {
    await releaseEditorSeat(editorReservation);
  }
  return serializeTeamMember(updated, currentUserId);
}

export async function removeTeamMember(ownerId: string, memberId: string, currentUserId: string) {
  const member = await getWorkspaceMember(ownerId, memberId);
  if (member.role === "owner") throw new Error("The Owner cannot be removed");
  if (member.userId === currentUserId) throw new Error("You cannot remove yourself");
  await getDb().delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ownerId), eq(workspaceMembers.id, memberId)));
  return { deleted: true, id: memberId };
}

async function getWorkspaceMember(ownerId: string, memberId: string) {
  const [member] = await getDb().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ownerId), eq(workspaceMembers.id, memberId))).limit(1);
  if (!member) throw new Error("Team member not found");
  return member;
}

function serializeTeamMember(member: WorkspaceMember, currentUserId: string) {
  return {
    id: member.id,
    email: member.email ?? "",
    displayName: member.displayName || member.email?.split("@")[0] || "Member",
    role: member.role as TeamRole,
    status: "active" as const,
    isCurrent: member.userId === currentUserId,
    createdAt: member.createdAt,
  };
}

function serializeWorkspaceInvitation(invitation: WorkspaceInvitation): WorkspaceInvitationSummary {
  return {
    id: invitation.id,
    email: invitation.email,
    displayName: invitation.displayName || invitation.email.split("@")[0],
    role: invitation.role as Exclude<TeamRole, "owner">,
    status: effectiveInvitationStatus(invitation),
    deliveryStatus: invitation.deliveryStatus as InvitationDeliveryStatus,
    expiresAt: invitation.expiresAt,
    lastSentAt: invitation.lastSentAt,
    createdAt: invitation.createdAt,
  };
}

function effectiveInvitationStatus(invitation: WorkspaceInvitation): InvitationStatus {
  if (invitation.status === "pending" && invitation.expiresAt <= new Date().toISOString()) return "expired";
  return invitation.status as InvitationStatus;
}

function invitationExpiry() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

async function invitationTokenFor(id: string, email: string, expiresAt: string) {
  const runtime = env as RuntimeEnv;
  const secret = runtime.GOOGLE_TOKEN_ENCRYPTION_KEY || runtime.OKRI_API_TOKEN || runtime.OKRPTR_API_TOKEN || runtime.PACE_API_TOKEN;
  if (!secret) throw new Error("Invitation signing is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}:${email}:${expiresAt}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invitationEmailConfigured() {
  const runtime = env as RuntimeEnv;
  const settings = invitationEmailSettings(runtime);
  return Boolean(
    runtime.RESEND_API_KEY
    && settings
    && invitationDomainCache?.verified,
  );
}

async function verifyInvitationEmailConfigured() {
  const runtime = env as RuntimeEnv;
  const settings = invitationEmailSettings(runtime);
  if (!runtime.RESEND_API_KEY || !settings) return false;
  if (invitationDomainCache && Date.now() - invitationDomainCache.checkedAt < 5 * 60 * 1000) {
    return invitationDomainCache.verified;
  }
  let verified = false;
  try {
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${runtime.RESEND_API_KEY}`, "User-Agent": "OKRI/1.0" },
    });
    if (response.ok) {
      const payload = await response.json() as { data?: Array<{ name?: string; status?: string; capabilities?: { sending?: string } }> };
      verified = Boolean(payload.data?.some((domain) => domain.name === settings.domain && domain.status === "verified" && domain.capabilities?.sending === "enabled"));
    }
  } catch {
    verified = false;
  }
  invitationDomainCache = { verified, checkedAt: Date.now() };
  return verified;
}

function invitationEmailSettings(runtime: RuntimeEnv) {
  const sender = runtime.OKRI_INVITE_FROM || runtime.OKRPTR_INVITE_FROM;
  if (sender === "OKRI <invite@send.okri.ai>") return { sender, domain: "send.okri.ai" };
  if (sender === "OKRI <invite@send.okrptr.com>") return { sender, domain: "send.okrptr.com" };
  if (sender === "OKRPTR <invite@send.okrptr.com>") return { sender, domain: "send.okrptr.com" };
  return null;
}

function invitationUrl(token: string) {
  const runtime = env as RuntimeEnv;
  const base = runtime.OKRI_PUBLIC_URL?.trim() || runtime.OKRPTR_PUBLIC_URL?.trim() || "https://okri.ai";
  const url = new URL(base);
  url.hash = `invite=${encodeURIComponent(token)}`;
  return url.toString();
}

async function getPendingWorkspaceInvitation(ownerId: string, invitationId: string) {
  const [invitation] = await getDb().select().from(workspaceInvitations).where(and(
    eq(workspaceInvitations.workspaceId, ownerId),
    eq(workspaceInvitations.id, invitationId),
  )).limit(1);
  if (!invitation) throw new Error("Invitation not found");
  if (invitation.status === "accepted" || invitation.status === "revoked") throw new Error("Invitation is no longer pending");
  return invitation;
}

async function invitationByToken(tokenInput: string) {
  const token = tokenInput.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [invitation] = await getDb().select().from(workspaceInvitations).where(eq(
    workspaceInvitations.tokenHash,
    await hashIntegrationToken(token),
  )).limit(1);
  return invitation ?? null;
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

async function deliverWorkspaceInvitation(invitation: WorkspaceInvitation, token: string) {
  const runtime = env as RuntimeEnv;
  const emailSettings = invitationEmailSettings(runtime);
  const now = new Date().toISOString();
  if (!(await verifyInvitationEmailConfigured())) {
    const values = { deliveryStatus: "unavailable" as const, providerMessageId: null, updatedAt: now };
    await getDb().update(workspaceInvitations).set(values).where(eq(workspaceInvitations.id, invitation.id));
    return { values };
  }
  const [[workspace], [inviter]] = await Promise.all([
    getDb().select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1),
    getDb().select({ displayName: workspaceMembers.displayName }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, invitation.workspaceId),
      eq(workspaceMembers.userId, invitation.invitedByUserId),
    )).limit(1),
  ]);
  if (!workspace) throw new Error("Workspace not found");
  const inviteUrl = invitationUrl(token);
  const workspaceName = escapeHtml(workspace.name);
  const inviterName = escapeHtml(inviter?.displayName || "워크스페이스 관리자");
  const role = escapeHtml(invitation.role.slice(0, 1).toUpperCase() + invitation.role.slice(1));
  let deliveryStatus: InvitationDeliveryStatus = "failed";
  let providerMessageId: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `okri-invite-${invitation.id}-${invitation.tokenHash.slice(0, 16)}`,
        "User-Agent": "OKRI/1.0",
      },
      body: JSON.stringify({
        from: emailSettings?.sender,
        to: [invitation.email],
        subject: `${workspace.name} 워크스페이스 초대`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#252522"><h1 style="font-size:22px">${workspaceName}에 초대받았습니다</h1><p>${inviterName}님이 OKRI 워크스페이스에 <strong>${role}</strong> 역할로 초대했습니다.</p><p><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#252522;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">워크스페이스 가입</a></p><p style="color:#6f6f69;font-size:13px">이 링크는 30일 동안 유효하며 초대받은 이메일과 같은 Google 계정으로 로그인해야 합니다.</p></div>`,
      }),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => ({})) as { id?: string };
      deliveryStatus = "sent";
      providerMessageId = payload.id ?? null;
    }
  } catch {
    deliveryStatus = "failed";
  }
  const values = { deliveryStatus, providerMessageId, lastSentAt: now, updatedAt: now };
  await getDb().update(workspaceInvitations).set(values).where(eq(workspaceInvitations.id, invitation.id));
  return { values };
}

export async function listGroups(authorization: RequestAuthorization, includeArchived = false) {
  const rows = await getDb().select().from(workspaceGroups).where(eq(workspaceGroups.workspaceId, authorization.ownerId));
  const memberships = await getDb()
    .select({
      id: workspaceGroupMembers.id,
      groupId: workspaceGroupMembers.groupId,
      memberId: workspaceGroupMembers.memberId,
      role: workspaceGroupMembers.role,
      createdAt: workspaceGroupMembers.createdAt,
      updatedAt: workspaceGroupMembers.updatedAt,
    })
    .from(workspaceGroupMembers)
    .innerJoin(workspaceGroups, eq(workspaceGroupMembers.groupId, workspaceGroups.id))
    .where(eq(workspaceGroups.workspaceId, authorization.ownerId));
  const currentMember = await getCurrentWorkspaceMember(authorization);
  const administrator = canManageTeam(authorization);

  return rows
    .filter((group) => includeArchived || !group.archived)
    .filter((group) => group.visibility === "open" || administrator || memberships.some((entry) => entry.groupId === group.id && entry.memberId === currentMember?.id))
    .map((group) => serializeGroup(group, memberships.filter((entry) => entry.groupId === group.id), currentMember?.id ?? null, administrator))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function createGroup(
  authorization: RequestAuthorization,
  input: { name: string; handle?: string; description?: string; color?: GroupColor; visibility?: GroupVisibility },
) {
  if (!canManageTeam(authorization)) throw new Error("Owner or Admin access is required");
  const name = cleanGroupName(input.name);
  const description = cleanGroupDescription(input.description ?? "");
  const color = requireGroupColor(input.color ?? "gray");
  const visibility = requireGroupVisibility(input.visibility ?? "open");
  const handle = input.handle
    ? await requireAvailableGroupHandle(authorization.ownerId, input.handle)
    : await nextAvailableGroupHandle(authorization.ownerId, name);
  const now = new Date().toISOString();
  const group: WorkspaceGroup = {
    id: crypto.randomUUID(),
    workspaceId: authorization.ownerId,
    name,
    handle,
    description,
    color,
    visibility,
    archived: false,
    createdByUserId: authorization.userId,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(workspaceGroups).values(group);

  const creator = await getCurrentWorkspaceMember(authorization);
  if (creator) {
    await getDb().insert(workspaceGroupMembers).values({
      id: crypto.randomUUID(),
      groupId: group.id,
      memberId: creator.id,
      role: "lead",
      createdAt: now,
      updatedAt: now,
    });
  }
  return getVisibleGroup(authorization, group.id, true);
}

export async function updateGroup(
  authorization: RequestAuthorization,
  id: string,
  patch: Partial<{ name: string; handle: string; description: string; color: GroupColor; visibility: GroupVisibility; archived: boolean }>,
) {
  const context = await getGroupContext(authorization, id);
  if (!context.visible) throw new Error("Group not found");
  const canEdit = context.administrator || context.currentMembership?.role === "lead";
  if (!canEdit) throw new Error("Group Lead, Owner, or Admin access is required");
  if (context.group.archived && !context.administrator && patch.archived !== false) throw new Error("Archived groups can only be changed by an Owner or Admin");
  if (patch.archived !== undefined && !context.administrator) throw new Error("Only an Owner or Admin can archive or restore a group");

  const values: Partial<WorkspaceGroup> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) values.name = cleanGroupName(patch.name);
  if (patch.description !== undefined) values.description = cleanGroupDescription(patch.description);
  if (patch.color !== undefined) values.color = requireGroupColor(patch.color);
  if (patch.visibility !== undefined) values.visibility = requireGroupVisibility(patch.visibility);
  if (patch.handle !== undefined) values.handle = await requireAvailableGroupHandle(authorization.ownerId, patch.handle, id);
  if (patch.archived !== undefined) values.archived = patch.archived;
  await getDb().update(workspaceGroups).set(values).where(and(eq(workspaceGroups.workspaceId, authorization.ownerId), eq(workspaceGroups.id, id)));
  return getVisibleGroup(authorization, id, true);
}

export async function deleteGroup(authorization: RequestAuthorization, id: string) {
  if (!canManageTeam(authorization)) throw new Error("Owner or Admin access is required");
  const group = await getWorkspaceGroup(authorization.ownerId, id);
  if (!group.archived) throw new Error("Archive the group before deleting it permanently");
  await getDb().delete(workspaceGroups).where(and(eq(workspaceGroups.workspaceId, authorization.ownerId), eq(workspaceGroups.id, id)));
  return { deleted: true, id: group.id, name: group.name };
}

export async function listGroupMembers(authorization: RequestAuthorization, groupId: string) {
  const context = await getGroupContext(authorization, groupId);
  if (!context.visible) throw new Error("Group not found");
  const rows = await getDb()
    .select({ relation: workspaceGroupMembers, member: workspaceMembers })
    .from(workspaceGroupMembers)
    .innerJoin(workspaceMembers, eq(workspaceGroupMembers.memberId, workspaceMembers.id))
    .where(eq(workspaceGroupMembers.groupId, groupId));
  const members = rows
    .filter(({ member }) => member.workspaceId === authorization.ownerId)
    .map(({ relation, member }) => serializeGroupMember(relation, member, authorization.userId))
    .sort((left, right) => Number(right.groupRole === "lead") - Number(left.groupRole === "lead") || left.displayName.localeCompare(right.displayName));
  return {
    group: serializeGroup(context.group, rows.map(({ relation }) => relation), context.currentMember?.id ?? null, context.administrator),
    members,
    canManageMembers: !context.group.archived && (context.administrator || context.currentMembership?.role === "lead"),
  };
}

export async function addGroupMember(authorization: RequestAuthorization, groupId: string, memberId: string, role: GroupRole = "member") {
  const context = await requireGroupManager(authorization, groupId);
  requireGroupRole(role);
  const member = await getWorkspaceMember(authorization.ownerId, memberId);
  if (role === "lead" && member.role === "viewer") throw new Error("A Viewer cannot be assigned as a Group Lead");
  const [existing] = await getDb().select().from(workspaceGroupMembers).where(and(eq(workspaceGroupMembers.groupId, groupId), eq(workspaceGroupMembers.memberId, memberId))).limit(1);
  if (existing) throw new Error("This member is already in the group");
  const now = new Date().toISOString();
  const relation: WorkspaceGroupMember = { id: crypto.randomUUID(), groupId: context.group.id, memberId: member.id, role, createdAt: now, updatedAt: now };
  await getDb().insert(workspaceGroupMembers).values(relation);
  return serializeGroupMember(relation, member, authorization.userId);
}

export async function updateGroupMember(authorization: RequestAuthorization, groupId: string, memberId: string, role: GroupRole) {
  await requireGroupManager(authorization, groupId);
  requireGroupRole(role);
  const member = await getWorkspaceMember(authorization.ownerId, memberId);
  if (role === "lead" && member.role === "viewer") throw new Error("A Viewer cannot be assigned as a Group Lead");
  const relation = await getGroupMemberRelation(groupId, memberId);
  const updated = { ...relation, role, updatedAt: new Date().toISOString() };
  await getDb().update(workspaceGroupMembers).set({ role, updatedAt: updated.updatedAt }).where(eq(workspaceGroupMembers.id, relation.id));
  return serializeGroupMember(updated, member, authorization.userId);
}

export async function removeGroupMember(authorization: RequestAuthorization, groupId: string, memberId: string) {
  await requireGroupManager(authorization, groupId);
  await getWorkspaceMember(authorization.ownerId, memberId);
  const relation = await getGroupMemberRelation(groupId, memberId);
  await getDb().delete(workspaceGroupMembers).where(eq(workspaceGroupMembers.id, relation.id));
  return { deleted: true, groupId, memberId };
}

async function getVisibleGroup(authorization: RequestAuthorization, id: string, includeArchived = false) {
  const groups = await listGroups(authorization, includeArchived);
  const group = groups.find((entry) => entry.id === id);
  if (!group) throw new Error("Group not found");
  return group;
}

async function getGroupContext(authorization: RequestAuthorization, id: string) {
  const group = await getWorkspaceGroup(authorization.ownerId, id);
  const currentMember = await getCurrentWorkspaceMember(authorization);
  const [currentMembership] = currentMember
    ? await getDb().select().from(workspaceGroupMembers).where(and(eq(workspaceGroupMembers.groupId, id), eq(workspaceGroupMembers.memberId, currentMember.id))).limit(1)
    : [];
  const administrator = canManageTeam(authorization);
  return {
    group,
    currentMember,
    currentMembership: currentMembership ?? null,
    administrator,
    visible: group.visibility === "open" || administrator || Boolean(currentMembership),
  };
}

async function requireGroupManager(authorization: RequestAuthorization, groupId: string) {
  const context = await getGroupContext(authorization, groupId);
  if (!context.visible) throw new Error("Group not found");
  if (context.group.archived) throw new Error("Restore the group before changing its members");
  if (!context.administrator && context.currentMembership?.role !== "lead") throw new Error("Group Lead, Owner, or Admin access is required");
  return context;
}

async function getCurrentWorkspaceMember(authorization: RequestAuthorization) {
  const [direct] = await getDb().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, authorization.ownerId), eq(workspaceMembers.userId, authorization.userId))).limit(1);
  if (direct) return direct;
  if (!authorization.apiToken) return null;
  const [owner] = await getDb().select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, authorization.ownerId), eq(workspaceMembers.role, "owner"))).limit(1);
  return owner ?? null;
}

async function getWorkspaceGroup(ownerId: string, id: string) {
  const [group] = await getDb().select().from(workspaceGroups).where(and(eq(workspaceGroups.workspaceId, ownerId), eq(workspaceGroups.id, id))).limit(1);
  if (!group) throw new Error("Group not found");
  return group;
}

async function getGroupMemberRelation(groupId: string, memberId: string) {
  const [relation] = await getDb().select().from(workspaceGroupMembers).where(and(eq(workspaceGroupMembers.groupId, groupId), eq(workspaceGroupMembers.memberId, memberId))).limit(1);
  if (!relation) throw new Error("Group member not found");
  return relation;
}

function serializeGroup(
  group: WorkspaceGroup,
  memberships: Pick<WorkspaceGroupMember, "memberId" | "role">[],
  currentMemberId: string | null,
  administrator: boolean,
) {
  const currentMembership = memberships.find((entry) => entry.memberId === currentMemberId);
  return {
    id: group.id,
    name: group.name,
    handle: group.handle,
    description: group.description,
    color: group.color as GroupColor,
    visibility: group.visibility as GroupVisibility,
    archived: group.archived,
    memberCount: memberships.length,
    isMember: Boolean(currentMembership),
    isLead: currentMembership?.role === "lead",
    canEdit: administrator || currentMembership?.role === "lead",
    canArchive: administrator,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function serializeGroupMember(relation: WorkspaceGroupMember, member: WorkspaceMember, currentUserId: string) {
  return {
    id: relation.id,
    memberId: member.id,
    email: member.email ?? "",
    displayName: member.displayName || member.email?.split("@")[0] || "Member",
    status: member.status as "invited" | "active",
    workspaceRole: member.role as TeamRole,
    groupRole: relation.role as GroupRole,
    isCurrent: member.userId === currentUserId,
    createdAt: relation.createdAt,
  };
}

function cleanGroupName(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Group name is required");
  if (name.length > 80) throw new Error("Group name must be 80 characters or fewer");
  return name;
}

function cleanGroupDescription(value: string) {
  const description = value.trim();
  if (description.length > 500) throw new Error("Group description must be 500 characters or fewer");
  return description;
}

function normalizeGroupHandle(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
}

async function requireAvailableGroupHandle(ownerId: string, input: string, exceptId?: string) {
  const handle = normalizeGroupHandle(input);
  if (!handle) throw new Error("Group handle is required");
  const [existing] = await getDb().select().from(workspaceGroups).where(and(eq(workspaceGroups.workspaceId, ownerId), eq(workspaceGroups.handle, handle))).limit(1);
  if (existing && existing.id !== exceptId) throw new Error(`The group handle @${handle} is already in use`);
  return handle;
}

async function nextAvailableGroupHandle(ownerId: string, name: string) {
  const base = normalizeGroupHandle(name) || "group";
  for (let number = 1; number <= 100; number += 1) {
    const suffix = number === 1 ? "" : `-${number}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    const [existing] = await getDb().select({ id: workspaceGroups.id }).from(workspaceGroups).where(and(eq(workspaceGroups.workspaceId, ownerId), eq(workspaceGroups.handle, candidate))).limit(1);
    if (!existing) return candidate;
  }
  throw new Error("Unable to create a unique group handle");
}

function requireGroupColor(value: GroupColor) {
  if (!GROUP_COLORS.includes(value)) throw new Error("Unsupported group color");
  return value;
}

function requireGroupVisibility(value: GroupVisibility) {
  if (!GROUP_VISIBILITIES.includes(value)) throw new Error("Unsupported group visibility");
  return value;
}

function requireGroupRole(value: GroupRole) {
  if (!GROUP_ROLES.includes(value)) throw new Error("Unsupported group role");
  return value;
}

export async function listItems(
  ownerId: string,
  filter: {
    kind?: ItemKind;
    status?: ItemStatus;
    cadence?: ItemCadence;
    parentId?: string;
    query?: string;
    limit?: number;
    includeArchived?: boolean;
  } = {},
) {
  const conditions = [eq(items.ownerId, ownerId)];
  if (!filter.includeArchived && filter.status !== "archived") conditions.push(isNull(items.archivedAt));
  if (filter.kind) conditions.push(eq(items.kind, filter.kind));
  if (filter.status) conditions.push(eq(items.status, filter.status));
  if (filter.cadence) conditions.push(eq(items.cadence, filter.cadence));
  if (filter.parentId) conditions.push(eq(items.parentId, filter.parentId));
  if (filter.query) {
    conditions.push(
      or(
        like(items.title, `%${filter.query}%`),
        like(items.description, `%${filter.query}%`),
      )!,
    );
  }

  return getDb()
    .select()
    .from(items)
    .where(and(...conditions))
    .orderBy(asc(items.sortOrder), desc(items.createdAt))
    .limit(Math.min(filter.limit ?? 200, 200));
}

export async function getItem(ownerId: string, id: string) {
  const [item] = await getDb()
    .select()
    .from(items)
    .where(and(eq(items.ownerId, ownerId), eq(items.id, id)))
    .limit(1);
  return item ?? null;
}

export async function createOkrPlan(ownerId: string, userId: string, input: OkrPlanInput) {
  await ensureWorkspace(ownerId);
  const cycleId = input.cycleId.trim();
  if (!cycleId) throw new Error("cycleId is required");
  const [cycle] = await getDb().select({ id: okrCycles.id }).from(okrCycles).where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, cycleId))).limit(1);
  if (!cycle) throw new Error("OKR cycle not found");

  const tree = normalizeOkrPlanTree(input);
  const projectTitle = cleanPlanTitle(input.project);
  const targetKind = input.targetKind ?? null;
  const targetId = input.targetId?.trim() || null;
  const rules = await getWorkspaceRules(ownerId);
  const createdAt = new Date().toISOString();
  const specs: Array<{ id: string; kind: ItemKind; title: string; parentId: string | null; status: ItemStatus; sortOrder: number }> = [];
  let objectiveId: string | null = null;
  let target: PaceItem | null = null;

  const addSpec = (kind: ItemKind, title: string, parentId: string | null, status: ItemStatus, sortOrder: number) => {
    const id = crypto.randomUUID();
    specs.push({ id, kind, title, parentId, status, sortOrder });
    return id;
  };
  const addKeyResults = (parentId: string, keyResults: typeof tree.keyResults) => {
    for (const [keyResultIndex, keyResult] of keyResults.entries()) {
      const keyResultId = addSpec("key_result", keyResult.title, parentId, "todo", (keyResultIndex + 1) * 10);
      for (const [initiativeIndex, initiative] of keyResult.initiatives.entries()) {
        addSpec("initiative", initiative.title, keyResultId, "todo", (initiativeIndex + 1) * 10);
      }
    }
  };

  if (!targetId) {
    if (targetKind) throw new Error("targetId is required when targetKind is provided");
    if (!tree.objectiveTitle || !tree.keyResults.length) throw new Error("Objective and at least one Key Result are required");
    objectiveId = addSpec("objective", tree.objectiveTitle, null, "in_progress", 0);
    addKeyResults(objectiveId, tree.keyResults);
  } else {
    if (!targetKind) throw new Error("targetKind is required when targetId is provided");
    target = await getItem(ownerId, targetId);
    if (!target || target.archivedAt) throw new Error("Target item not found");
    if (target.kind !== targetKind) throw new Error("Target item kind does not match");
    if (target.cycleId !== cycleId) throw new Error("Target item must belong to the selected OKR cycle");
    if (targetKind === "objective") {
      if (!tree.keyResults.length) throw new Error("At least one Key Result is required");
      objectiveId = target.id;
      addKeyResults(target.id, tree.keyResults);
    } else if (targetKind === "key_result") {
      if (!tree.targetInitiatives.length) throw new Error("At least one Initiative is required");
      for (const [index, initiative] of tree.targetInitiatives.entries()) {
        addSpec("initiative", initiative.title, target.id, "todo", (index + 1) * 10);
      }
    }
  }

  if (projectTitle) {
    const initiativeParents = targetKind === "initiative" && target ? [target.id] : specs.filter((entry) => entry.kind === "initiative").map((entry) => entry.id);
    if (initiativeParents.length !== 1) throw new Error("Project requires one selected Initiative");
    addSpec("project", projectTitle, initiativeParents[0], "in_progress", 10);
  } else if (targetKind === "initiative" && !specs.length) {
    throw new Error("Project is required for an Initiative target");
  }
  if (!specs.length) throw new Error("No OKR plan content to create");

  const projectSpec = specs.find((entry) => entry.kind === "project");
  const projectQuotaReservation = projectSpec ? await reserveProjectCreation(ownerId) : null;
  let driMemberId = input.driMemberId?.trim() || null;
  if (projectSpec) {
    if (!driMemberId) {
      const [currentMember] = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
        eq(workspaceMembers.workspaceId, ownerId),
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, "active"),
      )).limit(1);
      driMemberId = currentMember?.id ?? null;
    } else {
      const [member] = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
        eq(workspaceMembers.workspaceId, ownerId),
        eq(workspaceMembers.id, driMemberId),
        eq(workspaceMembers.status, "active"),
      )).limit(1);
      if (!member) throw new Error("Project DRI must be an active workspace member");
    }
  }

  const d1 = (env as RuntimeEnv).DB;
  const statements = specs.flatMap((spec) => [
    d1.prepare(`INSERT INTO items
      (id, owner_id, cycle_id, parent_id, kind, title, description, status, priority, cadence, progress, sort_order, source, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?, 'web', ?, ?, ?)`)
      .bind(spec.id, ownerId, cycleId, spec.parentId, spec.kind, spec.title, spec.status, rules.defaultPriority, rules.defaultCadence, spec.sortOrder, userId, createdAt, createdAt),
    d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
      VALUES (?, ?, ?, 'created', 'web', ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, spec.id, JSON.stringify({ kind: spec.kind, status: spec.status, origin: "okr_assistant" }), createdAt),
  ]);
  if (projectSpec && driMemberId) {
    statements.push(d1.prepare(`INSERT INTO item_assignments
      (id, owner_id, item_id, member_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'project_dri', ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, projectSpec.id, driMemberId, createdAt, createdAt));
  }
  statements.push(d1.prepare("UPDATE workspace_rules SET configured = 1, updated_at = ? WHERE workspace_id = ?").bind(createdAt, ownerId));
  try {
    await d1.batch(statements);
  } catch (error) {
    await releaseProjectCreation(projectQuotaReservation);
    throw error;
  }

  const rows = await getDb().select().from(items).where(and(eq(items.ownerId, ownerId), inArray(items.id, specs.map((entry) => entry.id))));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const assignments = await getItemAssignmentMap(ownerId, specs.map((entry) => entry.id));
  const createdItems = specs.map((spec) => serializeItem(byId.get(spec.id)!, {}, assignments[spec.id] ?? []));
  const keyResultIds = specs.filter((entry) => entry.kind === "key_result").map((entry) => entry.id);
  const initiativeIds = specs.filter((entry) => entry.kind === "initiative").map((entry) => entry.id);
  const projectIds = specs.filter((entry) => entry.kind === "project").map((entry) => entry.id);
  return {
    items: createdItems,
    cycleId,
    objectiveId,
    keyResultIds,
    initiativeIds,
    projectIds,
    keyResultId: keyResultIds[0] ?? (targetKind === "key_result" ? targetId : null),
    initiativeId: initiativeIds[0] ?? (targetKind === "initiative" ? targetId : null),
    projectId: projectIds[0] ?? null,
  };
}

function normalizeOkrPlanTree(input: OkrPlanInput) {
  const explicitTree = input.tree;
  const objectiveTitle = cleanPlanTitle(explicitTree?.objectiveTitle) || cleanPlanTitle(input.objective);
  const rawKeyResults = explicitTree?.keyResults ?? (cleanPlanTitle(input.keyResult) ? [{
    title: cleanPlanTitle(input.keyResult),
    initiatives: cleanPlanTitle(input.initiative) ? [{ title: cleanPlanTitle(input.initiative) }] : [],
  }] : []);
  const rawTargetInitiatives = explicitTree?.targetInitiatives ?? (input.targetKind === "key_result" && cleanPlanTitle(input.initiative)
    ? [{ title: cleanPlanTitle(input.initiative) }]
    : []);
  if (rawKeyResults.length > 20) throw new Error("A plan supports at most 20 Key Results");
  if (rawTargetInitiatives.length > 30) throw new Error("A Key Result supports at most 30 Initiatives per plan");

  const keyResults = rawKeyResults.map((entry) => {
    const title = cleanPlanTitle(entry.title);
    if (!title) throw new Error("Key Result title is required");
    const rawInitiatives = entry.initiatives ?? [];
    if (rawInitiatives.length > 30) throw new Error("A Key Result supports at most 30 Initiatives per plan");
    return {
      title,
      initiatives: rawInitiatives.map((initiative) => {
        const initiativeTitle = cleanPlanTitle(initiative.title);
        if (!initiativeTitle) throw new Error("Initiative title is required");
        return { title: initiativeTitle };
      }),
    };
  });
  const targetInitiatives = rawTargetInitiatives.map((initiative) => {
    const title = cleanPlanTitle(initiative.title);
    if (!title) throw new Error("Initiative title is required");
    return { title };
  });
  if (input.targetKind === "key_result" && keyResults.length) throw new Error("A Key Result target only accepts Initiatives");
  if (input.targetKind !== "key_result" && targetInitiatives.length) throw new Error("Target Initiatives require a Key Result target");
  return { objectiveTitle, keyResults, targetInitiatives };
}

function cleanPlanTitle(value: string | undefined) {
  return value?.trim().slice(0, 500) ?? "";
}

export async function createLinkedTasks(
  ownerId: string,
  input: {
    titles: string[];
    projectId?: string | null;
    routineId?: string | null;
    assigneeMemberId?: string | null;
    createdByUserId: string;
    dueDate?: string | null;
    priority?: ItemPriority;
    cadence?: ItemCadence;
    source?: string;
  },
) {
  await ensureWorkspace(ownerId);
  const titles = [...new Set(input.titles.map((title) => title.trim().slice(0, 500)).filter(Boolean))];
  if (!titles.length) throw new Error("At least one Task title is required");
  if (titles.length > 50) throw new Error("At most 50 Tasks can be created at once");

  const projectId = input.projectId?.trim() || null;
  let routineId = input.routineId?.trim() || null;
  if (projectId && routineId) throw new Error("Tasks can be linked to only one Project or Routine");
  if (!projectId && !routineId) routineId = (await ensureGeneralRoutine(ownerId)).id;

  let cycleId: string | null = null;
  if (projectId) {
    const project = await getItem(ownerId, projectId);
    if (!project || project.kind !== "project" || project.archivedAt) throw new Error("Active Project not found");
    cycleId = project.cycleId;
  } else if (routineId) {
    const routine = await getRoutine(ownerId, routineId);
    if (!routine || !routine.active) throw new Error("Active Routine not found");
  }
  await validateParent(ownerId, "task", projectId, routineId, cycleId);

  const assigneeMemberId = input.assigneeMemberId?.trim() || null;
  if (assigneeMemberId) {
    const [member] = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, ownerId),
      eq(workspaceMembers.id, assigneeMemberId),
      eq(workspaceMembers.status, "active"),
    )).limit(1);
    if (!member) throw new Error("Task assignee must be an active workspace member");
  }

  const rules = await getWorkspaceRules(ownerId);
  const now = new Date().toISOString();
  const d1 = (env as RuntimeEnv).DB;
  const source = input.source ?? "web";
  const taskRows = titles.map((title) => ({ id: crypto.randomUUID(), title }));
  await d1.batch(taskRows.flatMap((task) => [
    d1.prepare(`INSERT INTO items
      (id, owner_id, cycle_id, parent_id, routine_id, kind, title, description, status, priority, cadence, progress, source, created_by_user_id, sort_order, created_at, updated_at, due_date)
      VALUES (?, ?, ?, ?, ?, 'task', ?, '', 'todo', ?, ?, 0, ?, ?, 0, ?, ?, ?)`)
      .bind(task.id, ownerId, cycleId, projectId, routineId, task.title, input.priority ?? rules.defaultPriority, input.cadence ?? rules.defaultCadence, source, input.createdByUserId, now, now, input.dueDate ?? null),
    d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, task.id, source, JSON.stringify({ kind: "task", status: "todo" }), now),
    ...(assigneeMemberId ? [d1.prepare(`INSERT INTO item_assignments
      (id, owner_id, item_id, member_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'task_assignee', ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, task.id, assigneeMemberId, now, now)] : []),
  ]));

  const createdRows = await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    inArray(items.id, taskRows.map((task) => task.id)),
  ));
  const createdById = new Map(createdRows.map((item) => [item.id, item]));
  const created = taskRows.flatMap((task) => {
    const item = createdById.get(task.id);
    return item ? [item] : [];
  });
  for (const item of created) await dispatchSlackAutomationEvent(ownerId, { triggerType: "task_created", item });
  return created;
}

export async function createItem(
  ownerId: string,
  input: {
    title: string;
    kind?: ItemKind;
    cycleId?: string | null;
    parentId?: string | null;
    routineId?: string | null;
    description?: string;
    status?: ItemStatus;
    priority?: ItemPriority;
    cadence?: ItemCadence;
    progress?: number;
    dueDate?: string | null;
    source?: string;
    sourceRef?: string | null;
    templateId?: string | null;
    createdByUserId?: string | null;
  },
) {
  await ensureWorkspace(ownerId);
  const kind = input.kind ?? "task";
  const projectProperties = kind === "project" ? await listProjectPropertyDefinitions(ownerId) : [];
  const systemDefault = (key: string) => parsePropertyValue(projectProperties.find((property) => property.systemKey === key)?.defaultValue ?? "null");
  const defaultParentId = systemDefault("parent_id");
  const parentId = input.parentId ?? (typeof defaultParentId === "string" ? defaultParentId : null);
  let routineId = input.routineId ?? null;
  const source = input.source ?? "web";
  if (kind === "task" && !parentId && !routineId) {
    routineId = (await ensureGeneralRoutine(ownerId)).id;
  }
  if (kind === "task" && source === "web" && routineId) {
    const routine = await getRoutine(ownerId, routineId);
    if (!routine || !routine.active) throw new Error("Web Tasks must use an active Routine");
  }
  const defaultStatus = systemDefault("status");
  const status = kind === "task"
    ? normalizeTaskStatus(input.status)
    : input.status ?? (typeof defaultStatus === "string" && ITEM_STATUSES.includes(defaultStatus as ItemStatus) ? defaultStatus as ItemStatus : "todo");
  const cycleId = input.cycleId === undefined ? await defaultCycleIdForKind(ownerId, kind) : input.cycleId;
  await validateParent(ownerId, kind, parentId, routineId, cycleId);
  const rules = await getWorkspaceRules(ownerId);
  const defaultPriority = systemDefault("priority");
  const defaultCadence = systemDefault("cadence");
  const defaultDueDate = systemDefault("due_date");
  if (input.templateId) {
    const template = await getProjectTemplate(ownerId, input.templateId);
    if (!template) throw new Error("Template not found");
    if (kind !== "project") throw new Error("Templates can only be applied to Projects");
  }

  const initialProgress = kind === "task"
    ? status === "done" ? 100 : 0
    : kind === "objective" || kind === "initiative" ? 0 : clampProgress(input.progress ?? 0);
  const id = crypto.randomUUID();
  const quotaReservation = kind === "project" ? await reserveProjectCreation(ownerId) : null;
  let created: PaceItem;
  try {
    [created] = await getDb()
      .insert(items)
      .values({
      id,
      ownerId,
      cycleId,
      parentId,
      routineId,
      kind,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      status,
      priority: input.priority ?? (typeof defaultPriority === "string" && ITEM_PRIORITIES.includes(defaultPriority as ItemPriority) ? defaultPriority as ItemPriority : rules.defaultPriority),
      cadence: input.cadence ?? (typeof defaultCadence === "string" && ITEM_CADENCES.includes(defaultCadence as ItemCadence) ? defaultCadence as ItemCadence : rules.defaultCadence),
      progress: initialProgress,
      dueDate: input.dueDate ?? (typeof defaultDueDate === "string" ? defaultDueDate : null),
      source,
      sourceRef: input.sourceRef ?? null,
      createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
  } catch (error) {
    await releaseProjectCreation(quotaReservation);
    throw error;
  }

  if (kind === "project") {
    for (const property of projectProperties.filter((entry) => !entry.systemKey)) {
      const defaultValue = parsePropertyValue(property.defaultValue);
      if (defaultValue !== null) await setPropertyValue(ownerId, created.id, property.id, defaultValue);
    }
    const defaultDri = systemDefault("project_dri");
    const defaultWorkers = systemDefault("project_workers");
    if (typeof defaultDri === "string") await replaceItemAssignmentRole(ownerId, created.id, "project_dri", [defaultDri]);
    if (Array.isArray(defaultWorkers)) await replaceItemAssignmentRole(ownerId, created.id, "project_worker", defaultWorkers);
    if (input.templateId) await applyProjectTemplate(ownerId, created.id, input.templateId, input.createdByUserId);
  }

  const finalCreated = kind === "project" && input.templateId ? await getItem(ownerId, created.id) ?? created : created;
  await logActivity(ownerId, created.id, "created", created.source, { kind, status });
  await dispatchSlackAutomationEvent(ownerId, { triggerType: "task_created", item: finalCreated });
  return finalCreated;
}

export async function updateItem(
  ownerId: string,
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    status: ItemStatus;
    cycleId: string | null;
    priority: ItemPriority;
    cadence: ItemCadence;
    progress: number;
    dueDate: string | null;
    parentId: string | null;
    routineId: string | null;
    source: string;
  }>,
) {
  await ensureWorkspace(ownerId);
  const current = await getItem(ownerId, id);
  if (!current) throw new Error("Item not found");
  if (current.archivedAt) throw new Error("Restore the item before changing it");
  if (patch.status === "archived") throw new Error("Use the Project archive action instead");

  const normalizedPatch = { ...patch };
  if (current.kind === "task") {
    if (normalizedPatch.status !== undefined) normalizedPatch.status = normalizeTaskStatus(normalizedPatch.status);
    delete normalizedPatch.progress;
    if (normalizedPatch.parentId) normalizedPatch.routineId = null;
    if (normalizedPatch.routineId) normalizedPatch.parentId = null;
    const nextParentId = normalizedPatch.parentId === undefined ? current.parentId : normalizedPatch.parentId;
    let nextRoutineId = normalizedPatch.routineId === undefined ? current.routineId : normalizedPatch.routineId;
    if (!nextParentId && !nextRoutineId) {
      nextRoutineId = (await ensureGeneralRoutine(ownerId)).id;
      normalizedPatch.routineId = nextRoutineId;
    }
  }

  if (normalizedPatch.parentId !== undefined || normalizedPatch.status !== undefined || normalizedPatch.routineId !== undefined || normalizedPatch.cycleId !== undefined) {
    await validateParent(
      ownerId,
      current.kind as ItemKind,
      normalizedPatch.parentId === undefined ? current.parentId : normalizedPatch.parentId,
      normalizedPatch.routineId === undefined ? current.routineId : normalizedPatch.routineId,
      normalizedPatch.cycleId === undefined ? current.cycleId : normalizedPatch.cycleId,
    );
  }

  const nextStatus = normalizedPatch.status ?? (current.status as ItemStatus);
  const supportsProgress = current.kind === "key_result" || current.kind === "project";
  if (!supportsProgress) delete normalizedPatch.progress;
  const taskProgress = current.kind === "task" && normalizedPatch.status !== undefined
    ? normalizedPatch.status === "done" ? 100 : 0
    : undefined;
  const values = {
    ...normalizedPatch,
    title: normalizedPatch.title?.trim(),
    description: normalizedPatch.description?.trim(),
    progress: taskProgress ?? (supportsProgress
      ? completedStatuses.has(nextStatus) ? 100 : normalizedPatch.progress === undefined ? undefined : clampProgress(normalizedPatch.progress)
      : undefined),
    updatedAt: new Date().toISOString(),
  };

  const [updated] = await getDb()
    .update(items)
    .set(values)
    .where(and(eq(items.ownerId, ownerId), eq(items.id, id)))
    .returning();

  await logActivity(ownerId, id, "updated", normalizedPatch.source ?? "web", normalizedPatch);
  if (current.status !== updated.status) {
    await dispatchSlackAutomationEvent(ownerId, {
      triggerType: "task_status_changed",
      item: updated,
      fromStatus: current.status,
    });
  }
  return updated;
}

export type ItemAssignmentSummary = {
  id: string;
  memberId: string;
  displayName: string;
  email: string;
  role: ItemAssignmentRole;
};

export class ItemDeletePermissionError extends Error {
  constructor() {
    super("Project는 생성자 또는 책임자만, Task는 생성자 또는 담당자만 삭제할 수 있습니다.");
    this.name = "ItemDeletePermissionError";
  }
}

export async function getItemDeletePermissionMap(ownerId: string, userId: string, itemRows: PaceItem[]) {
  const result: Record<string, boolean> = Object.fromEntries(itemRows.map((item) => [item.id, item.createdByUserId === userId]));
  const unresolved = itemRows.filter((item) => !result[item.id] && (item.kind === "project" || item.kind === "task"));
  if (!unresolved.length) return result;

  const [member] = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, ownerId),
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.status, "active"),
  )).limit(1);
  if (!member) return result;

  const unresolvedById = new Map(unresolved.map((item) => [item.id, item]));
  const assignments = await getDb().select({
    itemId: itemAssignments.itemId,
    role: itemAssignments.role,
  }).from(itemAssignments).where(and(
    eq(itemAssignments.ownerId, ownerId),
    eq(itemAssignments.memberId, member.id),
    inArray(itemAssignments.itemId, unresolved.map((item) => item.id)),
  ));
  for (const assignment of assignments) {
    const item = unresolvedById.get(assignment.itemId);
    if (item?.kind === "project" && assignment.role === "project_dri") result[item.id] = true;
    if (item?.kind === "task" && assignment.role === "task_assignee") result[item.id] = true;
  }
  return result;
}

async function assertItemDeletePermission(ownerId: string, userId: string, itemRows: PaceItem[]) {
  const permissions = await getItemDeletePermissionMap(ownerId, userId, itemRows);
  if (itemRows.some((item) => !permissions[item.id])) throw new ItemDeletePermissionError();
}

export async function getItemAssignmentMap(ownerId: string, itemIds?: string[]) {
  if (itemIds && itemIds.length === 0) return {} as Record<string, ItemAssignmentSummary[]>;
  const conditions = [eq(itemAssignments.ownerId, ownerId)];
  if (itemIds) conditions.push(inArray(itemAssignments.itemId, itemIds));
  const rows = await getDb()
    .select({
      id: itemAssignments.id,
      itemId: itemAssignments.itemId,
      memberId: itemAssignments.memberId,
      displayName: workspaceMembers.displayName,
      email: workspaceMembers.email,
      role: itemAssignments.role,
    })
    .from(itemAssignments)
    .innerJoin(workspaceMembers, eq(itemAssignments.memberId, workspaceMembers.id))
    .where(and(...conditions))
    .orderBy(asc(itemAssignments.createdAt));
  const result: Record<string, ItemAssignmentSummary[]> = {};
  for (const row of rows) {
    result[row.itemId] ??= [];
    result[row.itemId].push({
      id: row.id,
      memberId: row.memberId,
      displayName: row.displayName,
      email: row.email ?? "",
      role: row.role as ItemAssignmentRole,
    });
  }
  return result;
}

export async function replaceItemAssignmentRole(
  ownerId: string,
  itemId: string,
  role: ItemAssignmentRole,
  memberIds: string[],
) {
  if (!ITEM_ASSIGNMENT_ROLES.includes(role)) throw new Error("Unsupported assignment role");
  const item = await getItem(ownerId, itemId);
  if (!item) throw new Error("Item not found");
  if (item.archivedAt) throw new Error("Restore the item before changing assignments");
  const expectedKind = role === "task_assignee" ? "task" : "project";
  if (item.kind !== expectedKind) throw new Error(`${role} can only be used on ${expectedKind}`);
  const uniqueMemberIds = [...new Set(memberIds.filter(Boolean))];
  if (role !== "project_worker" && uniqueMemberIds.length > 1) throw new Error("Only one accountable member is allowed");

  if (uniqueMemberIds.length) {
    const members = await getDb()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, ownerId),
        eq(workspaceMembers.status, "active"),
        inArray(workspaceMembers.id, uniqueMemberIds),
      ));
    if (members.length !== uniqueMemberIds.length) throw new Error("Every assignee must be an active workspace member");
  }

  const now = new Date().toISOString();
  const d1 = (env as RuntimeEnv).DB;
  await d1.batch([
    d1.prepare("DELETE FROM item_assignments WHERE owner_id = ? AND item_id = ? AND role = ? AND member_id NOT IN (SELECT value FROM json_each(?))")
      .bind(ownerId, itemId, role, JSON.stringify(uniqueMemberIds)),
    ...uniqueMemberIds.map((memberId) => d1.prepare(`INSERT INTO item_assignments
      (id, owner_id, item_id, member_id, role, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM item_assignments WHERE owner_id = ? AND item_id = ? AND member_id = ? AND role = ?)`)
      .bind(crypto.randomUUID(), ownerId, itemId, memberId, role, now, now, ownerId, itemId, memberId, role)),
  ]);
  await logActivity(ownerId, itemId, "assignments_updated", "web", { role, memberIds: uniqueMemberIds });
  return (await getItemAssignmentMap(ownerId, [itemId]))[itemId] ?? [];
}

export type TrashedItemRoot = {
  item: PaceItem;
  taskCount: number;
};

export async function listTrashedItems(ownerId: string): Promise<TrashedItemRoot[]> {
  const roots = await getDb()
    .select()
    .from(items)
    .where(and(
      eq(items.ownerId, ownerId),
      inArray(items.kind, ["project", "task"]),
      sql`${items.archivedAt} IS NOT NULL`,
      or(
        eq(items.kind, "project"),
        isNull(items.archiveRootId),
        sql`${items.archiveRootId} = ${items.id}`,
      ),
    ))
    .orderBy(desc(items.archivedAt));
  const archivedTasks = await getDb()
    .select({ archiveRootId: items.archiveRootId })
    .from(items)
    .where(and(eq(items.ownerId, ownerId), eq(items.kind, "task"), sql`${items.archivedAt} IS NOT NULL`));
  const taskCounts = new Map<string, number>();
  for (const task of archivedTasks) {
    if (task.archiveRootId) taskCounts.set(task.archiveRootId, (taskCounts.get(task.archiveRootId) ?? 0) + 1);
  }
  return roots.map((item) => ({ item, taskCount: item.kind === "project" ? taskCounts.get(item.id) ?? 0 : 0 }));
}

export async function listArchivedProjects(ownerId: string) {
  return (await listTrashedItems(ownerId))
    .filter((entry) => entry.item.kind === "project")
    .map((entry) => ({ project: entry.item, taskCount: entry.taskCount }));
}

export async function trashItems(
  ownerId: string,
  userId: string,
  input: { itemIds?: string[]; scope?: "all_project_task" },
) {
  const requestedIds = [...new Set((input.itemIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (input.scope !== "all_project_task" && requestedIds.length === 0) throw new Error("itemIds are required");
  const candidates = await getDb()
    .select()
    .from(items)
    .where(and(
      eq(items.ownerId, ownerId),
      inArray(items.kind, ["project", "task"]),
      isNull(items.archivedAt),
      input.scope === "all_project_task" ? undefined : inArray(items.id, requestedIds),
    ));
  if (!candidates.length) return { trashedRootIds: [] as string[], projectCount: 0, taskCount: 0, affectedItemCount: 0 };
  if (input.scope !== "all_project_task" && candidates.length !== requestedIds.length) {
    throw new Error("One or more Project or Task items were not found");
  }

  const projectIds = new Set(candidates.filter((item) => item.kind === "project").map((item) => item.id));
  const candidateTasks = candidates.filter((item) => item.kind === "task");
  const deletionRoots = [
    ...candidates.filter((item) => item.kind === "project"),
    ...candidateTasks.filter((item) => !item.parentId || !projectIds.has(item.parentId)),
  ];
  await assertItemDeletePermission(ownerId, userId, deletionRoots);
  const unselectedParentIds = [...new Set(candidateTasks
    .map((item) => item.parentId)
    .filter((parentId): parentId is string => typeof parentId === "string" && !projectIds.has(parentId)))];
  const archivedParentProjects = unselectedParentIds.length
    ? await getDb().select({ id: items.id }).from(items).where(and(
      eq(items.ownerId, ownerId),
      eq(items.kind, "project"),
      inArray(items.id, unselectedParentIds),
      sql`${items.archivedAt} IS NOT NULL`,
    ))
    : [];
  const archivedParentProjectIds = new Set(archivedParentProjects.map((project) => project.id));
  const taskIdsByArchivedParent = new Map<string, string[]>();
  const standaloneTaskIds: string[] = [];
  for (const task of candidateTasks) {
    if (task.parentId && projectIds.has(task.parentId)) continue;
    if (task.parentId && archivedParentProjectIds.has(task.parentId)) {
      taskIdsByArchivedParent.set(task.parentId, [...(taskIdsByArchivedParent.get(task.parentId) ?? []), task.id]);
    } else {
      standaloneTaskIds.push(task.id);
    }
  }
  const selectedProjectIds = [...projectIds];
  const projectTaskRows = selectedProjectIds.length
    ? await getDb().select({ id: items.id }).from(items).where(and(
      eq(items.ownerId, ownerId),
      eq(items.kind, "task"),
      inArray(items.parentId, selectedProjectIds),
      isNull(items.archivedAt),
    ))
    : [];
  const now = new Date().toISOString();
  const d1 = (env as RuntimeEnv).DB;
  const statements = [
    ...selectedProjectIds.flatMap((projectId) => [
      d1.prepare(`UPDATE items
        SET archived_from_status = CASE
              WHEN archived_at IS NULL OR archived_from_status IS NULL THEN status
              ELSE archived_from_status
            END,
            status = 'archived',
            archived_at = COALESCE(archived_at, ?),
            archive_root_id = ?,
            updated_at = ?
        WHERE owner_id = ? AND (id = ? OR (parent_id = ? AND kind = 'task'))`)
        .bind(now, projectId, now, ownerId, projectId, projectId),
      d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
        VALUES (?, ?, ?, 'item_trashed', 'web', ?, ?)`)
        .bind(crypto.randomUUID(), ownerId, projectId, JSON.stringify({ rootId: projectId, kind: "project" }), now),
    ]),
    ...[...taskIdsByArchivedParent.entries()].flatMap(([projectId, taskIds]) => [
      d1.prepare(`UPDATE items
        SET archived_from_status = CASE
              WHEN archived_from_status IS NULL THEN status
              ELSE archived_from_status
            END,
            status = 'archived', archived_at = ?, archive_root_id = ?, updated_at = ?
        WHERE owner_id = ? AND kind = 'task' AND archived_at IS NULL
          AND id IN (${taskIds.map(() => "?").join(", ")})`)
        .bind(now, projectId, now, ownerId, ...taskIds),
      d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
        VALUES (?, ?, ?, 'item_trashed', 'web', ?, ?)`)
        .bind(crypto.randomUUID(), ownerId, projectId, JSON.stringify({ rootId: projectId, kind: "project", addedTaskCount: taskIds.length }), now),
    ]),
    ...standaloneTaskIds.flatMap((taskId) => [
      d1.prepare(`UPDATE items
        SET archived_from_status = CASE
              WHEN archived_from_status IS NULL THEN status
              ELSE archived_from_status
            END,
            status = 'archived', archived_at = ?, archive_root_id = id, updated_at = ?
        WHERE owner_id = ? AND id = ? AND kind = 'task' AND archived_at IS NULL`)
        .bind(now, now, ownerId, taskId),
      d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
        VALUES (?, ?, ?, 'item_trashed', 'web', ?, ?)`)
        .bind(crypto.randomUUID(), ownerId, taskId, JSON.stringify({ rootId: taskId, kind: "task" }), now),
    ]),
  ];
  if (statements.length) await d1.batch(statements);
  const appendedTaskIds = [...taskIdsByArchivedParent.values()].flat();
  const trashedTaskIds = new Set([...projectTaskRows.map((entry) => entry.id), ...appendedTaskIds, ...standaloneTaskIds]);
  return {
    trashedRootIds: [...new Set([...selectedProjectIds, ...taskIdsByArchivedParent.keys(), ...standaloneTaskIds])],
    projectCount: selectedProjectIds.length,
    taskCount: trashedTaskIds.size,
    affectedItemCount: selectedProjectIds.length + trashedTaskIds.size,
  };
}

export async function restoreTrashedItems(ownerId: string, itemIds: string[], projectParentIds: Record<string, string> = {}) {
  const requestedIds = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
  if (!requestedIds.length) throw new Error("itemIds are required");
  const roots = await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    inArray(items.id, requestedIds),
    inArray(items.kind, ["project", "task"]),
    sql`${items.archivedAt} IS NOT NULL`,
  ));
  if (roots.length !== requestedIds.length) throw new Error("One or more trashed items were not found");
  const now = new Date().toISOString();
  const d1 = (env as RuntimeEnv).DB;
  const statements: D1PreparedStatement[] = [];
  let restoredCount = 0;
  for (const root of roots) {
    if (root.kind === "project") {
      const requestedParentId = projectParentIds[root.id]?.trim() || null;
      const currentParent = root.parentId ? await getItem(ownerId, root.parentId) : null;
      const selectedParent = requestedParentId ? await getItem(ownerId, requestedParentId) : currentParent;
      if (!selectedParent || selectedParent.kind !== "initiative" || selectedParent.archivedAt || !selectedParent.cycleId) {
        throw new Error("Project restore requires a target Initiative");
      }
      const [{ count }] = await getDb().select({ count: sql<number>`count(*)` }).from(items).where(and(
        eq(items.ownerId, ownerId),
        or(eq(items.id, root.id), eq(items.archiveRootId, root.id)),
      ));
      restoredCount += Number(count ?? 0);
      statements.push(d1.prepare(`UPDATE items
        SET status = CASE
              WHEN archived_from_status IS NULL OR archived_from_status = 'archived' THEN 'backlog'
              ELSE archived_from_status
            END,
            parent_id = ?, cycle_id = ?,
            archived_at = NULL, archived_from_status = NULL, archive_root_id = NULL, updated_at = ?
        WHERE owner_id = ? AND id = ? AND kind = 'project'`)
        .bind(selectedParent.id, selectedParent.cycleId, now, ownerId, root.id));
      statements.push(d1.prepare(`UPDATE items
        SET status = CASE WHEN archived_from_status IS NULL OR archived_from_status = 'archived' THEN 'todo' ELSE archived_from_status END,
            cycle_id = ?, archived_at = NULL, archived_from_status = NULL, archive_root_id = NULL, updated_at = ?
        WHERE owner_id = ? AND kind = 'task' AND (parent_id = ? OR archive_root_id = ?)`)
        .bind(selectedParent.cycleId, now, ownerId, root.id, root.id));
    } else {
      let parentActive = false;
      if (root.parentId) {
        const parent = await getItem(ownerId, root.parentId);
        parentActive = Boolean(parent && parent.kind === "project" && !parent.archivedAt);
      }
      let routineId = root.routineId;
      if (!parentActive) {
        const routine = routineId ? await getRoutine(ownerId, routineId) : null;
        routineId = routine ? routine.id : (await ensureGeneralRoutine(ownerId)).id;
      }
      statements.push(d1.prepare(`UPDATE items
        SET status = CASE WHEN archived_from_status IS NULL OR archived_from_status = 'archived' THEN 'todo' ELSE archived_from_status END,
            parent_id = ?, routine_id = ?, archived_at = NULL, archived_from_status = NULL,
            archive_root_id = NULL, updated_at = ?
        WHERE owner_id = ? AND id = ? AND kind = 'task'`)
        .bind(parentActive ? root.parentId : null, parentActive ? null : routineId, now, ownerId, root.id));
      restoredCount += 1;
    }
    statements.push(d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
      VALUES (?, ?, ?, 'item_restored', 'web', ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, root.id, JSON.stringify({ rootId: root.id, kind: root.kind }), now));
  }
  await d1.batch(statements);
  return { restored: true, restoredRootIds: roots.map((root) => root.id), restoredCount };
}

export async function permanentlyDeleteTrashedItems(ownerId: string, userId: string, itemIds: string[], confirmationText: string) {
  if (confirmationText !== "영구 삭제") throw new Error("Permanent deletion confirmation does not match");
  const requestedIds = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
  if (!requestedIds.length) throw new Error("itemIds are required");
  const roots = await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    inArray(items.id, requestedIds),
    inArray(items.kind, ["project", "task"]),
    sql`${items.archivedAt} IS NOT NULL`,
  ));
  if (roots.length !== requestedIds.length) throw new Error("One or more trashed items were not found");
  await assertItemDeletePermission(ownerId, userId, roots);
  const projectIds = new Set(roots.filter((root) => root.kind === "project").map((root) => root.id));
  const standaloneTaskIds = roots.filter((root) => root.kind === "task" && (!root.parentId || !projectIds.has(root.parentId))).map((root) => root.id);
  const affectedRows = await getDb().select({ id: items.id, kind: items.kind }).from(items).where(and(
    eq(items.ownerId, ownerId),
    or(
      selectedIdCondition(items.id, standaloneTaskIds),
      selectedIdCondition(items.id, [...projectIds]),
      selectedIdCondition(items.archiveRootId, [...projectIds]),
      selectedIdCondition(items.parentId, [...projectIds]),
    ),
  ));
  const affectedIds = [...new Set(affectedRows.map((row) => row.id))];
  if (!affectedIds.length) return { deleted: true, deletedRootIds: [] as string[], deletedProjectCount: 0, deletedTaskCount: 0, deletedItemCount: 0 };
  const placeholders = affectedIds.map(() => "?").join(", ");
  const d1 = (env as RuntimeEnv).DB;
  await d1.batch([
    d1.prepare(`DELETE FROM activity_log WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM google_calendar_events WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM checklist_items WHERE owner_id = ? AND task_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM item_property_values WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM item_assignments WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM project_documents WHERE owner_id = ? AND project_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM project_hidden_properties WHERE owner_id = ? AND project_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`UPDATE slack_automation_deliveries SET item_id = NULL WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...affectedIds),
    d1.prepare(`DELETE FROM items WHERE owner_id = ? AND id IN (${placeholders})`).bind(ownerId, ...affectedIds),
  ]);
  return {
    deleted: true,
    deletedRootIds: roots.map((root) => root.id),
    deletedProjectCount: affectedRows.filter((row) => row.kind === "project").length,
    deletedTaskCount: affectedRows.filter((row) => row.kind === "task").length,
    deletedItemCount: affectedRows.length,
  };
}

function selectedIdCondition(column: typeof items.id | typeof items.parentId | typeof items.archiveRootId, ids: string[]) {
  return ids.length ? inArray(column, ids) : sql`0 = 1`;
}

export async function archiveProject(ownerId: string, userId: string, projectId: string) {
  const project = await getItem(ownerId, projectId);
  if (!project || project.kind !== "project") throw new Error("Project not found");
  if (project.archivedAt) throw new Error("Project is already archived");
  const result = await trashItems(ownerId, userId, { itemIds: [projectId] });
  return { project: (await getItem(ownerId, projectId))!, affectedCount: result.affectedItemCount };
}

export async function restoreProject(ownerId: string, projectId: string) {
  const project = await getItem(ownerId, projectId);
  if (!project || project.kind !== "project") throw new Error("Project not found");
  if (!project.archivedAt) throw new Error("Project is not archived");
  const result = await restoreTrashedItems(ownerId, [projectId]);
  return { project: (await getItem(ownerId, projectId))!, affectedCount: result.restoredCount };
}

export async function permanentlyDeleteArchivedProject(ownerId: string, userId: string, projectId: string, confirmationTitle: string) {
  const project = await getItem(ownerId, projectId);
  if (!project || project.kind !== "project") throw new Error("Project not found");
  if (!project.archivedAt) throw new Error("Archive the Project before deleting it permanently");
  if (confirmationTitle.trim() !== project.title) throw new Error("Project title confirmation does not match");
  const result = await permanentlyDeleteTrashedItems(ownerId, userId, [projectId], "영구 삭제");
  return {
    deleted: true,
    projectId,
    title: project.title,
    deletedTaskCount: result.deletedTaskCount,
    deletedItemCount: result.deletedItemCount,
  };
}

export async function listPropertyDefinitions(ownerId: string) {
  return getDb()
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.ownerId, ownerId))
    .orderBy(asc(propertyDefinitions.sortOrder), asc(propertyDefinitions.createdAt));
}

export async function listProjectPropertyDefinitions(ownerId: string, includeInactive = false) {
  return (await listPropertyDefinitions(ownerId)).filter((property) =>
    (includeInactive || property.active) && (property.systemKey || !isReservedAssignmentPropertyName(property.name)),
  );
}

export async function getPropertyDefinition(ownerId: string, id: string) {
  const [property] = await getDb()
    .select()
    .from(propertyDefinitions)
    .where(and(eq(propertyDefinitions.ownerId, ownerId), eq(propertyDefinitions.id, id)))
    .limit(1);
  return property ?? null;
}

export async function createPropertyDefinition(
  ownerId: string,
  input: { name: string; type: PropertyType; options?: string[]; defaultValue?: PropertyValue },
) {
  const name = input.name.trim();
  if (!name) throw new Error("Property name is required");
  if (!PROPERTY_TYPES.includes(input.type)) throw new Error("Unsupported property type");
  if (isReservedAssignmentPropertyName(name)) throw new Error("Assignment fields are managed as workspace member tags");

  const existing = await listPropertyDefinitions(ownerId);
  if (existing.some((property) => property.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("Property name already exists");
  }

  const [created] = await getDb()
    .insert(propertyDefinitions)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      name,
      type: input.type,
      options: JSON.stringify(normalizeOptions(input.options ?? [])),
      defaultValue: JSON.stringify(normalizePropertyValue({ name, type: input.type, options: JSON.stringify(normalizeOptions(input.options ?? [])) } as PropertyDefinition, input.defaultValue ?? null)),
      active: true,
      sortOrder: (existing.at(-1)?.sortOrder ?? 0) + 10,
    })
    .returning();
  return created;
}

export async function deletePropertyDefinition(ownerId: string, id: string) {
  const property = await getPropertyDefinition(ownerId, id);
  if (!property) throw new Error("Property not found");
  await getDb()
    .update(propertyDefinitions)
    .set({ active: false, updatedAt: new Date().toISOString() })
    .where(and(eq(propertyDefinitions.ownerId, ownerId), eq(propertyDefinitions.id, id)));
  return { ...property, active: false };
}

export async function analyzePropertyTypeChange(
  ownerId: string,
  id: string,
  input: { type: PropertyType; options?: string[] },
) {
  const property = await getPropertyDefinition(ownerId, id);
  if (!property) throw new Error("Property not found");
  const rows = await getDb().select().from(itemPropertyValues).where(and(
    eq(itemPropertyValues.ownerId, ownerId),
    eq(itemPropertyValues.propertyId, id),
  ));
  const candidate = { ...property, type: input.type, options: JSON.stringify(normalizeOptions(input.options ?? [])) };
  let convertibleCount = 0;
  let incompatibleCount = 0;
  for (const row of rows) {
    try {
      normalizePropertyValue(candidate, parsePropertyValue(row.value));
      convertibleCount += 1;
    } catch {
      incompatibleCount += 1;
    }
  }
  return { valueCount: rows.length, convertibleCount, incompatibleCount };
}

export async function updatePropertyDefinition(
  ownerId: string,
  id: string,
  patch: Partial<{ name: string; type: PropertyType; options: string[]; defaultValue: PropertyValue; sortOrder: number; active: boolean }>,
) {
  const property = await getPropertyDefinition(ownerId, id);
  if (!property) throw new Error("Property not found");
  const name = patch.name === undefined ? property.name : patch.name.trim();
  if (!name) throw new Error("Property name is required");
  const type = patch.type ?? property.type as PropertyType;
  if (!PROPERTY_TYPES.includes(type)) throw new Error("Unsupported property type");
  if (!property.systemKey && isReservedAssignmentPropertyName(name)) throw new Error("Assignment fields are managed as workspace member tags");
  const existing = await listPropertyDefinitions(ownerId);
  if (existing.some((entry) => entry.id !== id && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error("Property name already exists");
  }
  const options = patch.options === undefined ? parseOptions(property.options) : normalizeOptions(patch.options);
  const nextDefinition = { ...property, name, type, options: JSON.stringify(options) };
  const nextDefault = patch.defaultValue === undefined
    ? parsePropertyValue(property.defaultValue)
    : normalizePropertyValue(nextDefinition, patch.defaultValue);

  if (type !== property.type || patch.options !== undefined) {
    const rows = await getDb().select().from(itemPropertyValues).where(and(
      eq(itemPropertyValues.ownerId, ownerId),
      eq(itemPropertyValues.propertyId, id),
    ));
    for (const row of rows) {
      try {
        const normalized = normalizePropertyValue(nextDefinition, parsePropertyValue(row.value));
        await getDb().update(itemPropertyValues).set({
          value: JSON.stringify(normalized),
          legacyValue: null,
          updatedAt: new Date().toISOString(),
        }).where(eq(itemPropertyValues.id, row.id));
      } catch {
        await getDb().update(itemPropertyValues).set({
          value: "null",
          legacyValue: row.value,
          updatedAt: new Date().toISOString(),
        }).where(eq(itemPropertyValues.id, row.id));
      }
    }
  }

  const [updated] = await getDb().update(propertyDefinitions).set({
    name,
    type,
    options: JSON.stringify(options),
    defaultValue: JSON.stringify(nextDefault),
    sortOrder: patch.sortOrder ?? property.sortOrder,
    active: patch.active ?? property.active,
    updatedAt: new Date().toISOString(),
  }).where(and(eq(propertyDefinitions.ownerId, ownerId), eq(propertyDefinitions.id, id))).returning();
  return updated;
}

export async function setPropertyValue(
  ownerId: string,
  itemId: string,
  propertyId: string,
  value: PropertyValue,
) {
  const [itemRecord, property] = await Promise.all([
    getItem(ownerId, itemId),
    getPropertyDefinition(ownerId, propertyId),
  ]);
  if (!itemRecord) throw new Error("Item not found");
  if (!property) throw new Error("Property not found");
  if (!property.active) throw new Error("Restore the property before changing its value");
  if (property.systemKey) throw new Error("System properties must be changed through the Project fields");
  if (itemRecord.kind !== "project") throw new Error("Custom properties can only be set on Project items");
  if (itemRecord.archivedAt) throw new Error("Restore the Project before changing its properties");

  const normalized = normalizePropertyValue(property, value);
  if ((property.type === "member" || property.type === "members") && normalized !== null) {
    const memberIds = (Array.isArray(normalized) ? normalized : [normalized]).filter((entry): entry is string => typeof entry === "string");
    const members = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, ownerId),
      eq(workspaceMembers.status, "active"),
      inArray(workspaceMembers.id, memberIds),
    ));
    if (members.length !== new Set(memberIds).size) throw new Error("Property members must be active workspace members");
  }
  if (normalized === null) {
    await getDb()
      .delete(itemPropertyValues)
      .where(
        and(
          eq(itemPropertyValues.ownerId, ownerId),
          eq(itemPropertyValues.itemId, itemId),
          eq(itemPropertyValues.propertyId, propertyId),
        ),
      );
    return null;
  }

  const updatedAt = new Date().toISOString();
  const [stored] = await getDb()
    .insert(itemPropertyValues)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      itemId,
      propertyId,
      value: JSON.stringify(normalized),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [itemPropertyValues.ownerId, itemPropertyValues.itemId, itemPropertyValues.propertyId],
      set: { value: JSON.stringify(normalized), updatedAt },
    })
    .returning();

  await logActivity(ownerId, itemId, "property_updated", "web", {
    propertyId,
    value: normalized,
  });
  return stored;
}

export async function getPropertyValueMap(ownerId: string, itemIds?: string[]) {
  if (itemIds?.length === 0) return {} as Record<string, Record<string, PropertyValue>>;
  const rows = await getDb()
    .select()
    .from(itemPropertyValues)
    .where(and(eq(itemPropertyValues.ownerId, ownerId), itemIds ? inArray(itemPropertyValues.itemId, itemIds) : undefined));
  const result: Record<string, Record<string, PropertyValue>> = {};
  for (const row of rows) {
    result[row.itemId] ??= {};
    result[row.itemId][row.propertyId] = parsePropertyValue(row.value);
  }
  return result;
}

export async function getProjectPropertyValueMap(ownerId: string) {
  const rows = await getDb()
    .select({
      itemId: itemPropertyValues.itemId,
      propertyId: itemPropertyValues.propertyId,
      value: itemPropertyValues.value,
    })
    .from(itemPropertyValues)
    .innerJoin(items, eq(itemPropertyValues.itemId, items.id))
    .where(and(eq(itemPropertyValues.ownerId, ownerId), eq(items.ownerId, ownerId), eq(items.kind, "project")));
  const result: Record<string, Record<string, PropertyValue>> = {};
  for (const row of rows) {
    result[row.itemId] ??= {};
    result[row.itemId][row.propertyId] = parsePropertyValue(row.value);
  }
  return result;
}

export async function getProjectPropertyUsageCounts(ownerId: string) {
  const [values, definitions, projects, assignments] = await Promise.all([
    getProjectPropertyValueMap(ownerId),
    listProjectPropertyDefinitions(ownerId, true),
    getDb().select().from(items).where(and(eq(items.ownerId, ownerId), eq(items.kind, "project"))),
    getDb().select({ itemId: itemAssignments.itemId, role: itemAssignments.role }).from(itemAssignments).where(and(
      eq(itemAssignments.ownerId, ownerId),
      inArray(itemAssignments.role, ["project_dri", "project_worker"]),
    )),
  ]);
  const counts: Record<string, number> = {};
  for (const itemValues of Object.values(values)) {
    for (const propertyId of Object.keys(itemValues)) counts[propertyId] = (counts[propertyId] ?? 0) + 1;
  }
  for (const property of definitions.filter((entry) => entry.systemKey)) {
    if (property.systemKey === "parent_id") counts[property.id] = projects.filter((project) => Boolean(project.parentId)).length;
    else if (property.systemKey === "due_date") counts[property.id] = projects.filter((project) => Boolean(project.dueDate)).length;
    else if (property.systemKey === "project_dri") counts[property.id] = new Set(assignments.filter((entry) => entry.role === "project_dri").map((entry) => entry.itemId)).size;
    else if (property.systemKey === "project_workers") counts[property.id] = new Set(assignments.filter((entry) => entry.role === "project_worker").map((entry) => entry.itemId)).size;
    else counts[property.id] = projects.length;
  }
  return counts;
}

export async function getProjectHiddenPropertyMap(ownerId: string) {
  const rows = await getDb()
    .select()
    .from(projectHiddenProperties)
    .where(eq(projectHiddenProperties.ownerId, ownerId));
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    result[row.projectId] ??= [];
    result[row.projectId].push(row.propertyId);
  }
  return result;
}

export async function setProjectPropertyHidden(
  ownerId: string,
  projectId: string,
  propertyId: string,
  hidden: boolean,
) {
  const [project, property] = await Promise.all([
    getItem(ownerId, projectId),
    getPropertyDefinition(ownerId, propertyId),
  ]);
  if (!project || project.kind !== "project") throw new Error("Project not found");
  if (!property) throw new Error("Property not found");
  if (hidden) {
    await getDb()
      .insert(projectHiddenProperties)
      .values({ id: crypto.randomUUID(), ownerId, projectId, propertyId })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(projectHiddenProperties)
      .where(and(
        eq(projectHiddenProperties.ownerId, ownerId),
        eq(projectHiddenProperties.projectId, projectId),
        eq(projectHiddenProperties.propertyId, propertyId),
      ));
  }
  return { projectId, propertyId, hidden };
}

export async function getItemPropertiesByName(ownerId: string, itemIds?: string[]) {
  if (itemIds?.length === 0) return {} as Record<string, Record<string, PropertyValue>>;
  const [definitions, values] = await Promise.all([
    listProjectPropertyDefinitions(ownerId),
    getPropertyValueMap(ownerId, itemIds),
  ]);
  const names = new Map(definitions.map((property) => [property.id, property.name]));
  const result: Record<string, Record<string, PropertyValue>> = {};
  for (const [itemId, itemValues] of Object.entries(values)) {
    result[itemId] = {};
    for (const [propertyId, value] of Object.entries(itemValues)) {
      const name = names.get(propertyId);
      if (name) result[itemId][name] = value;
    }
  }
  return result;
}

export async function setItemPropertiesByName(
  ownerId: string,
  itemId: string,
  values: Record<string, PropertyValue>,
) {
  const definitions = await listProjectPropertyDefinitions(ownerId);
  const byName = new Map(definitions.map((property) => [property.name.toLocaleLowerCase(), property]));
  for (const [name, value] of Object.entries(values)) {
    const property = byName.get(name.toLocaleLowerCase());
    if (!property) throw new Error(`Property not found: ${name}`);
    await setPropertyValue(ownerId, itemId, property.id, value);
  }
}

/** Preflight MCP values before creating/updating the item, avoiding partial saves on bad input. */
export async function validateItemPropertiesByName(ownerId: string, values: Record<string, PropertyValue>) {
  const definitions = await listProjectPropertyDefinitions(ownerId);
  const byName = new Map(definitions.map((property) => [property.name.toLocaleLowerCase(), property]));
  const memberIds = new Set<string>();
  const prepared: { property: PropertyDefinition; value: PropertyValue }[] = [];
  for (const [name, value] of Object.entries(values)) {
    const property = byName.get(name.toLocaleLowerCase());
    if (!property) throw new Error(`Property not found: ${name}`);
    if (property.systemKey) throw new Error("System properties must be changed through the Project fields");
    const normalized = normalizePropertyValue(property, value);
    prepared.push({ property, value: normalized });
    if ((property.type === "member" || property.type === "members") && normalized !== null) {
      for (const memberId of Array.isArray(normalized) ? normalized : [normalized]) {
        if (typeof memberId === "string") memberIds.add(memberId);
      }
    }
  }
  if (memberIds.size) {
    const found = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, ownerId), eq(workspaceMembers.status, "active"), sql`${workspaceMembers.id} IN (SELECT value FROM json_each(${JSON.stringify([...memberIds])}))`,
    ));
    if (found.length !== memberIds.size) throw new Error("Property members must be active workspace members");
  }
  return prepared;
}

function isReservedAssignmentPropertyName(name: string) {
  return reservedAssignmentPropertyNames.has(name.trim().toLocaleLowerCase());
}

export function serializePropertyDefinition(property: PropertyDefinition, valueCount = 0) {
  return {
    id: property.id,
    name: property.name,
    type: property.type,
    options: parseOptions(property.options),
    defaultValue: parsePropertyValue(property.defaultValue),
    systemKey: property.systemKey,
    active: property.active,
    sortOrder: property.sortOrder,
    valueCount,
  };
}

export async function getProjectDocument(ownerId: string, projectId: string) {
  const project = await getItem(ownerId, projectId);
  if (!project || project.kind !== "project") throw new Error("Project not found");
  const [document] = await getDb().select().from(projectDocuments).where(and(
    eq(projectDocuments.ownerId, ownerId),
    eq(projectDocuments.projectId, projectId),
  )).limit(1);
  if (document) return serializeProjectDocument(document);
  return {
    id: null,
    projectId,
    content: JSON.stringify(blocksFromPlainText(project.description)),
    plainText: project.description,
    version: 0,
    updatedAt: project.updatedAt,
  };
}

export async function saveProjectDocument(
  ownerId: string,
  projectId: string,
  input: { content: string; plainText: string; expectedVersion: number; userId?: string | null },
) {
  const project = await getItem(ownerId, projectId);
  if (!project || project.kind !== "project") throw new Error("Project not found");
  if (project.archivedAt) throw new Error("Restore the Project before changing its document");
  const content = normalizeBlockContent(input.content);
  const plainText = normalizeDocumentText(input.plainText);
  const [current] = await getDb().select().from(projectDocuments).where(and(
    eq(projectDocuments.ownerId, ownerId),
    eq(projectDocuments.projectId, projectId),
  )).limit(1);
  const currentVersion = current?.version ?? 0;
  if (input.expectedVersion !== currentVersion) throw new Error("Document version conflict");
  const now = new Date().toISOString();
  const nextVersion = currentVersion + 1;
  const d1 = (env as RuntimeEnv).DB;
  const documentStatement = current
    ? d1.prepare(`UPDATE project_documents
        SET content = ?, plain_text = ?, version = ?, updated_by_user_id = ?, updated_at = ?
        WHERE owner_id = ? AND project_id = ? AND version = ?`)
      .bind(content, plainText, nextVersion, input.userId ?? null, now, ownerId, projectId, currentVersion)
    : d1.prepare(`INSERT INTO project_documents
        (id, owner_id, project_id, content, plain_text, version, updated_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, projectId, content, plainText, nextVersion, input.userId ?? null, now, now);
  await d1.batch([
    documentStatement,
    d1.prepare(`UPDATE items SET description = ?, updated_at = ?
        WHERE owner_id = ? AND id = ? AND EXISTS (
          SELECT 1 FROM project_documents
          WHERE owner_id = ? AND project_id = ? AND version = ? AND updated_at = ?
        )`)
      .bind(plainText, now, ownerId, projectId, ownerId, projectId, nextVersion, now),
  ]);
  const [saved] = await getDb().select().from(projectDocuments).where(and(
    eq(projectDocuments.ownerId, ownerId),
    eq(projectDocuments.projectId, projectId),
  )).limit(1);
  if (!saved) throw new Error("Project document could not be saved");
  if (saved.version !== nextVersion || saved.updatedAt !== now) throw new Error("Document version conflict");
  await logActivity(ownerId, projectId, "project_document_updated", "web", { version: nextVersion });
  return serializeProjectDocument(saved);
}

export async function listProjectTemplates(ownerId: string) {
  const rows = await getDb().select().from(projectTemplates).where(eq(projectTemplates.ownerId, ownerId)).orderBy(
    desc(projectTemplates.updatedAt),
    asc(projectTemplates.name),
  );
  return rows.map(serializeProjectTemplate);
}

export async function getProjectTemplate(ownerId: string, id: string) {
  const [template] = await getDb().select().from(projectTemplates).where(and(
    eq(projectTemplates.ownerId, ownerId),
    eq(projectTemplates.id, id),
  )).limit(1);
  return template ?? null;
}

export async function createProjectTemplate(
  ownerId: string,
  input: { name: string; description?: string; content?: string; plainText?: string; userId?: string | null },
) {
  const name = normalizeTemplateName(input.name);
  const existing = await listProjectTemplates(ownerId);
  if (existing.some((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Template name already exists");
  const now = new Date().toISOString();
  const [created] = await getDb().insert(projectTemplates).values({
    id: crypto.randomUUID(),
    ownerId,
    name,
    description: normalizeTemplateDescription(input.description ?? ""),
    content: normalizeBlockContent(input.content ?? "[]"),
    plainText: normalizeDocumentText(input.plainText ?? ""),
    createdByUserId: input.userId ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return serializeProjectTemplate(created);
}

export async function updateProjectTemplate(
  ownerId: string,
  id: string,
  patch: Partial<{ name: string; description: string; content: string; plainText: string }>,
) {
  const template = await getProjectTemplate(ownerId, id);
  if (!template) throw new Error("Template not found");
  const name = patch.name === undefined ? template.name : normalizeTemplateName(patch.name);
  if (name.toLocaleLowerCase() !== template.name.toLocaleLowerCase()) {
    const existing = await listProjectTemplates(ownerId);
    if (existing.some((entry) => entry.id !== id && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Template name already exists");
  }
  const [updated] = await getDb().update(projectTemplates).set({
    name,
    description: patch.description === undefined ? template.description : normalizeTemplateDescription(patch.description),
    content: patch.content === undefined ? template.content : normalizeBlockContent(patch.content),
    plainText: patch.plainText === undefined ? template.plainText : normalizeDocumentText(patch.plainText),
    updatedAt: new Date().toISOString(),
  }).where(and(eq(projectTemplates.ownerId, ownerId), eq(projectTemplates.id, id))).returning();
  return serializeProjectTemplate(updated);
}

export async function deleteProjectTemplate(ownerId: string, id: string) {
  const template = await getProjectTemplate(ownerId, id);
  if (!template) throw new Error("Template not found");
  await getDb().delete(projectTemplates).where(and(eq(projectTemplates.ownerId, ownerId), eq(projectTemplates.id, id)));
  return { deleted: true, id, name: template.name };
}

export async function applyProjectTemplate(ownerId: string, projectId: string, templateId: string, userId?: string | null) {
  const template = await getProjectTemplate(ownerId, templateId);
  if (!template) throw new Error("Template not found");
  const document = await getProjectDocument(ownerId, projectId);
  const templateBlocks = parseBlockArray(template.content);
  const existingBlocks = parseBlockArray(document.content);
  const content = JSON.stringify([...templateBlocks, ...existingBlocks]);
  const plainText = [template.plainText.trim(), document.plainText.trim()].filter(Boolean).join("\n\n");
  return saveProjectDocument(ownerId, projectId, {
    content,
    plainText,
    expectedVersion: document.version,
    userId,
  });
}

/** Preserve template-prepend semantics for a new Project without writing before approval. */
export function prepareProjectTemplateDocument(template: { content: string; plainText: string }, description: string) {
  const freshBlock = (block: Record<string, unknown>): Record<string, unknown> => ({
    ...block, id: crypto.randomUUID(),
    ...(Array.isArray(block.children) ? { children: block.children.map((child) => freshBlock(child as Record<string, unknown>)) } : {}),
  });
  const content = normalizeBlockContent(JSON.stringify([
    ...parseBlockArray(template.content).map(freshBlock), ...blocksFromPlainText(description).map(freshBlock),
  ]));
  const plainText = normalizeDocumentText([template.plainText.trim(), description.trim()].filter(Boolean).join("\n\n"));
  return { content, plainText };
}

function serializeProjectDocument(document: ProjectDocument) {
  return {
    id: document.id,
    projectId: document.projectId,
    content: document.content,
    plainText: document.plainText,
    version: document.version,
    updatedAt: document.updatedAt,
  };
}

function serializeProjectTemplate(template: ProjectTemplate) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    content: template.content,
    plainText: template.plainText,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function normalizeBlockContent(value: string) {
  if (value.length > 500_000) throw new Error("Project document is too large");
  return JSON.stringify(parseBlockArray(value));
}

function parseBlockArray(value: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Document content must be valid block JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    throw new Error("Document content must be a block array");
  }
  return parsed as Record<string, unknown>[];
}

function blocksFromPlainText(value: string) {
  const lines = value.split(/\r?\n/);
  const blocks = lines.map((line) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) return { type: "heading", props: { level: heading[1].length }, content: heading[2] };
    return { type: "paragraph", content: line };
  });
  return blocks.length ? blocks : [{ type: "paragraph", content: "" }];
}

function normalizeDocumentText(value: string) {
  if (value.length > 200_000) throw new Error("Project document text is too large");
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeTemplateName(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Template name is required");
  if (name.length > 100) throw new Error("Template name is too long");
  return name;
}

function normalizeTemplateDescription(value: string) {
  const description = value.trim();
  if (description.length > 500) throw new Error("Template description is too long");
  return description;
}

export async function getPeriodReview(ownerId: string, cadence: ItemCadence) {
  const now = new Date();
  const days = cadence === "daily" ? 1 : cadence === "weekly" ? 7 : cadence === "monthly" ? 31 : 92;
  const boundary = new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const rows = await getDb()
    .select()
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        isNull(items.archivedAt),
        or(eq(items.cadence, cadence), and(sql`${items.dueDate} IS NOT NULL`, lte(items.dueDate, boundary))),
      ),
    )
    .orderBy(asc(items.dueDate), asc(items.sortOrder))
    .limit(100);

  const completed = rows.filter((item) => completedStatuses.has(item.status as ItemStatus)).length;
  const blocked = rows.filter((item) => item.status === "blocked").length;
  const averageProgress = rows.length
    ? Math.round(rows.reduce((sum, item) => sum + item.progress, 0) / rows.length)
    : 0;

  return { cadence, total: rows.length, completed, blocked, averageProgress, items: rows };
}

export async function listChecklistItems(ownerId: string, taskId: string) {
  await requireTask(ownerId, taskId);
  return getDb()
    .select()
    .from(checklistItems)
    .where(and(eq(checklistItems.ownerId, ownerId), eq(checklistItems.taskId, taskId)))
    .orderBy(asc(checklistItems.sortOrder), asc(checklistItems.createdAt));
}

export async function createChecklistItem(ownerId: string, taskId: string, title: string) {
  await requireTask(ownerId, taskId);
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Checklist title is required");

  const existing = await listChecklistItems(ownerId, taskId);
  const [created] = await getDb()
    .insert(checklistItems)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      taskId,
      title: normalizedTitle,
      sortOrder: (existing.at(-1)?.sortOrder ?? 0) + 10,
    })
    .returning();
  await syncChecklistProgress(ownerId, taskId);
  return created;
}

export async function updateChecklistItem(
  ownerId: string,
  id: string,
  patch: Partial<{ title: string; completed: boolean }>,
) {
  const [current] = await getDb()
    .select()
    .from(checklistItems)
    .where(and(eq(checklistItems.ownerId, ownerId), eq(checklistItems.id, id)))
    .limit(1);
  if (!current) throw new Error("Checklist item not found");

  const values: Partial<typeof checklistItems.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("Checklist title is required");
    values.title = title;
  }
  if (patch.completed !== undefined) values.completed = patch.completed;

  const [updated] = await getDb()
    .update(checklistItems)
    .set(values)
    .where(and(eq(checklistItems.ownerId, ownerId), eq(checklistItems.id, id)))
    .returning();
  await syncChecklistProgress(ownerId, current.taskId);
  return updated;
}

export async function deleteChecklistItem(ownerId: string, id: string) {
  const [current] = await getDb()
    .select()
    .from(checklistItems)
    .where(and(eq(checklistItems.ownerId, ownerId), eq(checklistItems.id, id)))
    .limit(1);
  if (!current) throw new Error("Checklist item not found");

  await getDb()
    .delete(checklistItems)
    .where(and(eq(checklistItems.ownerId, ownerId), eq(checklistItems.id, id)));
  await syncChecklistProgress(ownerId, current.taskId);
  return current;
}

export function serializeChecklistItem(item: typeof checklistItems.$inferSelect) {
  return {
    id: item.id,
    taskId: item.taskId,
    title: item.title,
    completed: item.completed,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function listRoutines(
  ownerId: string,
  requestedDate: string,
  includeInactive = true,
) {
  const date = normalizeDate(requestedDate);
  const routineRows = await getDb()
    .select()
    .from(routines)
    .where(includeInactive ? eq(routines.ownerId, ownerId) : and(eq(routines.ownerId, ownerId), eq(routines.active, true)))
    .orderBy(asc(routines.sortOrder), asc(routines.createdAt));
  const completionRows = await getDb()
    .select()
    .from(routineCompletions)
    .where(and(eq(routineCompletions.ownerId, ownerId), eq(routineCompletions.completionDate, date)));
  const completionByRoutine = new Map(completionRows.map((completion) => [completion.routineId, completion]));
  return routineRows.map((routine) => serializeRoutine(routine, date, completionByRoutine.get(routine.id)));
}

export async function createRoutine(
  ownerId: string,
  input: {
    title: string;
    description?: string;
    triggerPoint?: string;
    actionPlace?: string;
    actionSteps?: string;
    cadence?: RoutineCadence;
    active?: boolean;
    assigneeMemberId?: string | null;
    properties?: unknown;
  },
) {
  const title = input.title.trim();
  if (!title) throw new Error("Routine title is required");
  const cadence = input.cadence ?? "daily";
  if (!ROUTINE_CADENCES.includes(cadence)) throw new Error("Unsupported routine cadence");
  await validateRoutineAssignee(ownerId, input.assigneeMemberId ?? null);
  const properties = await prepareRoutineProperties((env as RuntimeEnv).DB, ownerId, input.properties, true);
  const [last] = await getDb()
    .select({ sortOrder: routines.sortOrder })
    .from(routines)
    .where(eq(routines.ownerId, ownerId))
    .orderBy(desc(routines.sortOrder))
    .limit(1);
  const [created] = await getDb()
    .insert(routines)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      systemKey: null,
      assigneeMemberId: input.assigneeMemberId ?? null,
      title,
      description: input.description?.trim() ?? "",
      triggerPoint: input.triggerPoint?.trim() ?? "",
      actionPlace: input.actionPlace?.trim() ?? "",
      actionSteps: input.actionSteps?.trim() ?? "",
      propertiesJson: JSON.stringify(properties),
      cadence,
      active: input.active ?? true,
      sortOrder: (last?.sortOrder ?? 0) + 10,
    })
    .returning();
  return created;
}

export async function updateRoutine(
  ownerId: string,
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    triggerPoint: string;
    actionPlace: string;
    actionSteps: string;
    cadence: RoutineCadence;
    active: boolean;
    assigneeMemberId: string | null;
    properties: unknown;
  }>,
) {
  const current = await getRoutine(ownerId, id);
  if (!current) throw new Error("Routine not found");
  if (current.systemKey === GENERAL_ROUTINE_SYSTEM_KEY) throw new Error("General routine is protected");
  if (patch.title !== undefined && !patch.title.trim()) throw new Error("Routine title is required");
  if (patch.cadence !== undefined && !ROUTINE_CADENCES.includes(patch.cadence)) {
    throw new Error("Unsupported routine cadence");
  }
  if (patch.assigneeMemberId !== undefined) await validateRoutineAssignee(ownerId, patch.assigneeMemberId);
  const propertyPatch = patch.properties === undefined ? undefined : await prepareRoutineProperties((env as RuntimeEnv).DB, ownerId, patch.properties);
  const [updated] = await getDb()
    .update(routines)
    .set({
      title: patch.title?.trim(),
      description: patch.description?.trim(),
      triggerPoint: patch.triggerPoint?.trim(),
      actionPlace: patch.actionPlace?.trim(),
      actionSteps: patch.actionSteps?.trim(),
      propertiesJson: propertyPatch === undefined ? undefined : sql`json_patch(${routines.propertiesJson}, ${JSON.stringify(propertyPatch)})`,
      cadence: patch.cadence,
      active: patch.active,
      assigneeMemberId: patch.assigneeMemberId,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, id)))
    .returning();
  return updated;
}

export async function deleteRoutine(ownerId: string, id: string) {
  const current = await getRoutine(ownerId, id);
  if (!current) throw new Error("Routine not found");
  if (current.systemKey === GENERAL_ROUTINE_SYSTEM_KEY) throw new Error("General routine is protected");
  const general = await ensureGeneralRoutine(ownerId);
  await getDb()
    .update(items)
    .set({ routineId: general.id, cycleId: null, updatedAt: new Date().toISOString() })
    .where(and(eq(items.ownerId, ownerId), eq(items.routineId, id)));
  await getDb()
    .delete(routineCompletions)
    .where(and(eq(routineCompletions.ownerId, ownerId), eq(routineCompletions.routineId, id)));
  await getDb()
    .delete(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, id)));
  return current;
}

export async function setRoutineCompletion(
  ownerId: string,
  routineId: string,
  completionDate: string,
  completed: boolean,
  note = "",
) {
  const date = normalizeDate(completionDate);
  const routine = await getRoutine(ownerId, routineId);
  if (!routine) throw new Error("Routine not found");
  if (routine.systemKey === GENERAL_ROUTINE_SYSTEM_KEY) throw new Error("General routine cannot be completed");
  if (!completed) {
    await getDb()
      .delete(routineCompletions)
      .where(
        and(
          eq(routineCompletions.ownerId, ownerId),
          eq(routineCompletions.routineId, routineId),
          eq(routineCompletions.completionDate, date),
        ),
      );
  } else {
    await getDb()
      .insert(routineCompletions)
      .values({ id: crypto.randomUUID(), ownerId, routineId, completionDate: date, note: note.trim() })
      .onConflictDoUpdate({
        target: [routineCompletions.ownerId, routineCompletions.routineId, routineCompletions.completionDate],
        set: { note: note.trim() },
      });
  }
  const rows = await listRoutines(ownerId, date);
  return rows.find((entry) => entry.id === routineId)!;
}

async function getRoutine(ownerId: string, id: string) {
  const [routine] = await getDb()
    .select()
    .from(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, id)))
    .limit(1);
  return routine ?? null;
}

async function validateRoutineAssignee(ownerId: string, memberId: string | null) {
  if (!memberId) return;
  const [member] = await getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, ownerId),
    eq(workspaceMembers.id, memberId),
    eq(workspaceMembers.status, "active"),
  )).limit(1);
  if (!member) throw new Error("Routine assignee must be an active workspace member");
}

export function serializeRoutine(
  routine: typeof routines.$inferSelect,
  date: string,
  completion?: typeof routineCompletions.$inferSelect,
) {
  return {
    id: routine.id,
    systemKey: routine.systemKey,
    assigneeMemberId: routine.assigneeMemberId,
    title: routine.title,
    description: routine.description,
    triggerPoint: routine.triggerPoint,
    actionPlace: routine.actionPlace,
    actionSteps: routine.actionSteps,
    properties: parseRoutineProperties(routine.propertiesJson),
    cadence: routine.cadence,
    active: routine.active,
    sortOrder: routine.sortOrder,
    date,
    completed: Boolean(completion),
    completionId: completion?.id ?? null,
    note: completion?.note ?? "",
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  };
}

export async function getDailyScrum(ownerId: string, scrumDate: string) {
  const date = normalizeDate(scrumDate);
  const previousDate = addDays(date, -1);
  const [saved] = await getDb()
    .select()
    .from(dailyScrums)
    .where(and(eq(dailyScrums.ownerId, ownerId), eq(dailyScrums.scrumDate, date)))
    .limit(1);
  const tasks = await listItems(ownerId, { kind: "task", limit: 200 });
  const activeTasks = tasks.filter((task) => task.status !== "done");
  const yesterdayTasks = tasks
    .filter(
      (task) =>
        task.status === "done" &&
        (task.updatedAt.slice(0, 10) === previousDate || task.dueDate === previousDate),
    )
    .slice(0, 8);
  const todayTasks = activeTasks
    .filter(
      (task) =>
        task.status === "in_progress" ||
        task.dueDate === date ||
        (task.dueDate !== null && task.dueDate < date),
    )
    .sort(compareTaskUrgency)
    .slice(0, 8);
  const blockers = tasks.filter((task) => task.status === "blocked").slice(0, 8);

  return {
    date,
    yesterdayNote: saved?.yesterdayNote ?? "",
    todayNote: saved?.todayNote ?? "",
    blockersNote: saved?.blockersNote ?? "",
    yesterdayTasks,
    todayTasks,
    blockers,
    updatedAt: saved?.updatedAt ?? null,
  };
}

export async function saveDailyScrum(
  ownerId: string,
  scrumDate: string,
  input: { yesterdayNote?: string; todayNote?: string; blockersNote?: string },
) {
  const date = normalizeDate(scrumDate);
  const updatedAt = new Date().toISOString();
  await getDb()
    .insert(dailyScrums)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      scrumDate: date,
      yesterdayNote: input.yesterdayNote?.trim() ?? "",
      todayNote: input.todayNote?.trim() ?? "",
      blockersNote: input.blockersNote?.trim() ?? "",
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [dailyScrums.ownerId, dailyScrums.scrumDate],
      set: {
        yesterdayNote: input.yesterdayNote?.trim() ?? "",
        todayNote: input.todayNote?.trim() ?? "",
        blockersNote: input.blockersNote?.trim() ?? "",
        updatedAt,
      },
    });
  return getDailyScrum(ownerId, date);
}

export type RecommendationKind = "blocked" | "overdue" | "due_soon" | "empty_project";
export type Recommendation = {
  id: string;
  kind: RecommendationKind;
  title: string;
  detail: string;
  itemIds: string[];
  score: number;
};

export async function getRecommendations(ownerId: string, requestedDate?: string) {
  const date = normalizeDate(requestedDate ?? new Date().toISOString().slice(0, 10));
  const dueSoon = addDays(date, 3);
  const rows = await listItems(ownerId, { limit: 200 });
  const tasks = rows.filter((item) => item.kind === "task");
  const projects = rows.filter((item) => item.kind === "project");
  const openTasks = tasks.filter((task) => task.status !== "done");
  const recommendations: Recommendation[] = [];

  const blocked = openTasks.filter((task) => task.status === "blocked");
  if (blocked.length) {
    recommendations.push({
      id: "blocked-tasks",
      kind: "blocked",
      title: `막힌 Task ${blocked.length}개를 먼저 해소하세요`,
      detail: "막힘이 길어지면 상위 Project와 Key Result의 진행도도 함께 멈춥니다.",
      itemIds: blocked.map((task) => task.id),
      score: 100,
    });
  }

  const overdue = openTasks.filter((task) => task.dueDate !== null && task.dueDate < date);
  if (overdue.length) {
    recommendations.push({
      id: "overdue-tasks",
      kind: "overdue",
      title: `기한이 지난 Task ${overdue.length}개를 재계획하세요`,
      detail: "완료일을 조정하거나 오늘 실행할 작업으로 명확히 정리하는 편이 좋습니다.",
      itemIds: overdue.map((task) => task.id),
      score: 90,
    });
  }

  const urgent = openTasks.filter(
    (task) =>
      task.dueDate !== null &&
      task.dueDate >= date &&
      task.dueDate <= dueSoon &&
      (task.priority === "high" || task.priority === "urgent"),
  );
  if (urgent.length) {
    recommendations.push({
      id: "due-soon-tasks",
      kind: "due_soon",
      title: `3일 안에 마감되는 중요 Task ${urgent.length}개가 있습니다`,
      detail: "오늘 할 일에 올리거나 담당자와 완료 기준을 확인하세요.",
      itemIds: urgent.map((task) => task.id),
      score: 70,
    });
  }

  const projectIdsWithTasks = new Set(tasks.map((task) => task.parentId).filter(Boolean));
  const emptyProjects = projects.filter((project) => !projectIdsWithTasks.has(project.id));
  if (emptyProjects.length) {
    recommendations.push({
      id: "empty-projects",
      kind: "empty_project",
      title: `실행 Task가 없는 Project ${emptyProjects.length}개를 확인하세요`,
      detail: "다음 행동이 없다면 Project의 범위를 줄이거나 첫 Task를 추가하세요.",
      itemIds: emptyProjects.map((project) => project.id),
      score: 55,
    });
  }

  return recommendations.sort((a, b) => b.score - a.score);
}

export type DataConnectionTargetKind = (typeof DATA_CONNECTION_TARGET_KINDS)[number];
export type DataConnectionSummary = Omit<KrDataConnection, "ownerId"> & { targetKind: DataConnectionTargetKind };
export type DataConnectionInput = Partial<{
  itemId: string;
  name: string;
  endpointUrl: string;
  valuePath: string;
  baselineValue: number;
  targetValue: number;
  unit: string;
  cadence: KrDataCadence;
  active: boolean;
}>;

export async function listDataConnections(ownerId: string, itemId?: string): Promise<DataConnectionSummary[]> {
  await ensureWorkspace(ownerId);
  const conditions = [eq(krDataConnections.ownerId, ownerId)];
  if (itemId) conditions.push(eq(krDataConnections.itemId, itemId));
  const rows = await getDb()
    .select()
    .from(krDataConnections)
    .where(and(...conditions))
    .orderBy(asc(krDataConnections.createdAt));
  const targets = await dataConnectionTargetMap(ownerId, rows.map((connection) => connection.itemId));
  return rows.flatMap((connection) => {
    const targetKind = targets.get(connection.itemId);
    return targetKind ? [serializeDataConnection(connection, targetKind)] : [];
  });
}

export async function createDataConnection(ownerId: string, userId: string, input: DataConnectionInput) {
  await ensureWorkspace(ownerId);
  const itemId = input.itemId?.trim() ?? "";
  const name = input.name?.trim() ?? "";
  const endpointUrl = normalizeKrDataEndpoint(input.endpointUrl ?? "");
  const cadence = normalizeKrDataCadence(input.cadence ?? "daily");
  const baselineValue = finiteMetric(input.baselineValue, "baselineValue");
  const targetValue = finiteMetric(input.targetValue, "targetValue");
  if (!itemId) throw new Error("Data target is required");
  if (!name) throw new Error("Data source name is required");
  if (baselineValue === targetValue) throw new Error("Baseline and target values must be different");
  const target = await requireDataConnectionTarget(ownerId, itemId);
  const now = new Date().toISOString();
  const active = input.active ?? true;
  const [created] = await getDb().insert(krDataConnections).values({
    id: crypto.randomUUID(), ownerId, itemId, name, endpointUrl,
    valuePath: input.valuePath?.trim() ?? "",
    baselineValue, targetValue, unit: input.unit?.trim() ?? "", cadence, active,
    nextSyncAt: active && cadence !== "manual" ? now : null,
    createdByUserId: userId, createdAt: now, updatedAt: now,
  }).returning();
  return serializeDataConnection(created, target.kind as DataConnectionTargetKind);
}

export async function updateDataConnection(ownerId: string, id: string, input: DataConnectionInput) {
  await ensureWorkspace(ownerId);
  const current = await getDataConnection(ownerId, id);
  if (!current) throw new Error("Data connection not found");
  const requestedItemId = input.itemId?.trim();
  if (requestedItemId && requestedItemId !== current.itemId) throw new Error("Data connection target cannot be changed");
  const name = input.name === undefined ? current.name : input.name.trim();
  const endpointUrl = input.endpointUrl === undefined ? current.endpointUrl : normalizeKrDataEndpoint(input.endpointUrl);
  const cadence = input.cadence === undefined ? current.cadence as KrDataCadence : normalizeKrDataCadence(input.cadence);
  const baselineValue = input.baselineValue === undefined ? current.baselineValue : finiteMetric(input.baselineValue, "baselineValue");
  const targetValue = input.targetValue === undefined ? current.targetValue : finiteMetric(input.targetValue, "targetValue");
  const active = input.active ?? current.active;
  if (!name) throw new Error("Data source name is required");
  if (baselineValue === targetValue) throw new Error("Baseline and target values must be different");
  const target = await requireDataConnectionTarget(ownerId, current.itemId);
  const now = new Date().toISOString();
  const [updated] = await getDb().update(krDataConnections).set({
    name, endpointUrl,
    valuePath: input.valuePath === undefined ? current.valuePath : input.valuePath.trim(),
    baselineValue, targetValue,
    unit: input.unit === undefined ? current.unit : input.unit.trim(),
    cadence, active,
    nextSyncAt: active && cadence !== "manual" ? now : null,
    updatedAt: now,
  }).where(and(eq(krDataConnections.ownerId, ownerId), eq(krDataConnections.id, id))).returning();
  if (!updated) throw new Error("Data connection not found");
  return serializeDataConnection(updated, target.kind as DataConnectionTargetKind);
}

export async function deleteDataConnection(ownerId: string, id: string) {
  await ensureWorkspace(ownerId);
  const deleted = await getDb().delete(krDataConnections)
    .where(and(eq(krDataConnections.ownerId, ownerId), eq(krDataConnections.id, id)))
    .returning({ id: krDataConnections.id });
  if (!deleted.length) throw new Error("Data connection not found");
  return { deleted: true, id };
}

export async function syncDataConnection(ownerId: string, id: string) {
  await ensureWorkspace(ownerId);
  return syncKrDataConnectionWithDb((env as RuntimeEnv).DB, ownerId, id);
}

export async function syncDueKrDataConnections() {
  await ensureSchema();
  return syncDueKrDataConnectionsWithDb((env as RuntimeEnv).DB);
}

async function getDataConnection(ownerId: string, id: string) {
  const [connection] = await getDb().select().from(krDataConnections).where(and(
    eq(krDataConnections.ownerId, ownerId), eq(krDataConnections.id, id),
  )).limit(1);
  return connection ?? null;
}

async function requireDataConnectionTarget(ownerId: string, id: string, expectedKind?: DataConnectionTargetKind) {
  const [target] = await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    eq(items.id, id),
    inArray(items.kind, [...DATA_CONNECTION_TARGET_KINDS]),
    isNull(items.archivedAt),
  )).limit(1);
  if (!target || (expectedKind && target.kind !== expectedKind)) throw new Error(expectedKind === "key_result" ? "Key Result not found" : "Data target not found");
  return target;
}

async function dataConnectionTargetMap(ownerId: string, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, DataConnectionTargetKind>();
  const targets = await getDb().select({ id: items.id, kind: items.kind }).from(items).where(and(
    eq(items.ownerId, ownerId),
    inArray(items.id, itemIds),
    inArray(items.kind, [...DATA_CONNECTION_TARGET_KINDS]),
  ));
  return new Map(targets.map((target) => [target.id, target.kind as DataConnectionTargetKind]));
}

function serializeDataConnection(connection: KrDataConnection, targetKind: DataConnectionTargetKind): DataConnectionSummary {
  const { ownerId, ...summary } = connection;
  void ownerId;
  return { ...summary, targetKind };
}

export type KrDataConnectionInput = Omit<DataConnectionInput, "itemId"> & { krItemId?: string };

export async function listKrDataConnections(ownerId: string) {
  const connections = await listDataConnections(ownerId);
  return connections.filter((connection) => connection.targetKind === "key_result").map((connection) => ({ ...connection, krItemId: connection.itemId }));
}

export async function createKrDataConnection(ownerId: string, userId: string, input: KrDataConnectionInput) {
  const itemId = input.krItemId?.trim() ?? "";
  await requireDataConnectionTarget(ownerId, itemId, "key_result");
  const connection = await createDataConnection(ownerId, userId, { ...input, itemId });
  return { ...connection, krItemId: connection.itemId };
}

export async function updateKrDataConnection(ownerId: string, id: string, input: KrDataConnectionInput) {
  const current = await getDataConnection(ownerId, id);
  if (!current) throw new Error("KR data connection not found");
  await requireDataConnectionTarget(ownerId, current.itemId, "key_result");
  const connection = await updateDataConnection(ownerId, id, input);
  return { ...connection, krItemId: connection.itemId };
}

export async function deleteKrDataConnection(ownerId: string, id: string) {
  const current = await getDataConnection(ownerId, id);
  if (!current) throw new Error("KR data connection not found");
  await requireDataConnectionTarget(ownerId, current.itemId, "key_result");
  return deleteDataConnection(ownerId, id);
}

export async function syncKrDataConnection(ownerId: string, id: string) {
  const current = await getDataConnection(ownerId, id);
  if (!current) throw new Error("KR data connection not found");
  await requireDataConnectionTarget(ownerId, current.itemId, "key_result");
  return syncDataConnection(ownerId, id);
}

function normalizeKrDataCadence(value: string): KrDataCadence {
  if (!KR_DATA_CADENCES.includes(value as KrDataCadence)) throw new Error("Unsupported KR data cadence");
  return value as KrDataCadence;
}

function finiteMetric(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function normalizeKrDataEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("A valid API URL is required"); }
  if (url.protocol !== "https:") throw new Error("Data APIs must use HTTPS");
  if (url.username || url.password) throw new Error("API credentials cannot be embedded in the URL");
  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) throw new Error("Private or local API addresses are not supported");
  url.hash = "";
  return url.toString();
}

function isPrivateHostname(hostname: string) {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

async function requireTask(ownerId: string, taskId: string) {
  const task = await getItem(ownerId, taskId);
  if (!task) throw new Error("Task not found");
  if (task.kind !== "task") throw new Error("Checklists can only belong to a Task");
  return task;
}

async function syncChecklistProgress(ownerId: string, taskId: string) {
  const rows = await getDb()
    .select()
    .from(checklistItems)
    .where(and(eq(checklistItems.ownerId, ownerId), eq(checklistItems.taskId, taskId)));
  const progress = rows.length
    ? Math.round((rows.filter((row) => row.completed).length / rows.length) * 100)
    : 0;
  await getDb()
    .update(items)
    .set({ progress, updatedAt: new Date().toISOString() })
    .where(and(eq(items.ownerId, ownerId), eq(items.id, taskId)));
}

function normalizeDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date must use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Date is invalid");
  }
  return value;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compareTaskUrgency(a: PaceItem, b: PaceItem) {
  if (a.status === "blocked" && b.status !== "blocked") return -1;
  if (b.status === "blocked" && a.status !== "blocked") return 1;
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  const priorityWeight: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4 };
  return (priorityWeight[b.priority] ?? 0) - (priorityWeight[a.priority] ?? 0);
}

async function validateParent(
  ownerId: string,
  kind: ItemKind,
  parentId: string | null,
  routineId: string | null = null,
  cycleId?: string | null,
) {
  if (routineId && kind !== "task") {
    throw new Error("Only Task can be linked under Routine");
  }
  if (routineId && parentId) {
    throw new Error("Task can be linked under either Project or Routine");
  }
  if (routineId) {
    const routine = await getRoutine(ownerId, routineId);
    if (!routine) throw new Error("Routine not found");
    return;
  }
  const expected = parentKind[kind];
  if (!expected) {
    if (parentId) throw new Error("Objective cannot have a parent");
    return;
  }

  if (!parentId) {
    throw new Error(`${kind} requires a ${expected} parent`);
  }

  const parent = await getItem(ownerId, parentId);
  if (!parent) throw new Error("Parent item not found");
  if (parent.archivedAt) throw new Error("Restore the parent item before linking work to it");
  if (parent.kind !== expected) {
    throw new Error(`${kind} must be linked under ${expected}`);
  }
  if (cycleId !== undefined && parent.cycleId !== cycleId) {
    throw new Error("Parent and child must belong to the same OKR cycle");
  }
}

async function migrateLegacyHierarchy(ownerId: string) {
  const d1 = (env as RuntimeEnv).DB;
  await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO checklist_items
      (id, owner_id, task_id, title, completed, sort_order, created_at, updated_at)
      SELECT 'legacy-action-' || id, owner_id, parent_id, title,
        CASE WHEN status = 'done' THEN 1 ELSE 0 END,
        sort_order, created_at, updated_at
      FROM items AS action_item
      WHERE action_item.owner_id = ? AND action_item.kind = 'action'
        AND EXISTS (
          SELECT 1 FROM items AS parent_task
          WHERE parent_task.owner_id = action_item.owner_id
            AND parent_task.id = action_item.parent_id
            AND parent_task.kind = 'task'
        )`).bind(ownerId),
    d1.prepare(`DELETE FROM items
      WHERE owner_id = ? AND kind = 'action'
        AND parent_id IN (
          SELECT id FROM items WHERE owner_id = ? AND kind = 'task'
        )`).bind(ownerId, ownerId),
    d1.prepare(`UPDATE items
      SET kind = 'task', parent_id = NULL, status = 'todo', source = 'migration',
        updated_at = CURRENT_TIMESTAMP
      WHERE owner_id = ? AND kind = 'action'`).bind(ownerId),
    d1.prepare(`UPDATE items
      SET parent_id = NULL, routine_id = NULL, status = 'todo', source = 'migration',
        updated_at = CURRENT_TIMESTAMP
      WHERE owner_id = ? AND kind = 'task'
        AND parent_id IN (
          SELECT id FROM items WHERE owner_id = ? AND kind = 'initiative'
        )`).bind(ownerId, ownerId),
    d1.prepare(`UPDATE items
      SET parent_id = NULL, routine_id = NULL, status = 'todo', source = 'migration',
        updated_at = CURRENT_TIMESTAMP
      WHERE owner_id = ? AND kind = 'task'
        AND parent_id IN (
          SELECT id FROM items
          WHERE owner_id = ? AND kind = 'project'
            AND id LIKE 'legacy-project-%' AND source = 'migration'
        )`).bind(ownerId, ownerId),
    d1.prepare(`DELETE FROM items
      WHERE owner_id = ? AND kind = 'project'
        AND id LIKE 'legacy-project-%' AND source = 'migration'`).bind(ownerId),
  ]);
}

async function removeLegacySeedWorkspaceData(ownerId: string) {
  const seedItems = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.ownerId, ownerId), inArray(items.title, LEGACY_SEED_ITEM_TITLES)));
  const seedItemIds = seedItems.map((entry) => entry.id);
  if (seedItemIds.length) {
    await getDb().delete(checklistItems).where(and(eq(checklistItems.ownerId, ownerId), inArray(checklistItems.taskId, seedItemIds)));
    await getDb().delete(itemAssignments).where(and(eq(itemAssignments.ownerId, ownerId), inArray(itemAssignments.itemId, seedItemIds)));
    await getDb().delete(projectHiddenProperties).where(and(eq(projectHiddenProperties.ownerId, ownerId), inArray(projectHiddenProperties.projectId, seedItemIds)));
    await getDb().delete(itemPropertyValues).where(and(eq(itemPropertyValues.ownerId, ownerId), inArray(itemPropertyValues.itemId, seedItemIds)));
    await getDb().delete(items).where(and(eq(items.ownerId, ownerId), inArray(items.id, seedItemIds)));
  }
  await getDb().delete(routines).where(and(eq(routines.ownerId, ownerId), inArray(routines.title, LEGACY_SEED_ROUTINE_TITLES)));
}

async function seedProjectExecutionProperties(ownerId: string) {
  let existing = await listPropertyDefinitions(ownerId);
  // Rename only the old built-in label; keep assignments, values, visibility and custom names.
  const oldDri = existing.find((property) => property.systemKey === "project_dri" && property.name === "DRI");
  if (oldDri && !existing.some((property) => property.name === "책임자")) {
    await getDb().update(propertyDefinitions).set({ name: "책임자", updatedAt: new Date().toISOString() })
      .where(and(eq(propertyDefinitions.ownerId, ownerId), eq(propertyDefinitions.id, oldDri.id), eq(propertyDefinitions.name, "DRI")));
  }
  for (const definition of DEFAULT_PROJECT_EXECUTION_PROPERTIES.filter((entry) => entry.systemKey)) {
    if (existing.some((property) => property.systemKey === definition.systemKey)) continue;
    const legacy = existing.find((property) => !property.systemKey && property.name.toLocaleLowerCase() === definition.name.toLocaleLowerCase())
      ?? (definition.systemKey === "project_dri" ? existing.find((property) => !property.systemKey && property.name.toLocaleLowerCase() === "dri") : undefined);
    if (!legacy) continue;
    await getDb().update(propertyDefinitions).set({
      name: definition.name,
      systemKey: definition.systemKey,
      type: definition.type,
      options: JSON.stringify(normalizeOptions(definition.options ?? [])),
      active: legacy.active,
      updatedAt: new Date().toISOString(),
    }).where(and(eq(propertyDefinitions.ownerId, ownerId), eq(propertyDefinitions.id, legacy.id)));
  }
  existing = await listPropertyDefinitions(ownerId);
  const existingNames = new Set(existing.map((property) => property.name.toLocaleLowerCase()));
  const existingSystemKeys = new Set(existing.map((property) => property.systemKey).filter(Boolean));
  const missing = DEFAULT_PROJECT_EXECUTION_PROPERTIES.filter((property) => property.systemKey
    ? !existingSystemKeys.has(property.systemKey)
    : !existingNames.has(property.name.toLocaleLowerCase()));
  if (!missing.length) return;

  const baseSortOrder = existing.at(-1)?.sortOrder ?? 0;
  await getDb().insert(propertyDefinitions).values(
    missing.map((property, index) => ({
      id: crypto.randomUUID(),
      ownerId,
      name: property.name,
      type: property.type,
      options: JSON.stringify(normalizeOptions(property.options ?? [])),
      defaultValue: JSON.stringify(property.defaultValue ?? null),
      systemKey: property.systemKey ?? null,
      active: true,
      sortOrder: baseSortOrder + ((index + 1) * 10),
    })),
  );
}

async function migrateLegacyItemAssignments(ownerId: string) {
  const d1 = (env as RuntimeEnv).DB;
  await d1.prepare(`INSERT OR IGNORE INTO item_assignments
    (id, owner_id, item_id, member_id, role, created_at, updated_at)
    SELECT 'legacy-assignment-' || ipv.id,
      ipv.owner_id,
      ipv.item_id,
      member.id,
      CASE item.kind WHEN 'project' THEN 'project_dri' ELSE 'task_assignee' END,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM item_property_values AS ipv
    INNER JOIN property_definitions AS property
      ON property.id = ipv.property_id AND property.owner_id = ipv.owner_id
    INNER JOIN items AS item
      ON item.id = ipv.item_id AND item.owner_id = ipv.owner_id
    INNER JOIN workspace_members AS member
      ON member.workspace_id = ipv.owner_id AND member.status = 'active'
      AND LOWER(TRIM(member.display_name)) = LOWER(TRIM(ipv.value, '"@ '))
    WHERE ipv.owner_id = ?
      AND item.kind IN ('project', 'task')
      AND LOWER(TRIM(property.name)) IN ('dri', 'owner', 'assignee', '담당', '담당자', '책임자')
      AND INSTR(TRIM(ipv.value, '"'), ',') = 0
      AND (
        SELECT COUNT(*) FROM workspace_members AS candidate
        WHERE candidate.workspace_id = ipv.owner_id
          AND candidate.status = 'active'
          AND LOWER(TRIM(candidate.display_name)) = LOWER(TRIM(ipv.value, '"@ '))
      ) = 1`).bind(ownerId).run();
}

async function logActivity(
  ownerId: string,
  itemId: string,
  action: string,
  source: string,
  payload: unknown,
) {
  await getDb().insert(activityLog).values({
    id: crypto.randomUUID(),
    ownerId,
    itemId,
    action,
    source,
    payload: JSON.stringify(payload),
  });
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeOptions(options: string[]) {
  return [...new Set(options.map((option) => option.trim()).filter(Boolean))].slice(0, 50);
}

function parseOptions(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((option): option is string => typeof option === "string") : [];
  } catch {
    return [];
  }
}

function parsePropertyValue(value: string): PropertyValue {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean" || parsed === null || (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string"))
      ? parsed
      : null;
  } catch {
    return value;
  }
}

export function normalizePropertyValue(property: PropertyDefinition, value: PropertyValue): PropertyValue {
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  if (property.type === "members") {
    if (!Array.isArray(value)) throw new Error(`${property.name} must be a member list`);
    return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  }
  if (property.type === "member") {
    if (Array.isArray(value) || typeof value !== "string") throw new Error(`${property.name} must be one member`);
    return value.trim() || null;
  }
  if (property.type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`${property.name} must be a number`);
    return number;
  }
  if (property.type === "checkbox") {
    if (typeof value !== "boolean") throw new Error(`${property.name} must be true or false`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${property.name} must be text`);
  const text = value.trim();
  if (!text) return null;
  if (property.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${property.name} must use YYYY-MM-DD`);
  }
  if (property.type === "select" && !parseOptions(property.options).includes(text)) {
    throw new Error(`${property.name} must use one of its configured options`);
  }
  return text;
}

export function serializeItem(
  item: PaceItem,
  properties: Record<string, PropertyValue> = {},
  assignments: ItemAssignmentSummary[] = [],
) {
  const status = item.kind === "task" && item.status !== "archived"
    ? normalizeTaskStatus(item.status as ItemStatus)
    : item.status;
  return {
    id: item.id,
    cycleId: item.cycleId,
    parentId: item.parentId,
    routineId: item.routineId,
    kind: item.kind,
    title: item.title,
    description: item.description,
    status,
    priority: item.priority,
    cadence: item.cadence,
    progress: item.kind === "task" && status !== "archived" ? status === "done" ? 100 : 0 : item.progress,
    dueDate: item.dueDate,
    source: item.source,
    createdByUserId: item.createdByUserId,
    archivedAt: item.archivedAt,
    archivedFromStatus: item.archivedFromStatus,
    archiveRootId: item.archiveRootId,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    properties,
    assignments,
  };
}
