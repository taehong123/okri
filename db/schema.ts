import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    kind: text("kind").notNull().default("team"),
    messageLanguage: text("message_language").notNull().default("ko"),
    deletionRequestedAt: text("deletion_requested_at"),
    scheduledDeletionAt: text("scheduled_deletion_at"),
    deletionRequestedByUserId: text("deletion_requested_by_user_id"),
    avatarKey: text("avatar_key"),
    avatarUpdatedAt: text("avatar_updated_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_workspaces_owner").on(table.ownerUserId),
    uniqueIndex("idx_workspaces_personal_owner")
      .on(table.ownerUserId)
      .where(sql`${table.kind} = 'personal'`),
    index("idx_workspaces_scheduled_deletion").on(table.scheduledDeletionAt),
  ],
);

export const workspaceIdentitySettings = sqliteTable("workspace_identity_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  address: text("address"),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

// Old addresses remain reserved after deletion, so shared links cannot change owners.
export const workspaceAddresses = sqliteTable("workspace_addresses", {
  address: text("address").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_workspace_addresses_workspace").on(table.workspaceId),
  check("workspace_addresses_lowercase", sql`${table.address} = lower(${table.address})`),
]);

export const workspaceIdentityGuards = sqliteTable("workspace_identity_guards", {
  id: text("id").primaryKey(),
  valid: integer("valid").notNull(),
}, (table) => [check("workspace_identity_guard_valid", sql`${table.valid} = 1`)]);

export const appMigrations = sqliteTable(
  "app_migrations",
  {
    id: text("id").primaryKey(),
    appliedAt: text("applied_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const workspaceBackupState = sqliteTable("workspace_backup_state", {
  ownerId: text("owner_id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  lastDailyDate: text("last_daily_date"),
  lastSuccessAt: text("last_success_at"),
  lastAttemptAt: text("last_attempt_at"),
  lastError: text("last_error"),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
});

// Metadata outlives workspace deletion until the separate R2 objects are purged.
export const workspaceBackups = sqliteTable("workspace_backups", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  objectKey: text("object_key").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"),
  schemaVersion: integer("schema_version").notNull().default(1),
  checksum: text("checksum").notNull(),
  byteSize: integer("byte_size").notNull(),
  summary: text("summary").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("idx_workspace_backups_owner_created").on(table.ownerId, table.createdAt),
  index("idx_workspace_backups_expires").on(table.expiresAt),
]);

export const workspaceBackupGuards = sqliteTable("workspace_backup_guards", {
  id: text("id").primaryKey(),
  verified: integer("verified").notNull(),
}, (table) => [check("workspace_backup_guard_verified", sql`${table.verified} = 1`)]);

export const workspaceRestoreLinks = sqliteTable("workspace_restore_links", {
  ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  payload: text("payload").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [uniqueIndex("idx_workspace_restore_links_unique").on(table.ownerId, table.tableName, table.rowId)]);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    emailNormalized: text("email_normalized").notNull(),
    languagePreference: text("language_preference").notNull().default("ko"),
    resolvedLanguage: text("resolved_language").notNull().default("ko"),
    languageRevision: integer("language_revision").notNull().default(0),
    // NULL preserves existing accounts; only new sign-ups opt into first-run setup.
    onboardingState: text("onboarding_state"),
    displayName: text("display_name").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_users_email_normalized").on(table.emailNormalized)],
);

export const nativeAuthCodes = sqliteTable("native_auth_codes", {
  codeHash: text("code_hash").primaryKey().notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  challenge: text("challenge").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
}, table => [index("native_auth_codes_expiry").on(table.expiresAt)]);

export const nativeSessions = sqliteTable("native_sessions", {
  tokenHash: text("token_hash").primaryKey().notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
}, table => [index("native_sessions_user").on(table.userId)]);

export const nativeAppleNonces = sqliteTable("native_apple_nonces", {
  nonceHash: text("nonce_hash").primaryKey().notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});
export const nativeAppleGrants = sqliteTable("native_apple_grants", {
  userId: text("user_id").primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  encryptedToken: text("encrypted_token").notNull(),
});
export const nativeIdentityRevocations = sqliteTable("native_identity_revocations", {
  identityHash: text("identity_hash").primaryKey().notNull(),
  deletedAt: integer("deleted_at").notNull(),
});

export const nativeAccountDeletionGuards = sqliteTable("native_account_deletion_guards", {
  id: text("id").primaryKey().notNull(),
  valid: integer("valid").notNull(),
}, table => [check("native_account_deletion_safe", sql`${table.valid} = 1`)]);

export const authIdentities = sqliteTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastUsedAt: text("last_used_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_auth_identities_provider_subject").on(table.provider, table.providerSubject),
    index("idx_auth_identities_user").on(table.userId),
  ],
);

export const accountRegistrations = sqliteTable(
  "account_registrations",
  {
    userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    encryptedPhone: text("encrypted_phone").notNull().default(""),
    phoneHash: text("phone_hash").notNull().default(""),
    phoneLastFour: text("phone_last_four").notNull().default(""),
    verificationProvider: text("verification_provider").notNull().default(""),
    phoneVerifiedAt: text("phone_verified_at"),
    requiredPrivacyConsentAt: text("required_privacy_consent_at"),
    age14ConfirmedAt: text("age_14_confirmed_at"),
    marketingDataConsent: integer("marketing_data_consent", { mode: "boolean" }).notNull().default(false),
    marketingDataConsentAt: text("marketing_data_consent_at"),
    electronicMarketingConsent: integer("electronic_marketing_consent", { mode: "boolean" }).notNull().default(false),
    electronicMarketingConsentAt: text("electronic_marketing_consent_at"),
    consentVersion: text("consent_version").notNull().default("2026-09-01"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_account_registrations_phone_hash").on(table.phoneHash)],
);

export const accountConsentEvents = sqliteTable(
  "account_consent_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    consentType: text("consent_type").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    policyVersion: text("policy_version").notNull(),
    source: text("source").notNull().default("signup"),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_account_consent_events_user_type").on(table.userId, table.consentType, table.occurredAt)],
);

export const phoneVerificationRequests = sqliteTable(
  "phone_verification_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    encryptedPhone: text("encrypted_phone").notNull(),
    phoneHash: text("phone_hash").notNull(),
    phoneLastFour: text("phone_last_four").notNull(),
    providerSid: text("provider_sid").notNull().default(""),
    status: text("status").notNull().default("pending"),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    verifiedAt: text("verified_at"),
  },
  (table) => [
    index("idx_phone_verification_requests_user_time").on(table.userId, table.requestedAt),
    index("idx_phone_verification_requests_phone_time").on(table.phoneHash, table.requestedAt),
  ],
);

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    email: text("email"),
    displayName: text("display_name").notNull().default(""),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("invited"),
    invitedByUserId: text("invited_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_workspace_members_workspace_user").on(table.workspaceId, table.userId),
    index("idx_workspace_members_user_lookup").on(table.userId, table.status),
    uniqueIndex("idx_workspace_members_workspace_email").on(table.workspaceId, table.email),
    index("idx_workspace_members_workspace_status").on(table.workspaceId, table.status),
  ],
);

export const workspaceInvitations = sqliteTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    displayName: text("display_name").notNull().default(""),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().default(""),
    status: text("status").notNull().default("pending"),
    deliveryStatus: text("delivery_status").notNull().default("not_sent"),
    providerMessageId: text("provider_message_id"),
    invitedByUserId: text("invited_by_user_id").notNull(),
    acceptedByUserId: text("accepted_by_user_id"),
    expiresAt: text("expires_at").notNull(),
    lastSentAt: text("last_sent_at"),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_workspace_invitations_pending_email")
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("idx_workspace_invitations_token")
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} <> ''`),
    index("idx_workspace_invitations_workspace_status").on(table.workspaceId, table.status),
    index("idx_workspace_invitations_email_status").on(table.email, table.status),
  ],
);

export const userWorkspacePreferences = sqliteTable(
  "user_workspace_preferences",
  {
    userId: text("user_id").primaryKey(),
    activeWorkspaceId: text("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_user_workspace_preferences_active").on(table.activeWorkspaceId)],
);

export const workspaceRules = sqliteTable(
  "workspace_rules",
  {
    workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    captureInstruction: text("capture_instruction").notNull().default(""),
    structureInstruction: text("structure_instruction").notNull().default(""),
    routineInstruction: text("routine_instruction").notNull().default(""),
    defaultPriority: text("default_priority").notNull().default("medium"),
    defaultCadence: text("default_cadence").notNull().default("weekly"),
    reviewBeforeCreate: integer("review_before_create", { mode: "boolean" }).notNull().default(true),
    configured: integer("configured", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const integrationTokens = sqliteTable(
  "integration_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    name: text("name").notNull().default("Codex"),
    provider: text("provider", { enum: ["chatgpt", "claude", "claude_code", "other"] }),
    scopes: text("scopes"),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("idx_integration_tokens_hash").on(table.tokenHash),
    index("idx_integration_tokens_workspace_user").on(table.workspaceId, table.userId, table.revokedAt),
  ],
);

export const assistantDrafts = sqliteTable(
  "assistant_drafts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    draftKey: text("draft_key").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_assistant_drafts_owner_user_key").on(table.ownerId, table.userId, table.draftKey),
    index("idx_assistant_drafts_owner_user_updated").on(table.ownerId, table.userId, table.updatedAt),
  ],
);

export const mcpOAuthClients = sqliteTable(
  "mcp_oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    redirectUris: text("redirect_uris").notNull(),
    clientName: text("client_name").notNull().default("ChatGPT"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const mcpOAuthApprovals = sqliteTable(
  "mcp_oauth_approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    requestJson: text("request_json").notNull(),
    csrfHash: text("csrf_hash").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [index("idx_mcp_oauth_approvals_expires").on(table.expiresAt)],
);

export const mcpOAuthCodes = sqliteTable(
  "mcp_oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    authorizationJson: text("authorization_json").notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    scope: text("scope").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [index("idx_mcp_oauth_codes_expires").on(table.expiresAt)],
);

export const okrCycles = sqliteTable(
  "okr_cycles",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    department: text("department").notNull().default(""),
    version: integer("version").notNull().default(1),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_okr_cycles_owner_status").on(table.ownerId, table.status),
    uniqueIndex("idx_okr_cycles_owner_version").on(table.ownerId, table.version),
  ],
);

export const workspaceGroups = sqliteTable(
  "workspace_groups",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    handle: text("handle").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("gray"),
    visibility: text("visibility").notNull().default("open"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_workspace_groups_workspace_handle").on(table.workspaceId, table.handle),
    index("idx_workspace_groups_workspace_archived").on(table.workspaceId, table.archived),
  ],
);

export const workspaceGroupMembers = sqliteTable(
  "workspace_group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull().references(() => workspaceGroups.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_workspace_group_members_unique").on(table.groupId, table.memberId),
    index("idx_workspace_group_members_member").on(table.memberId),
    index("idx_workspace_group_members_group_role").on(table.groupId, table.role),
  ],
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    cycleId: text("cycle_id").references(() => okrCycles.id, { onDelete: "set null" }),
    parentId: text("parent_id"),
    routineId: text("routine_id").references(() => routines.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("medium"),
    cadence: text("cadence").notNull().default("weekly"),
    progress: integer("progress").notNull().default(0),
    dueDate: text("due_date"),
    source: text("source").notNull().default("web"),
    sourceRef: text("source_ref"),
    createdByUserId: text("created_by_user_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: text("archived_at"),
    archivedFromStatus: text("archived_from_status"),
    archiveRootId: text("archive_root_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_items_owner_status").on(table.ownerId, table.status),
    index("idx_items_owner_parent").on(table.ownerId, table.parentId),
    index("idx_items_owner_routine").on(table.ownerId, table.routineId),
    index("idx_items_owner_cadence").on(table.ownerId, table.cadence),
    index("idx_items_owner_cycle").on(table.ownerId, table.cycleId),
    index("idx_items_owner_archived").on(table.ownerId, table.archivedAt),
    index("idx_items_owner_archive_root").on(table.ownerId, table.archiveRootId),
  ],
);

export const itemAssignments = sqliteTable(
  "item_assignments",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_item_assignments_unique").on(table.ownerId, table.itemId, table.memberId, table.role),
    uniqueIndex("idx_item_assignments_single_role")
      .on(table.ownerId, table.itemId, table.role)
      .where(sql`${table.role} IN ('project_dri', 'task_assignee')`),
    index("idx_item_assignments_owner_item").on(table.ownerId, table.itemId),
    index("idx_item_assignments_member").on(table.memberId),
  ],
);

export const krDataConnections = sqliteTable(
  "kr_data_connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    itemId: text("kr_item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    valuePath: text("value_path").notNull().default(""),
    baselineValue: real("baseline_value").notNull().default(0),
    targetValue: real("target_value").notNull(),
    unit: text("unit").notNull().default(""),
    cadence: text("cadence").notNull().default("daily"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastValue: real("last_value"),
    lastSyncStatus: text("last_sync_status").notNull().default("never"),
    lastError: text("last_error").notNull().default(""),
    lastSyncedAt: text("last_synced_at"),
    nextSyncAt: text("next_sync_at"),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_kr_data_connections_owner_kr").on(table.ownerId, table.itemId),
    index("idx_kr_data_connections_due").on(table.active, table.nextSyncAt),
  ],
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    itemId: text("item_id").notNull(),
    action: text("action").notNull(),
    source: text("source").notNull().default("web"),
    payload: text("payload").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_activity_owner_created").on(table.ownerId, table.createdAt),
    index("idx_activity_item").on(table.itemId),
  ],
);

export const localAgentDevices = sqliteTable(
  "local_agent_devices",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull().default("unknown"),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_local_agent_devices_token_hash").on(table.tokenHash),
    index("idx_local_agent_devices_account").on(table.workspaceId, table.userId, table.revokedAt),
    index("idx_local_agent_devices_last_seen").on(table.lastSeenAt),
  ],
);

export const localAgentPairings = sqliteTable(
  "local_agent_pairings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    claimedAt: text("claimed_at"),
    deviceId: text("device_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_local_agent_pairings_code_hash").on(table.codeHash),
    index("idx_local_agent_pairings_account").on(table.workspaceId, table.userId, table.createdAt),
    index("idx_local_agent_pairings_expiry").on(table.expiresAt),
  ],
);

export const localAgentJobs = sqliteTable(
  "local_agent_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").references(() => localAgentDevices.id, { onDelete: "set null" }),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    targetTitle: text("target_title").notNull(),
    instruction: text("instruction").notNull(),
    contextJson: text("context_json").notNull().default("{}"),
    status: text("status").notNull().default("queued"),
    leaseId: text("lease_id"),
    leaseExpiresAt: text("lease_expires_at"),
    progressText: text("progress_text"),
    resultText: text("result_text"),
    errorText: text("error_text"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_local_agent_jobs_account").on(table.workspaceId, table.userId, table.createdAt),
    index("idx_local_agent_jobs_device_status").on(table.deviceId, table.status, table.createdAt),
    index("idx_local_agent_jobs_target").on(table.workspaceId, table.targetKind, table.targetId, table.createdAt),
  ],
);

export const propertyDefinitions = sqliteTable(
  "property_definitions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    options: text("options").notNull().default("[]"),
    defaultValue: text("default_value").notNull().default("null"),
    systemKey: text("system_key"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_property_definitions_owner_name").on(table.ownerId, table.name),
    uniqueIndex("idx_property_definitions_owner_system")
      .on(table.ownerId, table.systemKey)
      .where(sql`${table.systemKey} IS NOT NULL`),
    index("idx_property_definitions_owner_active_sort").on(table.ownerId, table.active, table.sortOrder),
  ],
);

export const itemPropertyValues = sqliteTable(
  "item_property_values",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull().references(() => propertyDefinitions.id, { onDelete: "cascade" }),
    value: text("value").notNull().default("null"),
    legacyValue: text("legacy_value"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_item_property_values_unique").on(table.ownerId, table.itemId, table.propertyId),
    index("idx_item_property_values_owner_item").on(table.ownerId, table.itemId),
    index("idx_item_property_values_owner_property").on(table.ownerId, table.propertyId),
  ],
);

export const projectDocuments = sqliteTable(
  "project_documents",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    content: text("content").notNull().default("[]"),
    plainText: text("plain_text").notNull().default(""),
    version: integer("version").notNull().default(1),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_project_documents_project").on(table.ownerId, table.projectId),
    index("idx_project_documents_owner_updated").on(table.ownerId, table.updatedAt),
  ],
);

export const projectImages = sqliteTable(
  "project_images",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    objectKey: text("object_key").notNull(),
    source: text("source").notNull().default("slack"),
    sourceRef: text("source_ref").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_project_images_object_key").on(table.objectKey),
    uniqueIndex("idx_project_images_source").on(table.ownerId, table.projectId, table.source, table.sourceRef),
    index("idx_project_images_project_created").on(table.ownerId, table.projectId, table.createdAt),
  ],
);

export const storageUploadReservations = sqliteTable(
  "storage_upload_reservations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    byteSize: integer("byte_size").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_storage_upload_reservations_workspace_expiry").on(table.workspaceId, table.expiresAt),
    check("storage_upload_reservations_positive_size", sql`${table.byteSize} > 0`),
  ],
);

export const documentImageAssets = sqliteTable(
  "document_image_assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    byteSize: integer("byte_size").notNull(),
    objectKey: text("object_key").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_document_image_assets_object_key").on(table.objectKey),
    index("idx_document_image_assets_workspace_created").on(table.workspaceId, table.createdAt),
    check("document_image_assets_target_kind", sql`${table.targetKind} IN ('project', 'task', 'routine')`),
    check("document_image_assets_positive_size", sql`${table.byteSize} > 0`),
  ],
);

export const projectTemplates = sqliteTable(
  "project_templates",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    content: text("content").notNull().default("[]"),
    plainText: text("plain_text").notNull().default(""),
    createdByUserId: text("created_by_user_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_project_templates_owner_name").on(table.ownerId, table.name),
    index("idx_project_templates_owner_updated").on(table.ownerId, table.updatedAt),
  ],
);

export const projectHiddenProperties = sqliteTable(
  "project_hidden_properties",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull().references(() => propertyDefinitions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_project_hidden_properties_unique").on(table.ownerId, table.projectId, table.propertyId),
    index("idx_project_hidden_properties_project").on(table.ownerId, table.projectId),
    index("idx_project_hidden_properties_property").on(table.ownerId, table.propertyId),
  ],
);

export const checklistItems = sqliteTable(
  "checklist_items",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    taskId: text("task_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_checklist_owner_task").on(table.ownerId, table.taskId),
  ],
);

export const dailyScrums = sqliteTable(
  "daily_scrums",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => workspaceMembers.id, { onDelete: "cascade" }),
    scrumDate: text("scrum_date").notNull(),
    workSelectionJson: text("work_selection_json").notNull().default("[]"),
    yesterdayWorkSelectionJson: text("yesterday_work_selection_json").notNull().default("[]"),
    yesterdayNote: text("yesterday_note").notNull().default(""),
    todayNote: text("today_note").notNull().default(""),
    blockersNote: text("blockers_note").notNull().default(""),
    noPlannedTasks: integer("no_planned_tasks", { mode: "boolean" }).notNull().default(false),
    workStatus: text("work_status").notNull().default("office"),
    skipReason: text("skip_reason"),
    skipNote: text("skip_note").notNull().default(""),
    source: text("source").notNull().default("web"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_daily_scrums_owner_member_date")
      .on(table.ownerId, table.memberId, table.scrumDate)
      .where(sql`${table.memberId} IS NOT NULL`),
    uniqueIndex("idx_daily_scrums_legacy_owner_date")
      .on(table.ownerId, table.scrumDate)
      .where(sql`${table.memberId} IS NULL`),
    index("idx_daily_scrums_owner_date").on(table.ownerId, table.scrumDate),
  ],
);

export const dailyScrumTaskSelections = sqliteTable(
  "daily_scrum_task_selections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    dailyScrumId: text("daily_scrum_id").notNull().references(() => dailyScrums.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_daily_scrum_task_selections_unique").on(table.dailyScrumId, table.taskId),
    index("idx_daily_scrum_task_selections_member").on(table.ownerId, table.memberId),
  ],
);

export const dailySubmissions = sqliteTable(
  "daily_submissions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => workspaceMembers.id, { onDelete: "set null" }),
    memberName: text("member_name").notNull().default(""),
    memberEmail: text("member_email").notNull().default(""),
    scrumDate: text("scrum_date").notNull(),
    version: integer("version").notNull(),
    workSnapshotJson: text("work_snapshot_json").notNull().default("[]"),
    yesterdayWorkSnapshotJson: text("yesterday_work_snapshot_json").notNull().default("[]"),
    requestId: text("request_id"),
    yesterdayNote: text("yesterday_note").notNull().default(""),
    todayNote: text("today_note").notNull().default(""),
    blockersNote: text("blockers_note").notNull().default(""),
    noPlannedTasks: integer("no_planned_tasks", { mode: "boolean" }).notNull().default(false),
    workStatus: text("work_status").notNull().default("office"),
    skipReason: text("skip_reason"),
    skipNote: text("skip_note").notNull().default(""),
    source: text("source").notNull().default("web"),
    submittedAt: text("submitted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_daily_submissions_owner_member_date_version").on(table.ownerId, table.memberId, table.scrumDate, table.version),
    uniqueIndex("idx_daily_submissions_owner_member_request")
      .on(table.ownerId, table.memberId, table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
    index("idx_daily_submissions_owner_date").on(table.ownerId, table.scrumDate, table.submittedAt),
  ],
);

export const dailyTaskSnapshots = sqliteTable(
  "daily_task_snapshots",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    submissionId: text("submission_id").notNull().references(() => dailySubmissions.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    taskTitle: text("task_title").notNull(),
    parentKind: text("parent_kind").notNull().default("general"),
    parentId: text("parent_id"),
    parentTitle: text("parent_title").notNull().default("General"),
    status: text("status").notNull().default("todo"),
    isNew: integer("is_new", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("idx_daily_task_snapshots_submission").on(table.submissionId, table.sortOrder),
  ],
);

export const routinePropertyDefinitions = sqliteTable("routine_property_definitions", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  options: text("options").notNull().default("[]"),
  defaultValue: text("default_value").notNull().default("null"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_routine_properties_owner_name").on(table.ownerId, sql`lower(${table.name})`)]);

export const routines = sqliteTable(
  "routines",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    systemKey: text("system_key"),
    assigneeMemberId: text("assignee_member_id").references(() => workspaceMembers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    triggerPoint: text("trigger_point").notNull().default(""),
    actionPlace: text("action_place").notNull().default(""),
    actionSteps: text("action_steps").notNull().default(""),
    documentContent: text("document_content").notNull().default("[]"),
    documentPlainText: text("document_plain_text").notNull().default(""),
    documentVersion: integer("document_version").notNull().default(0),
    documentUpdatedAt: text("document_updated_at"),
    propertiesJson: text("properties_json").notNull().default("{}"),
    cadence: text("cadence").notNull().default("daily"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_routines_owner_system_key")
      .on(table.ownerId, table.systemKey)
      .where(sql`${table.systemKey} IS NOT NULL`),
    index("idx_routines_assignee").on(table.assigneeMemberId),
    index("idx_routines_owner_active").on(table.ownerId, table.active),
    index("idx_routines_owner_sort").on(table.ownerId, table.sortOrder),
  ],
);

export const routineCompletions = sqliteTable(
  "routine_completions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    routineId: text("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    completionDate: text("completion_date").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_routine_completions_unique").on(table.ownerId, table.routineId, table.completionDate),
    index("idx_routine_completions_owner_date").on(table.ownerId, table.completionDate),
  ],
);

export const aiUsageEvents = sqliteTable(
  "ai_usage_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    model: text("model").notNull(),
    source: text("source").notNull().default("web"),
    inputChars: integer("input_chars").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimatedCostWonMicros: integer("estimated_cost_won_micros").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_ai_usage_owner_created").on(table.ownerId, table.createdAt),
    index("idx_ai_usage_user_created").on(table.userId, table.createdAt),
  ],
);

export const googleConnections = sqliteTable(
  "google_connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    googleAccountId: text("google_account_id").notNull().default(""),
    email: text("email").notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    scope: text("scope").notNull().default(""),
    connectedAt: text("connected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_google_connections_owner_user").on(table.ownerId, table.userId),
    index("idx_google_connections_user").on(table.userId),
  ],
);

export const googleOAuthStates = sqliteTable(
  "google_oauth_states",
  {
    state: text("state").primaryKey(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    returnTo: text("return_to").notNull().default("/"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_google_oauth_states_expires").on(table.expiresAt),
  ],
);

export const googleCalendarEvents = sqliteTable(
  "google_calendar_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id").notNull().default("primary"),
    googleEventId: text("google_event_id").notNull(),
    htmlLink: text("html_link").notNull().default(""),
    syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_google_calendar_events_item").on(table.ownerId, table.userId, table.itemId),
    index("idx_google_calendar_events_owner").on(table.ownerId),
  ],
);

export const slackConnections = sqliteTable(
  "slack_connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
    teamName: text("team_name").notNull().default(""),
    botUserId: text("bot_user_id").notNull().default(""),
    appId: text("app_id").notNull().default(""),
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    scope: text("scope").notNull().default(""),
    connectedAt: text("connected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_slack_connections_team").on(table.teamId),
    uniqueIndex("idx_slack_connections_owner").on(table.ownerId),
  ],
);

export const slackAutomations = sqliteTable(
  "slack_automations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").notNull(),
    name: text("name").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerStatus: text("trigger_status").notNull().default(""),
    channelId: text("channel_id").notNull(),
    messageTemplate: text("message_template").notNull(),
    messageTemplateKind: text("message_template_kind").notNull().default("custom"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastTriggeredAt: text("last_triggered_at"),
    lastDeliveryStatus: text("last_delivery_status").notNull().default("never"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_slack_automations_owner").on(table.ownerId),
    index("idx_slack_automations_owner_active_trigger").on(table.ownerId, table.active, table.triggerType),
  ],
);

export const slackAutomationDeliveries = sqliteTable(
  "slack_automation_deliveries",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull().references(() => slackAutomations.id, { onDelete: "cascade" }),
    itemId: text("item_id").references(() => items.id, { onDelete: "set null" }),
    eventKey: text("event_key").notNull(),
    triggerType: text("trigger_type").notNull(),
    channelId: text("channel_id").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    sentAt: text("sent_at"),
  },
  (table) => [
    uniqueIndex("idx_slack_automation_deliveries_event").on(table.eventKey),
    index("idx_slack_automation_deliveries_owner_created").on(table.ownerId, table.createdAt),
    index("idx_slack_automation_deliveries_automation_created").on(table.automationId, table.createdAt),
  ],
);

// Durable claims for channel bots. Scheduled daily DMs retain their own receipts.
export const slackBotDeliveries = sqliteTable(
  "slack_bot_deliveries",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    botKind: text("bot_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    eventKey: text("event_key").notNull(),
    connectionKey: text("connection_key").notNull(),
    policy: text("policy").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    retryAt: text("retry_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    messageTs: text("message_ts"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_slack_bot_deliveries_event").on(table.ownerId, table.botKind, table.eventKey),
    index("idx_slack_bot_deliveries_due").on(table.status, table.retryAt),
    index("idx_slack_bot_deliveries_owner").on(table.ownerId, table.createdAt),
  ],
);

export const slackOAuthStates = sqliteTable(
  "slack_oauth_states",
  {
    state: text("state").primaryKey(),
    ownerId: text("owner_id").notNull(),
    userId: text("user_id").notNull(),
    returnTo: text("return_to").notNull().default("/"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_slack_oauth_states_expires").on(table.expiresAt),
  ],
);

export const slackMemberLinks = sqliteTable(
  "slack_member_links",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    slackEmail: text("slack_email").notNull().default(""),
    slackDisplayName: text("slack_display_name").notNull().default(""),
    dmChannelId: text("dm_channel_id").notNull().default(""),
    matchedBy: text("matched_by").notNull().default("email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_slack_member_links_owner_member").on(table.ownerId, table.memberId),
    uniqueIndex("idx_slack_member_links_team_user").on(table.teamId, table.slackUserId),
    index("idx_slack_member_links_owner").on(table.ownerId),
  ],
);

export const slackDailySettings = sqliteTable(
  "slack_daily_settings",
  {
    ownerId: text("owner_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    weekdays: text("weekdays").notNull().default("[1,2,3,4,5]"),
    reminderTime: text("reminder_time").notNull().default("09:00"),
    summaryEnabled: integer("summary_enabled", { mode: "boolean" }).notNull().default(true),
    summaryTime: text("summary_time").notNull().default("12:00"),
    workStatuses: text("work_statuses").notNull().default('["office","remote","skip"]'),
    timezone: text("timezone").notNull().default("Asia/Seoul"),
    installStatus: text("install_status").notNull().default("not_connected"),
    requiredScopes: text("required_scopes").notNull().default(""),
    onboardingCompletedAt: text("onboarding_completed_at"),
    lastSyncedAt: text("last_synced_at"),
    lastError: text("last_error").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const workspaceManagementBotSettings = sqliteTable(
  "workspace_management_bot_settings",
  {
    ownerId: text("owner_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    weekdays: text("weekdays").notNull().default("[1,2,3,4,5]"),
    reportTime: text("report_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("Asia/Seoul"),
    channelId: text("channel_id").notNull().default(""),
    channelName: text("channel_name").notNull().default(""),
    signals: text("signals").notNull().default("[\"missing_due_date\",\"missing_owner\",\"overdue\",\"completed_yesterday\",\"due_today\"]"),
    lastSentDate: text("last_sent_date"),
    lastSentAt: text("last_sent_at"),
    lastError: text("last_error").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_workspace_management_bot_due").on(table.enabled, table.lastSentDate)],
);

export const slackDailyPreferences = sqliteTable(
  "slack_daily_preferences",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    reminderTime: text("reminder_time"),
    timezone: text("timezone"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_slack_daily_preferences_owner_member").on(table.ownerId, table.memberId)],
);

export const slackDailyChannels = sqliteTable(
  "slack_daily_channels",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull().default(""),
    isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_slack_daily_channels_owner_channel").on(table.ownerId, table.channelId),
    index("idx_slack_daily_channels_owner").on(table.ownerId),
  ],
);

export const slackDailyReminders = sqliteTable(
  "slack_daily_reminders",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    dmChannelId: text("dm_channel_id").notNull(),
    scheduledMessageId: text("scheduled_message_id").notNull(),
    messageLanguage: text("message_language").notNull().default("ko"),
    messageText: text("message_text").notNull().default("[데일리 봇] 오늘의 데일리를 작성해 주세요."),
    postAt: integer("post_at").notNull(),
    blockId: text("block_id").notNull(),
    botUserId: text("bot_user_id").notNull().default(""),
    status: text("status").notNull().default("scheduled"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_slack_daily_reminders_owner_member").on(table.ownerId, table.memberId),
    index("idx_slack_daily_reminders_post_at").on(table.status, table.postAt),
  ],
);

export const slackDailyPublications = sqliteTable(
  "slack_daily_publications",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => workspaceMembers.id, { onDelete: "set null" }),
    submissionId: text("submission_id").notNull().references(() => dailySubmissions.id, { onDelete: "cascade" }),
    scrumDate: text("scrum_date").notNull(),
    channelId: text("channel_id").notNull(),
    slackMessageTs: text("slack_message_ts"),
    status: text("status").notNull().default("pending"),
    error: text("error").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_slack_daily_publications_submission_channel").on(table.submissionId, table.channelId),
    index("idx_slack_daily_publications_owner_status").on(table.ownerId, table.status, table.updatedAt),
  ],
);

export const slackEventReceipts = sqliteTable(
  "slack_event_receipts",
  {
    eventId: text("event_id").primaryKey(),
    teamId: text("team_id").notNull(),
    eventType: text("event_type").notNull().default(""),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_slack_event_receipts_received").on(table.receivedAt)],
);

export const slackWorkCommandOperations = sqliteTable(
  "slack_work_command_operations",
  {
    requestId: text("request_id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    command: text("command").notNull(),
    targetId: text("target_id"),
    status: text("status").notNull().default("processing"),
    resultJson: text("result_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_slack_work_commands_owner_created").on(table.ownerId, table.createdAt),
    index("idx_slack_work_commands_actor").on(table.teamId, table.slackUserId, table.createdAt),
  ],
);

export const slackLinkTokens = sqliteTable(
  "slack_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    slackEmail: text("slack_email").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [index("idx_slack_link_tokens_expires").on(table.expiresAt)],
);

export const emailMarketingConsents = sqliteTable(
  "email_marketing_consents",
  {
    userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    marketingDataConsent: integer("marketing_data_consent", { mode: "boolean" }).notNull().default(false),
    marketingDataConsentAt: text("marketing_data_consent_at"),
    advertisingEmailConsent: integer("advertising_email_consent", { mode: "boolean" }).notNull().default(false),
    advertisingEmailConsentAt: text("advertising_email_consent_at"),
    policyVersion: text("policy_version").notNull().default("2026-09-01"),
    reaffirmAfter: text("reaffirm_after"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_email_marketing_consents_eligibility").on(table.marketingDataConsent, table.advertisingEmailConsent, table.reaffirmAfter)],
);

export const emailMarketingPromptState = sqliteTable("email_marketing_prompt_state", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  shownAt: text("shown_at"),
  respondedAt: text("responded_at"),
});

export const emailMarketingConsentEvents = sqliteTable(
  "email_marketing_consent_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    consentType: text("consent_type").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
    policyVersion: text("policy_version").notNull(),
    source: text("source").notNull().default("settings"),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_email_marketing_consent_events_user_time").on(table.userId, table.occurredAt)],
);

export const workspaceSubscriptions = sqliteTable(
  "workspace_subscriptions",
  {
    workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
    plan: text("plan").notNull().default("free"),
    status: text("status").notNull().default("free"),
    billingOwnerUserId: text("billing_owner_user_id").notNull(),
    nextPlan: text("next_plan"),
    trialStartedAt: text("trial_started_at"),
    trialEndsAt: text("trial_ends_at"),
    currentPeriodStartedAt: text("current_period_started_at"),
    currentPeriodEndsAt: text("current_period_ends_at"),
    nextBillingAt: text("next_billing_at"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
    graceEndsAt: text("grace_ends_at"),
    retryCount: integer("retry_count").notNull().default(0),
    firstPaidAt: text("first_paid_at"),
    lastPaidAt: text("last_paid_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_workspace_subscriptions_billing_due").on(table.status, table.nextBillingAt),
    index("idx_workspace_subscriptions_billing_owner").on(table.billingOwnerUserId),
  ],
);

export const billingPaymentMethods = sqliteTable(
  "billing_payment_methods",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    encryptedBillingKey: text("encrypted_billing_key").notNull(),
    payerHash: text("payer_hash").notNull(),
    cardCompany: text("card_company").notNull().default(""),
    maskedCard: text("masked_card").notNull().default(""),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_billing_payment_methods_active_workspace").on(table.workspaceId).where(sql`${table.active} = 1`),
    index("idx_billing_payment_methods_payer").on(table.payerHash),
  ],
);

export const billingSessions = sqliteTable(
  "billing_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    plan: text("plan").notNull(),
    priceWon: integer("price_won").notNull(),
    consentedAt: text("consented_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_billing_sessions_expiry").on(table.expiresAt)],
);

export const billingTransactions = sqliteTable(
  "billing_transactions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    orderId: text("order_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    plan: text("plan").notNull(),
    priceWon: integer("price_won").notNull(),
    status: text("status").notNull(),
    paypleTransactionId: text("payple_transaction_id"),
    receiptUrl: text("receipt_url"),
    errorCode: text("error_code"),
    periodStartedAt: text("period_started_at"),
    periodEndsAt: text("period_ends_at"),
    retainedUntil: text("retained_until").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_billing_transactions_order").on(table.orderId),
    uniqueIndex("idx_billing_transactions_idempotency").on(table.idempotencyKey),
    index("idx_billing_transactions_workspace_time").on(table.workspaceId, table.createdAt),
  ],
);

export const projectMonthlyUsage = sqliteTable(
  "project_monthly_usage",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    createdCount: integer("created_count").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_project_monthly_usage_workspace_period").on(table.workspaceId, table.periodKey),
    index("idx_project_monthly_usage_period").on(table.periodKey),
  ],
);

export const workspaceEditorSelections = sqliteTable(
  "workspace_editor_selections",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
    selected: integer("selected", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_workspace_editor_selections_workspace_member").on(table.workspaceId, table.memberId)],
);

export const billingTrialClaims = sqliteTable(
  "billing_trial_claims",
  {
    id: text("id").primaryKey(),
    billingOwnerUserId: text("billing_owner_user_id").notNull(),
    payerHash: text("payer_hash").notNull(),
    workspaceId: text("workspace_id").notNull(),
    claimedAt: text("claimed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_billing_trial_claims_owner").on(table.billingOwnerUserId),
    uniqueIndex("idx_billing_trial_claims_payer").on(table.payerHash),
  ],
);

export const billingLeases = sqliteTable(
  "billing_leases",
  {
    leaseKey: text("lease_key").primaryKey(),
    holderId: text("holder_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
);

export const billingNotifications = sqliteTable(
  "billing_notifications",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    sentAt: text("sent_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_billing_notifications_workspace_kind_schedule").on(table.workspaceId, table.kind, table.scheduledFor),
    index("idx_billing_notifications_due").on(table.status, table.scheduledFor),
  ],
);

export const trashRecords = sqliteTable(
  "trash_records",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    payload: text("payload").notNull(),
    itemCount: integer("item_count").notNull().default(0),
    routineCount: integer("routine_count").notNull().default(0),
    cycleCount: integer("cycle_count").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    archivedAt: text("archived_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_trash_records_owner_archived").on(table.ownerId, table.archivedAt),
  ],
);

export type PaceItem = typeof items.$inferSelect;
export type NewPaceItem = typeof items.$inferInsert;
export type ItemAssignment = typeof itemAssignments.$inferSelect;
export type KrDataConnection = typeof krDataConnections.$inferSelect;
export type PropertyDefinition = typeof propertyDefinitions.$inferSelect;
export type ItemPropertyValue = typeof itemPropertyValues.$inferSelect;
export type ProjectHiddenProperty = typeof projectHiddenProperties.$inferSelect;
export type ProjectDocument = typeof projectDocuments.$inferSelect;
export type ProjectImage = typeof projectImages.$inferSelect;
export type ProjectTemplate = typeof projectTemplates.$inferSelect;
export type ChecklistItem = typeof checklistItems.$inferSelect;
export type DailyScrum = typeof dailyScrums.$inferSelect;
export type DailyDraft = typeof dailyScrums.$inferSelect;
export type DailySubmission = typeof dailySubmissions.$inferSelect;
export type DailyTaskSnapshot = typeof dailyTaskSnapshots.$inferSelect;
export type Routine = typeof routines.$inferSelect;
export type RoutineCompletion = typeof routineCompletions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type User = typeof users.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type AccountRegistration = typeof accountRegistrations.$inferSelect;
export type AccountConsentEvent = typeof accountConsentEvents.$inferSelect;
export type PhoneVerificationRequest = typeof phoneVerificationRequests.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceInvitation = typeof workspaceInvitations.$inferSelect;
export type UserWorkspacePreference = typeof userWorkspacePreferences.$inferSelect;
export type WorkspaceRule = typeof workspaceRules.$inferSelect;
export type IntegrationToken = typeof integrationTokens.$inferSelect;
export type McpOAuthClient = typeof mcpOAuthClients.$inferSelect;
export type McpOAuthCode = typeof mcpOAuthCodes.$inferSelect;
export type OkrCycle = typeof okrCycles.$inferSelect;
export type WorkspaceGroup = typeof workspaceGroups.$inferSelect;
export type WorkspaceGroupMember = typeof workspaceGroupMembers.$inferSelect;
export type AiUsageEvent = typeof aiUsageEvents.$inferSelect;
export type GoogleConnection = typeof googleConnections.$inferSelect;
export type GoogleOAuthState = typeof googleOAuthStates.$inferSelect;
export type GoogleCalendarEvent = typeof googleCalendarEvents.$inferSelect;
export type SlackConnection = typeof slackConnections.$inferSelect;
export type SlackAutomation = typeof slackAutomations.$inferSelect;
export type SlackAutomationDelivery = typeof slackAutomationDeliveries.$inferSelect;
export type SlackOAuthState = typeof slackOAuthStates.$inferSelect;
export type SlackMemberLink = typeof slackMemberLinks.$inferSelect;
export const slackDailyManualRuns = sqliteTable("slack_daily_manual_runs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").notNull(),
  targetsJson: text("targets_json").notNull(),
  errorsJson: text("errors_json").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  expiresAt: text("expires_at").notNull(),
}, (table) => [index("idx_slack_manual_pending").on(table.status, table.expiresAt)]);

export const slackTaskChanges = sqliteTable("slack_task_changes", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull().references(() => slackAutomations.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull(),
  channelId: text("channel_id").notNull(),
  changeKind: text("change_kind").notNull(),
  taskJson: text("task_json").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  processedAt: text("processed_at"),
}, (table) => [index("idx_slack_task_changes_pending").on(table.processedAt, table.createdAt)]);

export const slackDailyChecklists = sqliteTable("slack_daily_checklists", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  memberId: text("member_id").notNull().references(() => workspaceMembers.id, { onDelete: "cascade" }),
  payloadJson: text("payload_json").notNull(),
  revision: integer("revision").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
}, (table) => [index("idx_slack_daily_checklists_expiry").on(table.expiresAt)]);

export const storeReviewFeedback = sqliteTable("store_review_feedback", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  sourceEventId: text("source_event_id").notNull(),
  eventType: text("event_type").notNull(),
  state: text("state").notNull().default(""),
  deliveryStatus: text("delivery_status").notNull().default("received"),
  attempts: integer("attempts").notNull().default(1),
  receivedAt: text("received_at").notNull(),
  occurredAt: text("occurred_at").notNull(),
  deliveredAt: text("delivered_at"),
  lastError: text("last_error").notNull().default(""),
}, (table) => [
  uniqueIndex("idx_store_review_feedback_source_event").on(table.source, table.sourceEventId),
  index("idx_store_review_feedback_delivery").on(table.deliveryStatus, table.receivedAt),
]);

export type SlackDailySettings = typeof slackDailySettings.$inferSelect;
export type SlackDailyReminder = typeof slackDailyReminders.$inferSelect;
export type SlackDailyPublication = typeof slackDailyPublications.$inferSelect;
export type EmailMarketingConsent = typeof emailMarketingConsents.$inferSelect;
export type WorkspaceSubscription = typeof workspaceSubscriptions.$inferSelect;
export type BillingPaymentMethod = typeof billingPaymentMethods.$inferSelect;
export type BillingTransaction = typeof billingTransactions.$inferSelect;
export type TrashRecord = typeof trashRecords.$inferSelect;
export type LocalAgentDevice = typeof localAgentDevices.$inferSelect;
export type LocalAgentPairing = typeof localAgentPairings.$inferSelect;
export type LocalAgentJob = typeof localAgentJobs.$inferSelect;
