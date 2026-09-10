import { env } from "cloudflare:workers";
import { decryptPrivateValue, encryptPrivateValue } from "@/lib/secret-crypto";
import { aiUsagePercent } from "@/lib/ai-usage";
import { cancelPayPalSubscription, ensurePayPalSchema, expirePayPalEntitlement, getPayPalSubscription,
  payPalCheckoutOptions, reconcilePayPalSubscriptions, refundPayPalFirstPayment, withWorkspaceLock } from "@/lib/billing-paypal";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const BILLING_PLANS = {
  free: { label: "Free", seatPriceWon: 0, projectLimit: 30, editorLimit: 5, activityHistoryDays: 90,
    storageBaseBytes: 100 * MIB, storagePerEditorBytes: 0, aiBudgetBaseWon: 500, aiBudgetPerEditorWon: 0 },
  team: { label: "Team", seatPriceWon: 2_900, projectLimit: null, editorLimit: null, activityHistoryDays: null,
    storageBaseBytes: 0, storagePerEditorBytes: 500 * MIB, aiBudgetBaseWon: 0, aiBudgetPerEditorWon: 600 },
  business: { label: "Business", seatPriceWon: 4_900, projectLimit: null, editorLimit: null, activityHistoryDays: null,
    storageBaseBytes: 0, storagePerEditorBytes: GIB, aiBudgetBaseWon: 0, aiBudgetPerEditorWon: 1_500 },
} as const;

export type BillingPlan = keyof typeof BILLING_PLANS;
export type SubscriptionStatus = "free" | "trialing" | "active" | "past_due" | "cancel_at_period_end" | "canceled";

type BillingRuntimeEnv = typeof env & {
  BILLING_ENFORCEMENT_ENABLED?: string;
  PAYPLE_CST_ID?: string;
  PAYPLE_CHECKOUT_VERIFIED?: string;
  PAYPLE_CUST_KEY?: string;
  PAYPLE_AUTH_URL?: string;
  PAYPLE_API_URL?: string;
  PAYPLE_REFUND_KEY?: string;
  PAYPLE_BILLING_KEY_ENCRYPTION_KEY?: string;
  RESEND_API_KEY?: string;
  OKRI_BILLING_FROM?: string;
  OKRPTR_BILLING_FROM?: string;
  OKRI_PUBLIC_URL?: string;
  OKRPTR_PUBLIC_URL?: string;
  INTERNAL_BILLING_SECRET?: string;
  BILLING_ENFORCEMENT_STARTED_AT?: string;
};

export const PAYMENT_RETRY_DAYS = [1, 3, 5, 7] as const;

export function planMonthlyPriceWon(plan: BillingPlan, editorCount: number) {
  if (plan === "free") return 0;
  return BILLING_PLANS[plan].seatPriceWon * Math.max(1, Math.floor(editorCount));
}

export function planAiBudgetWon(plan: BillingPlan, editorCount: number) {
  const limits = BILLING_PLANS[plan];
  return limits.aiBudgetBaseWon + limits.aiBudgetPerEditorWon * (plan === "free" ? 0 : Math.max(1, Math.floor(editorCount)));
}

export function planStorageLimitBytes(plan: BillingPlan, editorCount: number) {
  const limits = BILLING_PLANS[plan];
  return limits.storageBaseBytes + limits.storagePerEditorBytes * (plan === "free" ? 0 : Math.max(1, Math.floor(editorCount)));
}

function billingPublicUrl(runtime: BillingRuntimeEnv) {
  return String(runtime.OKRI_PUBLIC_URL || runtime.OKRPTR_PUBLIC_URL || "https://okri.ai").replace(/\/$/, "");
}

type SubscriptionRow = {
  workspace_id: string;
  plan: BillingPlan;
  status: SubscriptionStatus;
  billing_owner_user_id: string;
  next_plan: BillingPlan | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  current_period_started_at: string | null;
  current_period_ends_at: string | null;
  next_billing_at: string | null;
  cancel_at_period_end: number;
  grace_ends_at: string | null;
  retry_count: number;
  first_paid_at: string | null;
  last_paid_at: string | null;
  updated_at: string;
};

export class BillingLimitError extends Error {
  readonly code: "project_quota_exceeded" | "editor_quota_exceeded" | "storage_quota_exceeded" | "ai_budget_exceeded" | "editor_read_only";
  readonly details: Record<string, unknown>;

  constructor(code: BillingLimitError["code"], message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "BillingLimitError";
    this.code = code;
    this.details = details;
  }
}

let schemaReady: Promise<void> | null = null;

export function billingEnforcementEnabled() {
  return (env as BillingRuntimeEnv).BILLING_ENFORCEMENT_ENABLED?.toLocaleLowerCase() === "true";
}

export function paypleConfigured() {
  const runtime = env as BillingRuntimeEnv;
  return Boolean(
    runtime.PAYPLE_CHECKOUT_VERIFIED === "true"
      && runtime.PAYPLE_CST_ID
      && runtime.PAYPLE_CUST_KEY
      && runtime.PAYPLE_AUTH_URL
      && runtime.PAYPLE_API_URL
      && runtime.PAYPLE_REFUND_KEY
      && runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY,
  );
}

export async function ensureBillingSchema() {
  if (!schemaReady) {
    const d1 = (env as BillingRuntimeEnv).DB;
    schemaReady = d1.batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS email_marketing_consents (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        marketing_data_consent INTEGER NOT NULL DEFAULT 0,
        marketing_data_consent_at TEXT,
        advertising_email_consent INTEGER NOT NULL DEFAULT 0,
        advertising_email_consent_at TEXT,
        policy_version TEXT NOT NULL DEFAULT '2026-09-01',
        reaffirm_after TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_email_marketing_consents_eligibility ON email_marketing_consents(marketing_data_consent, advertising_email_consent, reaffirm_after)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS email_marketing_consent_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        consent_type TEXT NOT NULL,
        granted INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'settings',
        occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_email_marketing_consent_events_user_time ON email_marketing_consent_events(user_id, occurred_at)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_subscriptions (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'free',
        billing_owner_user_id TEXT NOT NULL, next_plan TEXT,
        trial_started_at TEXT, trial_ends_at TEXT, current_period_started_at TEXT, current_period_ends_at TEXT,
        next_billing_at TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, grace_ends_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0, first_paid_at TEXT, last_paid_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_billing_due ON workspace_subscriptions(status, next_billing_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_billing_owner ON workspace_subscriptions(billing_owner_user_id)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS billing_payment_methods (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        encrypted_billing_key TEXT NOT NULL, payer_hash TEXT NOT NULL, card_company TEXT NOT NULL DEFAULT '',
        masked_card TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_methods_active_workspace ON billing_payment_methods(workspace_id) WHERE active = 1"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_billing_payment_methods_payer ON billing_payment_methods(payer_hash)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS billing_sessions (
        token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, plan TEXT NOT NULL, price_won INTEGER NOT NULL, consented_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_billing_sessions_expiry ON billing_sessions(expires_at)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS billing_transactions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        order_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, plan TEXT NOT NULL,
        price_won INTEGER NOT NULL, status TEXT NOT NULL, payple_transaction_id TEXT, receipt_url TEXT,
        error_code TEXT, period_started_at TEXT, period_ends_at TEXT, retained_until TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_transactions_order ON billing_transactions(order_id)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_transactions_idempotency ON billing_transactions(idempotency_key)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_billing_transactions_workspace_time ON billing_transactions(workspace_id, created_at)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS project_monthly_usage (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, period_key TEXT NOT NULL,
        created_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace_id, period_key)
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_monthly_usage_period ON project_monthly_usage(period_key)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_editor_selections (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
        selected INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace_id, member_id)
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS billing_trial_claims (
        id TEXT PRIMARY KEY, billing_owner_user_id TEXT NOT NULL, payer_hash TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_trial_claims_owner ON billing_trial_claims(billing_owner_user_id)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_trial_claims_payer ON billing_trial_claims(payer_hash)"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS billing_leases (
        lease_key TEXT PRIMARY KEY, holder_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS billing_notifications (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, kind TEXT NOT NULL, scheduled_for TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        provider_message_id TEXT, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace_id, kind, scheduled_for)
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_billing_notifications_due ON billing_notifications(status, scheduled_for)"),
      d1.prepare("UPDATE account_registrations SET encrypted_phone = '', phone_hash = '', phone_last_four = '', verification_provider = '', phone_verified_at = NULL"),
      d1.prepare("DELETE FROM phone_verification_requests"),
      d1.prepare("INSERT OR IGNORE INTO app_migrations (id, applied_at) VALUES ('billing_email_v1', CURRENT_TIMESTAMP)"),
      d1.prepare("PRAGMA optimize"),
    ]).then(() => ensurePayPalSchema());
    void schemaReady.catch(() => { schemaReady = null; });
  }
  await schemaReady;
}

export function kstPeriod(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((entry) => entry.type === "year")?.value ?? String(date.getUTCFullYear());
  const month = parts.find((entry) => entry.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  const monthIndex = Number(month);
  const nextYear = monthIndex === 12 ? Number(year) + 1 : Number(year);
  const nextMonth = monthIndex === 12 ? 1 : monthIndex + 1;
  return {
    key: `${year}-${month}`,
    startsAt: new Date(`${year}-${month}-01T00:00:00+09:00`).toISOString(),
    resetsAt: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+09:00`).toISOString(),
  };
}

export async function getWorkspaceSubscription(workspaceId: string): Promise<SubscriptionRow> {
  await ensureBillingSchema();
  const d1 = (env as BillingRuntimeEnv).DB;
  await d1.prepare(`INSERT OR IGNORE INTO workspace_subscriptions (workspace_id, billing_owner_user_id)
    SELECT id, owner_user_id FROM workspaces WHERE id = ?`).bind(workspaceId).run();
  await expirePayPalEntitlement(workspaceId);
  const row = await d1.prepare("SELECT * FROM workspace_subscriptions WHERE workspace_id = ? LIMIT 1").bind(workspaceId).first<SubscriptionRow>();
  if (!row) throw new Error("Workspace subscription could not be initialized");
  return row;
}

export async function getBillableEditorCount(workspaceId: string) {
  await ensureBillingSchema();
  const row = await (env as BillingRuntimeEnv).DB.prepare(`SELECT count(*) AS count FROM workspace_members
    WHERE workspace_id = ? AND status = 'active' AND role IN ('owner','admin','member')`)
    .bind(workspaceId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function getWorkspaceStorageUsage(workspaceId: string) {
  const row = await (env as BillingRuntimeEnv).DB.prepare(`SELECT
      coalesce((SELECT sum(byte_size) FROM project_images WHERE owner_id = ?), 0)
      + coalesce((SELECT sum(byte_size) FROM document_image_assets WHERE workspace_id = ?), 0) AS used`)
    .bind(workspaceId, workspaceId).first<{ used: number }>();
  return Math.max(0, Number(row?.used ?? 0));
}

export async function getBillingStatus(workspaceId: string, userId: string, role: string) {
  const d1 = (env as BillingRuntimeEnv).DB;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limits = BILLING_PLANS[plan];
  const period = kstPeriod();
  const [projectUsage, editorRows, aiUsage, storageUsed, method, transactions, editorEnforcement] = await Promise.all([
    d1.prepare("SELECT created_count FROM project_monthly_usage WHERE workspace_id = ? AND period_key = ? LIMIT 1").bind(workspaceId, period.key).first<{ created_count: number }>(),
    d1.prepare(`SELECT member.id, member.display_name, member.email, member.role, member.created_at,
        CASE WHEN selection.selected = 1 THEN 1 ELSE 0 END AS explicitly_selected
      FROM workspace_members AS member
      LEFT JOIN workspace_editor_selections AS selection
        ON selection.workspace_id = member.workspace_id AND selection.member_id = member.id
      WHERE member.workspace_id = ? AND member.status = 'active' AND member.role IN ('owner','admin','member')
      ORDER BY explicitly_selected DESC, CASE WHEN member.role = 'owner' THEN 0 ELSE 1 END, member.created_at, member.id`)
      .bind(workspaceId).all<Record<string, string | number | null>>(),
    getAiMonthlyUsage(workspaceId, subscription.billing_owner_user_id, plan, period),
    getWorkspaceStorageUsage(workspaceId),
    d1.prepare("SELECT id, card_company, masked_card, created_at FROM billing_payment_methods WHERE workspace_id = ? AND active = 1 LIMIT 1").bind(workspaceId).first<Record<string, string>>(),
    d1.prepare(`SELECT id, kind, plan, price_won, status, receipt_url, created_at
      FROM billing_transactions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`).bind(workspaceId).all<Record<string, string | number | null>>(),
    getEditorEnforcementState(workspaceId),
  ]);
  const projectsUsed = Number(projectUsage?.created_count ?? 0);
  const editorsUsed = editorRows.results.length;
  const monthlyPriceWon = planMonthlyPriceWon(plan, editorsUsed);
  const aiBudgetWon = planAiBudgetWon(plan, editorsUsed);
  const storageLimitBytes = planStorageLimitBytes(plan, editorsUsed);
  const hasExplicitEditorSelection = editorRows.results.some((row) => Boolean(row.explicitly_selected));
  const editorMembers = editorRows.results.map((row, index) => ({
    id: String(row.id),
    displayName: String(row.display_name || row.email || "멤버"),
    email: String(row.email || ""),
    role: String(row.role),
    selected: hasExplicitEditorSelection ? Boolean(row.explicitly_selected) : limits.editorLimit !== null && index < limits.editorLimit,
    writeAllowed: !editorEnforcement.enforced || limits.editorLimit === null || (hasExplicitEditorSelection ? Boolean(row.explicitly_selected) : index < limits.editorLimit),
  }));
  const paypal = await getPayPalSubscription(workspaceId);
  const paypalPlans = role === "owner" ? await payPalCheckoutOptions() : [];
  const paypalTransactions = role === "owner" ? await d1.prepare(`SELECT t.*,s.plan FROM billing_paypal_transactions t
    INNER JOIN billing_paypal_subscriptions s ON s.id=t.subscription_id WHERE t.workspace_id=? ORDER BY t.paid_at DESC LIMIT 20`)
    .bind(workspaceId).all<Record<string, string>>() : { results: [] };
  return {
    plan,
    planLabel: limits.label,
    seatPriceWon: limits.seatPriceWon,
    monthlyPriceWon,
    billableEditors: editorsUsed,
    vatIncluded: true,
    status: subscription.status,
    nextPlan: subscription.next_plan,
    trialEndsAt: subscription.trial_ends_at,
    currentPeriodEndsAt: subscription.current_period_ends_at,
    nextBillingAt: subscription.next_billing_at,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    graceEndsAt: subscription.grace_ends_at,
    usage: {
      projects: { used: projectsUsed, limit: limits.projectLimit, remaining: limits.projectLimit === null ? null : Math.max(0, limits.projectLimit - projectsUsed), resetsAt: period.resetsAt },
      editors: {
        used: editorsUsed,
        limit: limits.editorLimit,
        remaining: limits.editorLimit === null ? null : Math.max(0, limits.editorLimit - editorsUsed),
        enforced: editorEnforcement.enforced,
        graceEndsAt: editorEnforcement.graceEndsAt,
      },
      ai: { usedWon: Math.ceil(aiUsage / 1_000_000), limitWon: aiBudgetWon, remainingWon: Math.max(0, aiBudgetWon - Math.ceil(aiUsage / 1_000_000)), ...aiUsagePercent(aiUsage, aiBudgetWon * 1_000_000), resetsAt: period.resetsAt },
      storage: { usedBytes: storageUsed, limitBytes: storageLimitBytes, remainingBytes: Math.max(0, storageLimitBytes - storageUsed) },
    },
    editorMembers,
    paymentMethod: method ? { id: method.id, cardCompany: method.card_company, maskedCard: method.masked_card, createdAt: method.created_at } : null,
    transactions: transactions.results.map((row) => ({
      id: row.id, kind: row.kind, plan: row.plan, priceWon: Number(row.price_won), status: row.status,
      receiptUrl: row.receipt_url, createdAt: row.created_at,
    })),
    canManage: role === "owner",
    enforcementEnabled: billingEnforcementEnabled(),
    checkoutAvailable: paypleConfigured() || paypalPlans.length > 0,
    providers: { payple: paypleConfigured(), paypal: paypalPlans },
    paypal: paypal ? { plan: paypal.plan, status: paypal.status, paidThrough: paypal.paid_through,
      currency: paypal.currency, value: paypal.price_value, seatCount: Number(paypal.seat_count || 1),
      pendingSeatCount: paypal.pending_seat_count === null ? null : Number(paypal.pending_seat_count) } : null,
    paypalTransactions: paypalTransactions.results.map((row) => ({ id: row.id, plan: row.plan, status: row.status,
      currency: row.currency, value: row.price_value, createdAt: row.paid_at })),
    integrationsIncluded: true,
    requestedByUserId: userId,
  };
}

export async function saveEditorSelections(workspaceId: string, memberIds: string[]) {
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limit = BILLING_PLANS[plan].editorLimit;
  const uniqueIds = [...new Set(memberIds.map((id) => id.trim()).filter(Boolean))];
  if (limit !== null && uniqueIds.length > limit) throw new Error(`현재 플랜에서는 편집자를 ${limit}명까지 선택할 수 있습니다.`);
  const d1 = (env as BillingRuntimeEnv).DB;
  const rows = uniqueIds.length
    ? await d1.prepare(`SELECT id, role FROM workspace_members WHERE workspace_id = ? AND status = 'active'
        AND role IN ('owner','admin','member') AND id IN (${uniqueIds.map(() => "?").join(",")})`)
      .bind(workspaceId, ...uniqueIds).all<{ id: string; role: string }>()
    : { results: [] as Array<{ id: string; role: string }> };
  if (rows.results.length !== uniqueIds.length) throw new Error("선택한 편집자 중 현재 워크스페이스의 활성 멤버가 아닌 사용자가 있습니다.");
  const owner = await d1.prepare("SELECT id FROM workspace_members WHERE workspace_id = ? AND status = 'active' AND role = 'owner' LIMIT 1")
    .bind(workspaceId).first<{ id: string }>();
  if (owner && !uniqueIds.includes(owner.id)) throw new Error("워크스페이스 Owner는 활성 편집자에 포함해야 합니다.");
  await d1.batch([
    d1.prepare("DELETE FROM workspace_editor_selections WHERE workspace_id = ?").bind(workspaceId),
    ...uniqueIds.map((memberId) => d1.prepare(`INSERT INTO workspace_editor_selections
      (workspace_id, member_id, selected, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)`).bind(workspaceId, memberId)),
  ]);
  return { selectedMemberIds: uniqueIds };
}

export async function reserveProjectCreation(workspaceId: string) {
  if (!billingEnforcementEnabled()) return null;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limit = BILLING_PLANS[plan].projectLimit;
  const period = kstPeriod();
  const d1 = (env as BillingRuntimeEnv).DB;
  const result = limit === null
    ? await d1.prepare(`INSERT INTO project_monthly_usage (workspace_id, period_key, created_count, updated_at)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id, period_key) DO UPDATE SET created_count = created_count + 1, updated_at = CURRENT_TIMESTAMP`)
      .bind(workspaceId, period.key).run()
    : await d1.prepare(`INSERT INTO project_monthly_usage (workspace_id, period_key, created_count, updated_at)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id, period_key) DO UPDATE SET created_count = created_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE created_count < ?`).bind(workspaceId, period.key, limit).run();
  if (!result.meta.changes) {
    const usage = await d1.prepare("SELECT created_count FROM project_monthly_usage WHERE workspace_id = ? AND period_key = ?")
      .bind(workspaceId, period.key).first<{ created_count: number }>();
    throw new BillingLimitError("project_quota_exceeded", "이번 달 Project 생성 한도에 도달했습니다.", {
      used: Number(usage?.created_count ?? limit), limit, resetsAt: period.resetsAt, upgradeUrl: "/?view=billing",
    });
  }
  return { workspaceId, periodKey: period.key };
}

/** Joined to a reviewed Project's atomic D1 batch; a quota failure rolls back the entire operation. */
export async function prepareReviewedProjectQuota(workspaceId: string) {
  if (!billingEnforcementEnabled()) return null;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limit = BILLING_PLANS[plan].projectLimit;
  const period = kstPeriod();
  const d1 = (env as BillingRuntimeEnv).DB;
  const statement = limit === null
    ? d1.prepare(`INSERT INTO project_monthly_usage (workspace_id, period_key, created_count, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(workspace_id, period_key) DO UPDATE SET
      created_count = created_count + 1, updated_at = CURRENT_TIMESTAMP`).bind(workspaceId, period.key)
    : d1.prepare(`INSERT INTO project_monthly_usage (workspace_id, period_key, created_count, updated_at)
      VALUES (?, ?, CASE WHEN ? > 0 THEN 1 ELSE NULL END, CURRENT_TIMESTAMP)
      ON CONFLICT(workspace_id, period_key) DO UPDATE SET
      created_count = CASE WHEN created_count < ? THEN created_count + 1 ELSE NULL END,
      updated_at = CURRENT_TIMESTAMP`).bind(workspaceId, period.key, limit, limit);
  return { statement, limit, plan, resetsAt: period.resetsAt };
}

/** Same editor-selection policy as memberCanWrite, evaluated inside the creation transaction. */
export function reviewedProjectPermissionGuard(workspaceId: string, userId: string) {
  const configuredStart = (env as BillingRuntimeEnv).BILLING_ENFORCEMENT_STARTED_AT;
  const start = configuredStart && Number.isFinite(Date.parse(configuredStart)) ? new Date(configuredStart).toISOString() : null;
  const limit = `CASE coalesce((SELECT plan FROM workspace_subscriptions WHERE workspace_id = m.workspace_id), 'free')
    WHEN 'business' THEN -1 WHEN 'team' THEN ${BILLING_PLANS.team.editorLimit} ELSE ${BILLING_PLANS.free.editorLimit} END`;
  const explicit = `SELECT s.member_id FROM workspace_editor_selections s JOIN workspace_members e ON e.id = s.member_id AND e.workspace_id = s.workspace_id
    WHERE s.workspace_id = m.workspace_id AND s.selected = 1 AND e.status = 'active' AND e.role IN ('owner','admin','member')`;
  return {
    sql: `EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'active' AND m.role IN ('owner','admin','member')
        AND w.scheduled_deletion_at IS NULL AND (? = 0
          OR (julianday(w.created_at) < julianday(?) AND julianday('now') < julianday(?, '+30 days'))
          OR (${limit}) = -1 OR m.id IN (${explicit})
          OR (NOT EXISTS (${explicit}) AND (SELECT count(*) FROM workspace_members e
            WHERE e.workspace_id = m.workspace_id AND e.status = 'active' AND e.role IN ('owner','admin','member')
              AND (CASE WHEN e.role = 'owner' THEN 0 ELSE 1 END, e.created_at, e.id)
                <= (CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at, m.id)) <= (${limit}))))`,
    bindings: [workspaceId, userId, billingEnforcementEnabled() ? 1 : 0, start, start],
  };
}

export async function releaseProjectCreation(reservation: { workspaceId: string; periodKey: string } | null) {
  if (!reservation) return;
  await (env as BillingRuntimeEnv).DB.prepare(`UPDATE project_monthly_usage
    SET created_count = max(0, created_count - 1), updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND period_key = ?`).bind(reservation.workspaceId, reservation.periodKey).run();
}

export async function reserveStorageUpload(workspaceId: string, byteSize: number) {
  const requestedBytes = Math.max(0, Math.floor(byteSize));
  if (!billingEnforcementEnabled() || requestedBytes === 0) return null;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const editorCount = await getBillableEditorCount(workspaceId);
  const limitBytes = planStorageLimitBytes(plan, editorCount);
  const d1 = (env as BillingRuntimeEnv).DB;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  await d1.prepare("DELETE FROM storage_upload_reservations WHERE expires_at <= ?").bind(now.toISOString()).run();
  const id = crypto.randomUUID();
  const result = await d1.prepare(`INSERT INTO storage_upload_reservations
      (id, workspace_id, byte_size, expires_at, created_at)
    SELECT ?, ?, ?, ?, ?
    WHERE coalesce((SELECT sum(byte_size) FROM project_images WHERE owner_id = ?), 0)
      + coalesce((SELECT sum(byte_size) FROM document_image_assets WHERE workspace_id = ?), 0)
      + coalesce((SELECT sum(byte_size) FROM storage_upload_reservations WHERE workspace_id = ? AND expires_at > ?), 0)
      + ? <= ?`)
    .bind(id, workspaceId, requestedBytes, expiresAt, now.toISOString(), workspaceId, workspaceId, workspaceId, now.toISOString(), requestedBytes, limitBytes).run();
  if (!result.meta.changes) {
    const usedBytes = await getWorkspaceStorageUsage(workspaceId);
    throw new BillingLimitError("storage_quota_exceeded", "이미지 저장 공간을 모두 사용했습니다. 기존 이미지는 그대로 유지됩니다.", {
      usedBytes, limitBytes, remainingBytes: Math.max(0, limitBytes - usedBytes), upgradeUrl: "/?view=billing",
    });
  }
  return id;
}

export async function releaseStorageUpload(reservationId: string | null) {
  if (!reservationId) return;
  await (env as BillingRuntimeEnv).DB.prepare("DELETE FROM storage_upload_reservations WHERE id = ?")
    .bind(reservationId).run();
}

export async function recordDocumentImageUsage(input: {
  id: string;
  workspaceId: string;
  targetKind: "project" | "task" | "routine";
  targetId: string;
  byteSize: number;
  objectKey: string;
  createdByUserId?: string | null;
}) {
  await (env as BillingRuntimeEnv).DB.prepare(`INSERT OR IGNORE INTO document_image_assets
    (id, workspace_id, target_kind, target_id, byte_size, object_key, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.id, input.workspaceId, input.targetKind, input.targetId, input.byteSize, input.objectKey,
      input.createdByUserId ?? null, new Date().toISOString()).run();
}

export async function assertEditorSeatAvailable(workspaceId: string, role: string) {
  if (!billingEnforcementEnabled() || role === "viewer") return;
  if (!(await getEditorEnforcementState(workspaceId)).enforced) return;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limit = BILLING_PLANS[plan].editorLimit;
  if (limit === null) return;
  const row = await (env as BillingRuntimeEnv).DB.prepare(`SELECT count(*) AS count FROM workspace_members
    WHERE workspace_id = ? AND status = 'active' AND role IN ('owner','admin','member')`).bind(workspaceId).first<{ count: number }>();
  const used = Number(row?.count ?? 0);
  if (used >= limit) throw new BillingLimitError("editor_quota_exceeded", "활성 편집자 한도에 도달했습니다.", {
    used, limit, upgradeUrl: "/?view=billing",
  });
}

export async function reserveEditorSeat(workspaceId: string, role: string) {
  if (!billingEnforcementEnabled() || role === "viewer") return null;
  if (!(await getEditorEnforcementState(workspaceId)).enforced) return null;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limit = BILLING_PLANS[plan].editorLimit;
  if (limit === null) return null;
  const d1 = (env as BillingRuntimeEnv).DB;
  const now = new Date();
  await d1.prepare("DELETE FROM billing_leases WHERE lease_key LIKE ? AND expires_at <= ?")
    .bind(`editor-slot:${workspaceId}:%`, now.toISOString()).run();
  const reservation = `editor-slot:${workspaceId}:${crypto.randomUUID()}`;
  const result = await d1.prepare(`INSERT INTO billing_leases (lease_key, holder_id, expires_at, updated_at)
    SELECT ?, ?, ?, ?
    WHERE (
      (SELECT count(*) FROM workspace_members WHERE workspace_id = ? AND status = 'active' AND role IN ('owner','admin','member'))
      + (SELECT count(*) FROM billing_leases WHERE lease_key LIKE ? AND expires_at > ?)
    ) < ?`)
    .bind(reservation, reservation, new Date(now.getTime() + 60_000).toISOString(), now.toISOString(), workspaceId,
      `editor-slot:${workspaceId}:%`, now.toISOString(), limit).run();
  if (!result.meta.changes) {
    const used = await d1.prepare("SELECT count(*) AS count FROM workspace_members WHERE workspace_id = ? AND status = 'active' AND role IN ('owner','admin','member')")
      .bind(workspaceId).first<{ count: number }>();
    throw new BillingLimitError("editor_quota_exceeded", "활성 편집자 한도에 도달했습니다.", {
      used: Number(used?.count ?? limit), limit, upgradeUrl: "/?view=billing",
    });
  }
  return reservation;
}

export async function releaseEditorSeat(reservation: string | null) {
  if (!reservation) return;
  await (env as BillingRuntimeEnv).DB.prepare("DELETE FROM billing_leases WHERE lease_key = ? AND holder_id = ?")
    .bind(reservation, reservation).run();
}

export async function memberCanWrite(workspaceId: string, userId: string, role: string) {
  if (role === "viewer") return false;
  if (!billingEnforcementEnabled()) return true;
  if (!(await getEditorEnforcementState(workspaceId)).enforced) return true;
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const limit = BILLING_PLANS[plan].editorLimit;
  if (limit === null) return true;
  const rows = await (env as BillingRuntimeEnv).DB.prepare(`SELECT member.id, member.user_id,
      CASE WHEN selection.selected = 1 THEN 1 ELSE 0 END AS explicitly_selected,
      CASE WHEN member.role = 'owner' THEN 0 ELSE 1 END AS owner_rank,
      member.created_at
    FROM workspace_members AS member
    LEFT JOIN workspace_editor_selections AS selection
      ON selection.workspace_id = member.workspace_id AND selection.member_id = member.id
    WHERE member.workspace_id = ? AND member.status = 'active' AND member.role IN ('owner','admin','member')
    ORDER BY explicitly_selected DESC, owner_rank ASC, member.created_at ASC, member.id ASC`).bind(workspaceId).all<Record<string, string | number>>();
  const hasExplicitEditorSelection = rows.results.some((row) => Boolean(row.explicitly_selected));
  if (hasExplicitEditorSelection) {
    return rows.results.some((row) => row.user_id === userId && Boolean(row.explicitly_selected));
  }
  return rows.results.slice(0, limit).some((row) => row.user_id === userId);
}

export async function getAiUsageStatus(workspaceId: string) {
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const period = kstPeriod();
  const [used, editorCount] = await Promise.all([
    getAiMonthlyUsage(workspaceId, subscription.billing_owner_user_id, plan, period),
    getBillableEditorCount(workspaceId),
  ]);
  const percent = aiUsagePercent(used, planAiBudgetWon(plan, editorCount) * 1_000_000);
  if (!percent) throw new Error("AI 사용량을 확인하지 못했습니다.");
  return { ...percent, resetsAt: period.resetsAt };
}

export async function assertAiBudget(workspaceId: string, userId: string) {
  if (!billingEnforcementEnabled()) return { limitWon: null, spentWonMicros: 0, resetsAt: kstPeriod().resetsAt };
  const subscription = await getWorkspaceSubscription(workspaceId);
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  const [spentWonMicros, editorCount] = await Promise.all([
    getAiMonthlyUsage(workspaceId, subscription.billing_owner_user_id, plan),
    getBillableEditorCount(workspaceId),
  ]);
  const limitWon = planAiBudgetWon(plan, editorCount);
  if (spentWonMicros >= limitWon * 1_000_000) {
    throw new BillingLimitError("ai_budget_exceeded", "이번 달 AI 안전 한도에 도달했습니다. 작성 중인 내용은 유지됩니다.", {
      spentWon: Math.ceil(spentWonMicros / 1_000_000), limitWon, resetsAt: kstPeriod().resetsAt, upgradeUrl: "/?view=billing", userId,
    });
  }
  return { limitWon, spentWonMicros, resetsAt: kstPeriod().resetsAt };
}

async function getAiMonthlyUsage(workspaceId: string, billingOwnerUserId: string, plan: BillingPlan, period = kstPeriod()) {
  const d1 = (env as BillingRuntimeEnv).DB;
  const row = plan === "free"
    ? await d1.prepare(`SELECT coalesce(sum(usage.estimated_cost_won_micros), 0) AS spent
        FROM ai_usage_events AS usage
        INNER JOIN workspaces AS workspace ON workspace.id = usage.owner_id
        LEFT JOIN workspace_subscriptions AS subscription ON subscription.workspace_id = workspace.id
        WHERE workspace.owner_user_id = ? AND coalesce(subscription.plan, 'free') = 'free'
          AND usage.created_at >= ? AND usage.created_at < ?`)
      .bind(billingOwnerUserId, period.startsAt, period.resetsAt).first<{ spent: number }>()
    : await d1.prepare(`SELECT coalesce(sum(estimated_cost_won_micros), 0) AS spent FROM ai_usage_events
        WHERE owner_id = ? AND created_at >= ? AND created_at < ?`)
      .bind(workspaceId, period.startsAt, period.resetsAt).first<{ spent: number }>();
  return Number(row?.spent ?? 0);
}

export async function createPaypleSession(workspaceId: string, userId: string, plan: BillingPlan, contractAccepted: boolean) {
  if (!paypleConfigured()) throw new Error("Payple 운영 승인이 완료되지 않아 카드 등록을 시작할 수 없습니다.");
  if (plan === "free") throw new Error("유료 플랜을 선택해 주세요.");
  if (!contractAccepted) throw new Error("가격·자동 갱신·해지 및 환불 조건에 동의해 주세요.");
  await ensureBillingSchema();
  return withWorkspaceLock(workspaceId, async () => {
  if (await getPayPalSubscription(workspaceId)) throw new Error("진행 중인 구독을 먼저 확인해 주세요. 중복 결제는 진행하지 않습니다.");
  const token = crypto.randomUUID();
  const tokenHash = await sha256(token);
  const now = new Date();
  const runtime = env as BillingRuntimeEnv;
  const billableEditors = await getBillableEditorCount(workspaceId);
  const monthlyPriceWon = planMonthlyPriceWon(plan, billableEditors);
  await runtime.DB.prepare(`INSERT INTO billing_sessions
    (token_hash, workspace_id, user_id, plan, price_won, consented_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(tokenHash, workspaceId, userId, plan, monthlyPriceWon, now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString()).run();
  return {
    sessionToken: token,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    provider: "payple",
    work: "AUTH",
    authUrl: runtime.PAYPLE_AUTH_URL,
    merchantId: runtime.PAYPLE_CST_ID,
    returnUrl: `${billingPublicUrl(runtime)}/api/billing/payple/result`,
    plan,
    seatPriceWon: BILLING_PLANS[plan].seatPriceWon,
    billableEditors,
    priceWon: monthlyPriceWon,
  };
  });
}

export async function completePaypleRegistration(input: {
  workspaceId: string; userId: string; sessionToken: string; billingKey: string; payerId: string;
  maskedCard: string; cardCompany: string; paypleTransactionId?: string;
}) {
  if (!paypleConfigured()) throw new Error("Payple 운영 설정이 완료되지 않았습니다.");
  const runtime = env as BillingRuntimeEnv;
  const tokenHash = await sha256(input.sessionToken);
  const session = await runtime.DB.prepare(`SELECT * FROM billing_sessions
    WHERE token_hash = ? AND workspace_id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ? LIMIT 1`)
    .bind(tokenHash, input.workspaceId, input.userId, new Date().toISOString()).first<Record<string, string | number>>();
  if (!session) throw new Error("카드 등록 세션이 만료되었거나 이미 사용되었습니다.");
  const sessionClaim = `${new Date().toISOString()}:${crypto.randomUUID()}`;
  const claimed = await runtime.DB.prepare(`UPDATE billing_sessions SET used_at = ?
    WHERE token_hash = ? AND workspace_id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(sessionClaim, tokenHash, input.workspaceId, input.userId, new Date().toISOString()).run();
  if (!claimed.meta.changes) throw new Error("카드 등록 세션이 이미 처리 중이거나 사용되었습니다.");
  try {
  const verified = await verifyPaypleBillingKey(runtime, input.billingKey, input.payerId);
  const payerHash = await sha256(input.payerId);
  const owner = await runtime.DB.prepare("SELECT owner_user_id FROM workspaces WHERE id = ? LIMIT 1").bind(input.workspaceId).first<{ owner_user_id: string }>();
  if (!owner) throw new Error("워크스페이스를 찾을 수 없습니다.");
  const priorClaim = await runtime.DB.prepare(`SELECT id FROM billing_trial_claims
    WHERE billing_owner_user_id = ? OR payer_hash = ? LIMIT 1`).bind(owner.owner_user_id, payerHash).first();
  const now = new Date();
  const trialEnds = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  const plan = String(session.plan) as BillingPlan;
  if (!validPlan(plan) || plan === "free") throw new Error("카드 등록 세션의 요금제가 올바르지 않습니다.");
  const billableEditors = await getBillableEditorCount(input.workspaceId);
  const monthlyPriceWon = planMonthlyPriceWon(plan, billableEditors);
  if (Number(session.price_won) !== monthlyPriceWon) throw new Error("편집 멤버 수가 변경되었습니다. 현재 예상 요금을 확인하고 카드를 다시 등록해 주세요.");
  const methodId = crypto.randomUUID();
  const immediatePeriodEnd = new Date(now);
  immediatePeriodEnd.setUTCMonth(immediatePeriodEnd.getUTCMonth() + 1);
  const immediateOrderId = `okri-first-${tokenHash.slice(0, 24)}`;
  const immediatePayment = priorClaim
    ? await paypleCharge(runtime, verified.billingKey, immediateOrderId, monthlyPriceWon)
    : null;
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE billing_payment_methods SET active = 0, revoked_at = ?, updated_at = ? WHERE workspace_id = ? AND active = 1")
      .bind(now.toISOString(), now.toISOString(), input.workspaceId),
    runtime.DB.prepare(`INSERT INTO billing_payment_methods
      (id, workspace_id, encrypted_billing_key, payer_hash, card_company, masked_card, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(methodId, input.workspaceId, await encryptPrivateValue(verified.billingKey, runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY!), payerHash,
        (verified.cardCompany || input.cardCompany).slice(0, 80), maskCard(verified.maskedCard || input.maskedCard), now.toISOString(), now.toISOString()),
    runtime.DB.prepare(`INSERT INTO workspace_subscriptions
      (workspace_id, plan, status, billing_owner_user_id, trial_started_at, trial_ends_at, next_billing_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET plan = excluded.plan, status = excluded.status,
        trial_started_at = excluded.trial_started_at, trial_ends_at = excluded.trial_ends_at,
        next_billing_at = excluded.next_billing_at, current_period_started_at = excluded.current_period_started_at,
        current_period_ends_at = excluded.current_period_ends_at, first_paid_at = excluded.first_paid_at,
        last_paid_at = excluded.last_paid_at, cancel_at_period_end = 0, next_plan = NULL, updated_at = excluded.updated_at`)
      .bind(input.workspaceId, plan, priorClaim ? "active" : "trialing", owner.owner_user_id,
        priorClaim ? null : now.toISOString(), priorClaim ? null : trialEnds.toISOString(), priorClaim ? immediatePeriodEnd.toISOString() : trialEnds.toISOString(), now.toISOString(), now.toISOString()),
    ...(priorClaim ? [] : [runtime.DB.prepare(`INSERT INTO billing_trial_claims
      (id, billing_owner_user_id, payer_hash, workspace_id, claimed_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), owner.owner_user_id, payerHash, input.workspaceId, now.toISOString())]),
    ...(priorClaim && immediatePayment ? [
      runtime.DB.prepare(`UPDATE workspace_subscriptions SET current_period_started_at = ?, current_period_ends_at = ?,
        first_paid_at = coalesce(first_paid_at, ?), last_paid_at = ?, updated_at = ? WHERE workspace_id = ?`)
        .bind(now.toISOString(), immediatePeriodEnd.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(), input.workspaceId),
      runtime.DB.prepare(`INSERT INTO billing_transactions
        (id, workspace_id, order_id, idempotency_key, kind, plan, price_won, status, payple_transaction_id, receipt_url,
         period_started_at, period_ends_at, retained_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'charge', ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), input.workspaceId, immediateOrderId, immediateOrderId, plan, monthlyPriceWon,
          immediatePayment.transactionId, immediatePayment.receiptUrl, now.toISOString(), immediatePeriodEnd.toISOString(), addYears(now, 5).toISOString(), now.toISOString(), now.toISOString()),
    ] : [
      runtime.DB.prepare(`INSERT OR IGNORE INTO billing_notifications
        (id, workspace_id, user_id, kind, scheduled_for) VALUES (?, ?, ?, 'trial_contract_confirmation', ?)`)
        .bind(crypto.randomUUID(), input.workspaceId, input.userId, now.toISOString()),
      runtime.DB.prepare(`INSERT OR IGNORE INTO billing_notifications
        (id, workspace_id, user_id, kind, scheduled_for) VALUES (?, ?, ?, 'trial_ending_7d', ?)`)
        .bind(crypto.randomUUID(), input.workspaceId, input.userId, new Date(trialEnds.getTime() - 7 * 24 * 60 * 60_000).toISOString()),
      runtime.DB.prepare(`INSERT OR IGNORE INTO billing_notifications
        (id, workspace_id, user_id, kind, scheduled_for) VALUES (?, ?, ?, 'trial_ending_1d', ?)`)
        .bind(crypto.randomUUID(), input.workspaceId, input.userId, new Date(trialEnds.getTime() - 24 * 60 * 60_000).toISOString()),
    ]),
  ]);
  return { plan, status: priorClaim ? "active" : "trialing", trialEndsAt: priorClaim ? null : trialEnds.toISOString(), paymentMethodId: methodId };
  } catch (error) {
    await runtime.DB.prepare("UPDATE billing_sessions SET used_at = NULL WHERE token_hash = ? AND used_at = ?")
      .bind(tokenHash, sessionClaim).run().catch(() => undefined);
    throw error;
  }
}

export async function changePlan(workspaceId: string, plan: BillingPlan) {
  const current = await getWorkspaceSubscription(workspaceId);
  if (await getPayPalSubscription(workspaceId)) {
    if (plan === "free") return cancelPayPalSubscription(workspaceId);
    throw new Error("PayPal 구독을 해지한 뒤 현재 이용 기간이 끝나면 다른 플랜을 선택할 수 있습니다.");
  }
  if (plan === current.plan) {
    if (current.status === "cancel_at_period_end" && plan !== "free") {
      await (env as BillingRuntimeEnv).DB.prepare(`UPDATE workspace_subscriptions SET status = 'active', next_plan = NULL,
        cancel_at_period_end = 0, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`).bind(workspaceId).run();
      return { plan, status: "active", reactivated: true };
    }
    return { plan, status: current.status, unchanged: true };
  }
  const now = new Date().toISOString();
  const billableEditors = await getBillableEditorCount(workspaceId);
  const currentPriceWon = planMonthlyPriceWon(current.plan, billableEditors);
  const nextPriceWon = planMonthlyPriceWon(plan, billableEditors);
  const upgrade = nextPriceWon > currentPriceWon;
  if (upgrade && current.plan === "free") {
    if (!paypleConfigured()) throw new Error("Payple 운영 설정이 완료되지 않아 유료 플랜을 다시 시작할 수 없습니다.");
    const runtime = env as BillingRuntimeEnv;
    const method = await runtime.DB.prepare("SELECT encrypted_billing_key FROM billing_payment_methods WHERE workspace_id = ? AND active = 1 LIMIT 1")
      .bind(workspaceId).first<{ encrypted_billing_key: string }>();
    if (!method) throw new Error("등록된 결제수단이 없습니다. 카드를 다시 등록해 주세요.");
    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    const orderId = `okri-reactivate-${workspaceId.slice(0, 10)}-${plan}-${stableTimestamp(current.updated_at)}`;
    const paid = await paypleCharge(runtime, await decryptPrivateValue(method.encrypted_billing_key, runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY!), orderId, nextPriceWon);
    await runtime.DB.batch([
      runtime.DB.prepare(`INSERT INTO billing_transactions
        (id, workspace_id, order_id, idempotency_key, kind, plan, price_won, status, payple_transaction_id, receipt_url,
         period_started_at, period_ends_at, retained_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'charge', ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspaceId, orderId, orderId, plan, nextPriceWon, paid.transactionId, paid.receiptUrl,
          periodStart.toISOString(), periodEnd.toISOString(), addYears(periodStart, 5).toISOString(), now, now),
      runtime.DB.prepare(`UPDATE workspace_subscriptions SET plan = ?, status = 'active', next_plan = NULL,
        cancel_at_period_end = 0, retry_count = 0, grace_ends_at = NULL, current_period_started_at = ?,
        current_period_ends_at = ?, next_billing_at = ?, first_paid_at = coalesce(first_paid_at, ?),
        last_paid_at = ?, updated_at = ? WHERE workspace_id = ?`)
        .bind(plan, periodStart.toISOString(), periodEnd.toISOString(), periodEnd.toISOString(), now, now, now, workspaceId),
    ]);
    return { plan, nextPlan: null, effective: "immediate", priceWon: nextPriceWon, billableEditors };
  }
  if (upgrade && current.plan !== "free" && current.status === "active") {
    if (!paypleConfigured()) throw new Error("Payple 운영 설정이 완료되지 않아 즉시 상향할 수 없습니다.");
    const runtime = env as BillingRuntimeEnv;
    const method = await runtime.DB.prepare("SELECT encrypted_billing_key FROM billing_payment_methods WHERE workspace_id = ? AND active = 1 LIMIT 1")
      .bind(workspaceId).first<{ encrypted_billing_key: string }>();
    if (!method) throw new Error("등록된 결제수단이 없습니다.");
    const periodStart = current.current_period_started_at ? Date.parse(current.current_period_started_at) : Date.now();
    const periodEnd = current.current_period_ends_at ? Date.parse(current.current_period_ends_at) : Date.now() + 30 * 24 * 60 * 60_000;
    const fullPeriod = Math.max(1, periodEnd - periodStart);
    const remaining = Math.max(0, periodEnd - Date.now());
    const difference = nextPriceWon - currentPriceWon;
    const priceWon = Math.max(1, Math.ceil((difference * remaining) / fullPeriod));
    const orderId = `okri-upgrade-${workspaceId.slice(0, 10)}-${plan}-${stableTimestamp(current.current_period_ends_at || current.updated_at)}`;
    const paid = await paypleCharge(runtime, await decryptPrivateValue(method.encrypted_billing_key, runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY!), orderId, priceWon);
    await runtime.DB.batch([
      runtime.DB.prepare(`INSERT INTO billing_transactions
        (id, workspace_id, order_id, idempotency_key, kind, plan, price_won, status, payple_transaction_id, receipt_url,
         period_started_at, period_ends_at, retained_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'prorated_upgrade', ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), workspaceId, orderId, orderId, plan, priceWon, paid.transactionId, paid.receiptUrl,
          current.current_period_started_at, current.current_period_ends_at, addYears(new Date(), 5).toISOString(), now, now),
      runtime.DB.prepare("UPDATE workspace_subscriptions SET plan = ?, next_plan = NULL, updated_at = ? WHERE workspace_id = ?")
        .bind(plan, now, workspaceId),
    ]);
    return { plan, nextPlan: null, effective: "immediate", priceWon };
  }
  await (env as BillingRuntimeEnv).DB.prepare(`UPDATE workspace_subscriptions
    SET plan = CASE WHEN ? THEN ? ELSE plan END, next_plan = CASE WHEN ? THEN NULL ELSE ? END,
        status = CASE WHEN ? AND status = 'free' THEN 'trialing' ELSE status END,
        updated_at = ? WHERE workspace_id = ?`)
    .bind(upgrade ? 1 : 0, plan, upgrade ? 1 : 0, plan, upgrade ? 1 : 0, now, workspaceId).run();
  return { plan: upgrade ? plan : current.plan, nextPlan: upgrade ? null : plan, effective: upgrade ? "immediate" : "next_renewal" };
}

export async function cancelSubscription(workspaceId: string) {
  const subscription = await getWorkspaceSubscription(workspaceId);
  if (await getPayPalSubscription(workspaceId)) return cancelPayPalSubscription(workspaceId);
  if (subscription.plan === "free") return { canceled: false, effective: "already_free" };
  await (env as BillingRuntimeEnv).DB.prepare(`UPDATE workspace_subscriptions SET cancel_at_period_end = 1,
    status = 'cancel_at_period_end', next_plan = 'free', updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`).bind(workspaceId).run();
  return { canceled: true, effective: "period_end" };
}

export async function refundFirstPayment(workspaceId: string) {
  await ensureBillingSchema();
  if (await getPayPalSubscription(workspaceId)) return refundPayPalFirstPayment(workspaceId);
  if (!paypleConfigured()) throw new Error("Payple 환불 설정이 완료되지 않았습니다.");
  const runtime = env as BillingRuntimeEnv;
  const transaction = await runtime.DB.prepare(`SELECT * FROM billing_transactions
    WHERE workspace_id = ? AND kind = 'charge' AND status IN ('paid','refunded') ORDER BY created_at ASC LIMIT 1`).bind(workspaceId).first<Record<string, string | number>>();
  if (!transaction) throw new Error("환불할 첫 결제를 찾을 수 없습니다.");
  if (transaction.status === "refunded") return { refunded: true, priceWon: Number(transaction.price_won), plan: "free", unchanged: true };
  if (Date.now() - Date.parse(String(transaction.created_at)) > 7 * 24 * 60 * 60_000) throw new Error("첫 결제 후 7일이 지나 셀프 환불할 수 없습니다.");
  const activity = await runtime.DB.prepare(`SELECT
      (SELECT count(*) FROM project_monthly_usage WHERE workspace_id = ? AND updated_at > ?) AS projects,
      (SELECT count(*) FROM ai_usage_events WHERE owner_id = ? AND created_at > ?) AS ai`)
    .bind(workspaceId, transaction.created_at, workspaceId, transaction.created_at).first<{ projects: number; ai: number }>();
  if (Number(activity?.projects ?? 0) > 0 || Number(activity?.ai ?? 0) > 0) throw new Error("결제 후 Project 생성 또는 AI 사용 기록이 있어 셀프 환불할 수 없습니다.");
  await paypleOperation(runtime, "cancel", String(transaction.payple_transaction_id || ""), Number(transaction.price_won));
  await runtime.DB.batch([
    runtime.DB.prepare("UPDATE billing_transactions SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(transaction.id),
    runtime.DB.prepare("UPDATE workspace_subscriptions SET plan = 'free', status = 'free', next_plan = NULL, cancel_at_period_end = 0, next_billing_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?").bind(workspaceId),
    runtime.DB.prepare("UPDATE billing_payment_methods SET active = 0, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND active = 1").bind(workspaceId),
  ]);
  return { refunded: true, priceWon: Number(transaction.price_won), plan: "free" };
}

export async function runBillingBatch() {
  await ensureBillingSchema();
  const paypal = await reconcilePayPalSubscriptions();
  if (!paypleConfigured()) return { processed: paypal.processed, skipped: false, paypal };
  const runtime = env as BillingRuntimeEnv;
  const holderId = crypto.randomUUID();
  const now = new Date();
  const lease = await runtime.DB.prepare(`INSERT INTO billing_leases (lease_key, holder_id, expires_at, updated_at)
    VALUES ('hourly', ?, ?, ?)
    ON CONFLICT(lease_key) DO UPDATE SET holder_id = excluded.holder_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    WHERE billing_leases.expires_at <= ?`).bind(holderId, new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString(), now.toISOString()).run();
  if (!lease.meta.changes) return { processed: 0, skipped: true, reason: "lease_held" };
  const due = await runtime.DB.prepare(`SELECT * FROM workspace_subscriptions
    WHERE status IN ('trialing','active','past_due','cancel_at_period_end') AND next_billing_at IS NOT NULL AND next_billing_at <= ?
      AND NOT EXISTS (SELECT 1 FROM billing_paypal_subscriptions p WHERE p.workspace_id=workspace_subscriptions.workspace_id AND p.closed_at IS NULL)
    ORDER BY next_billing_at LIMIT 100`).bind(now.toISOString()).all<SubscriptionRow>();
  let processed = 0;
  for (const subscription of due.results) {
    await processDueSubscription(runtime, subscription, now);
    processed += 1;
  }
  await sendDueBillingNotifications(runtime, now);
  await runtime.DB.prepare("DELETE FROM billing_leases WHERE lease_key = 'hourly' AND holder_id = ?").bind(holderId).run();
  return { processed, skipped: false };
}

export async function verifyInternalBillingRequest(request: Request) {
  const secret = (env as BillingRuntimeEnv).INTERNAL_BILLING_SECRET;
  if (!secret) return false;
  const timestamp = request.headers.get("x-okri-timestamp") ?? request.headers.get("x-okrptr-timestamp") ?? "";
  const signature = request.headers.get("x-okri-signature") ?? request.headers.get("x-okrptr-signature") ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  const expected = await hmacSha256(secret, timestamp);
  return timingSafeEqual(expected, signature);
}

async function processDueSubscription(runtime: BillingRuntimeEnv, subscription: SubscriptionRow, now: Date) {
  if (subscription.status === "cancel_at_period_end" || subscription.cancel_at_period_end) {
    await runtime.DB.prepare(`UPDATE workspace_subscriptions SET plan = 'free', status = 'free', next_plan = NULL,
      next_billing_at = NULL, current_period_started_at = NULL, current_period_ends_at = NULL, updated_at = ? WHERE workspace_id = ?`)
      .bind(now.toISOString(), subscription.workspace_id).run();
    return;
  }
  const plan = validPlan(subscription.plan) ? subscription.plan : "free";
  if (plan === "free") return;
  const method = await runtime.DB.prepare("SELECT * FROM billing_payment_methods WHERE workspace_id = ? AND active = 1 LIMIT 1")
    .bind(subscription.workspace_id).first<Record<string, string>>();
  if (!method) {
    await markPaymentFailure(runtime, subscription, now, "payment_method_missing");
    return;
  }
  const orderId = `okri-${subscription.workspace_id.slice(0, 10)}-${stableTimestamp(subscription.next_billing_at || subscription.updated_at)}-${subscription.retry_count}`;
  const existing = await runtime.DB.prepare("SELECT status FROM billing_transactions WHERE order_id = ? LIMIT 1").bind(orderId).first<{ status: string }>();
  if (existing?.status === "paid") return;
  const periodEnd = new Date(now);
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
  try {
    const billableEditors = await getBillableEditorCount(subscription.workspace_id);
    const monthlyPriceWon = planMonthlyPriceWon(plan, billableEditors);
    const billingKey = await decryptPrivateValue(method.encrypted_billing_key, runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY!);
    const paid = await paypleCharge(runtime, billingKey, orderId, monthlyPriceWon);
    await runtime.DB.batch([
      runtime.DB.prepare(`INSERT INTO billing_transactions
        (id, workspace_id, order_id, idempotency_key, kind, plan, price_won, status, payple_transaction_id, receipt_url,
         period_started_at, period_ends_at, retained_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'charge', ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET status = 'paid', payple_transaction_id = excluded.payple_transaction_id,
          receipt_url = excluded.receipt_url, updated_at = excluded.updated_at`)
        .bind(crypto.randomUUID(), subscription.workspace_id, orderId, orderId, plan, monthlyPriceWon,
          paid.transactionId, paid.receiptUrl, now.toISOString(), periodEnd.toISOString(), addYears(now, 5).toISOString(), now.toISOString(), now.toISOString()),
      runtime.DB.prepare(`UPDATE workspace_subscriptions SET status = 'active', retry_count = 0, grace_ends_at = NULL,
        first_paid_at = coalesce(first_paid_at, ?), last_paid_at = ?, current_period_started_at = ?, current_period_ends_at = ?,
        next_billing_at = ?, updated_at = ? WHERE workspace_id = ?`)
        .bind(now.toISOString(), now.toISOString(), now.toISOString(), periodEnd.toISOString(), periodEnd.toISOString(), now.toISOString(), subscription.workspace_id),
    ]);
  } catch (error) {
    await markPaymentFailure(runtime, subscription, now, error instanceof Error ? error.message.slice(0, 120) : "payment_failed");
  }
}

async function markPaymentFailure(runtime: BillingRuntimeEnv, subscription: SubscriptionRow, now: Date, errorCode: string) {
  const nextRetry = subscription.retry_count + 1;
  if (nextRetry > PAYMENT_RETRY_DAYS.length) {
    await runtime.DB.prepare(`UPDATE workspace_subscriptions SET plan = 'free', status = 'free', next_plan = NULL,
      next_billing_at = NULL, retry_count = ?, updated_at = ? WHERE workspace_id = ?`)
      .bind(nextRetry, now.toISOString(), subscription.workspace_id).run();
    return;
  }
  const graceEnds = subscription.grace_ends_at || new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  const retryDay = PAYMENT_RETRY_DAYS[nextRetry - 1];
  const nextBillingAt = subscription.grace_ends_at
    ? new Date(Date.parse(graceEnds) - (7 - retryDay) * 24 * 60 * 60_000).toISOString()
    : new Date(now.getTime() + retryDay * 24 * 60 * 60_000).toISOString();
  await runtime.DB.prepare(`UPDATE workspace_subscriptions SET status = 'past_due', retry_count = ?, grace_ends_at = ?,
    next_billing_at = ?, updated_at = ? WHERE workspace_id = ?`)
    .bind(nextRetry, graceEnds, nextBillingAt, now.toISOString(), subscription.workspace_id).run();
  await runtime.DB.prepare(`INSERT OR IGNORE INTO billing_notifications
    (id, workspace_id, user_id, kind, scheduled_for, last_error) VALUES (?, ?, ?, 'payment_failed', ?, ?)`)
    .bind(crypto.randomUUID(), subscription.workspace_id, subscription.billing_owner_user_id, now.toISOString(), errorCode).run();
}

async function sendDueBillingNotifications(runtime: BillingRuntimeEnv, now: Date) {
  const billingFrom = runtime.OKRI_BILLING_FROM || runtime.OKRPTR_BILLING_FROM;
  if (!runtime.RESEND_API_KEY || !billingFrom) return;
  const rows = await runtime.DB.prepare(`SELECT notification.id, notification.kind, notification.scheduled_for,
      app_user.email_normalized AS email, workspace.name AS workspace_name
    FROM billing_notifications AS notification
    INNER JOIN users AS app_user ON app_user.id = notification.user_id
    INNER JOIN workspaces AS workspace ON workspace.id = notification.workspace_id
    WHERE notification.status = 'pending' AND notification.scheduled_for <= ? ORDER BY notification.scheduled_for LIMIT 100`)
    .bind(now.toISOString()).all<Record<string, string>>();
  for (const row of rows.results) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: billingFrom, to: [row.email], subject: billingEmailSubject(row.kind),
          html: `<p>${escapeHtml(row.workspace_name)} 워크스페이스의 ${escapeHtml(billingEmailSubject(row.kind))}</p><p><a href="${escapeHtml(billingPublicUrl(runtime))}/?view=billing">결제 설정 보기</a></p>` }),
      });
      const payload = await response.json().catch(() => ({})) as { id?: string };
      if (!response.ok) throw new Error(`email_${response.status}`);
      await runtime.DB.prepare("UPDATE billing_notifications SET status = 'sent', provider_message_id = ?, sent_at = ? WHERE id = ?")
        .bind(payload.id || null, now.toISOString(), row.id).run();
    } catch (error) {
      await runtime.DB.prepare("UPDATE billing_notifications SET status = 'failed', last_error = ? WHERE id = ?")
        .bind(error instanceof Error ? error.message.slice(0, 200) : "email_failed", row.id).run();
    }
  }
}

async function verifyPaypleBillingKey(runtime: BillingRuntimeEnv, billingKey: string, payerId: string) {
  if (!billingKey || !payerId) throw new Error("Payple 카드 등록 결과가 올바르지 않습니다.");
  const response = await fetch(`${runtime.PAYPLE_API_URL!.replace(/\/$/, "")}/inquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: billingPublicUrl(runtime) },
    body: JSON.stringify({ cst_id: runtime.PAYPLE_CST_ID, custKey: runtime.PAYPLE_CUST_KEY, PCD_PAYPLE_PAYER_ID: payerId, PCD_PAYER_AUTHTYPE: "pwd" }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || String(data.PCD_PAY_RST ?? data.result ?? "") !== "success") throw new Error("Payple 서버에서 빌링키를 확인하지 못했습니다.");
  const verifiedKey = String(data.PCD_PAYER_ID ?? data.billingKey ?? billingKey);
  if (verifiedKey !== billingKey) throw new Error("Payple 빌링키 검증 결과가 일치하지 않습니다.");
  return {
    billingKey: verifiedKey,
    cardCompany: String(data.PCD_PAY_CARDNAME ?? data.cardCompany ?? ""),
    maskedCard: String(data.PCD_PAY_CARDNUM ?? data.maskedCard ?? ""),
  };
}

async function getEditorEnforcementState(workspaceId: string) {
  if (!billingEnforcementEnabled()) return { enforced: false, graceEndsAt: null as string | null };
  const configuredStart = (env as BillingRuntimeEnv).BILLING_ENFORCEMENT_STARTED_AT;
  if (!configuredStart || !Number.isFinite(Date.parse(configuredStart))) return { enforced: true, graceEndsAt: null as string | null };
  const workspace = await (env as BillingRuntimeEnv).DB.prepare("SELECT created_at FROM workspaces WHERE id = ? LIMIT 1")
    .bind(workspaceId).first<{ created_at: string }>();
  const startedAt = new Date(configuredStart);
  if (!workspace || Date.parse(workspace.created_at) >= startedAt.getTime()) return { enforced: true, graceEndsAt: null as string | null };
  const graceEndsAt = new Date(startedAt.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  return { enforced: Date.now() >= Date.parse(graceEndsAt), graceEndsAt };
}

async function paypleCharge(runtime: BillingRuntimeEnv, billingKey: string, orderId: string, priceWon: number) {
  const response = await fetch(`${runtime.PAYPLE_API_URL!.replace(/\/$/, "")}/payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: billingPublicUrl(runtime) },
    body: JSON.stringify({ cst_id: runtime.PAYPLE_CST_ID, custKey: runtime.PAYPLE_CUST_KEY, PCD_PAY_TYPE: "card", PCD_PAY_WORK: "PAY",
      PCD_PAYER_ID: billingKey, PCD_PAY_OID: orderId, PCD_PAY_GOODS: "OKRI subscription", PCD_PAY_TOTAL: priceWon }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || String(data.PCD_PAY_RST ?? "") !== "success") throw new Error(String(data.PCD_PAY_CODE ?? "payment_failed"));
  return { transactionId: String(data.PCD_PAY_AUTHNO ?? data.PCD_PAY_OID ?? orderId), receiptUrl: String(data.PCD_PAY_RECEIPT ?? "") || null };
}

async function paypleOperation(runtime: BillingRuntimeEnv, operation: "cancel", transactionId: string, priceWon: number) {
  if (!transactionId) throw new Error("Payple 거래번호가 없습니다.");
  const response = await fetch(`${runtime.PAYPLE_API_URL!.replace(/\/$/, "")}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: billingPublicUrl(runtime) },
    body: JSON.stringify({ cst_id: runtime.PAYPLE_CST_ID, custKey: runtime.PAYPLE_CUST_KEY, refundKey: runtime.PAYPLE_REFUND_KEY,
      PCD_PAY_WORK: "CANCEL", PCD_PAY_AUTHNO: transactionId, PCD_REFUND_TOTAL: priceWon, operation }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || String(data.PCD_PAY_RST ?? "") !== "success") throw new Error(String(data.PCD_PAY_CODE ?? "refund_failed"));
}

function validPlan(value: string): value is BillingPlan {
  return value === "free" || value === "team" || value === "business";
}

export function parseBillingPlan(value: unknown): BillingPlan | null {
  return typeof value === "string" && validPlan(value) ? value : null;
}

function maskCard(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) return "****-****-****-****";
  return `${digits.slice(0, 4)}-****-****-${digits.slice(-4)}`;
}

function stableTimestamp(value: string) {
  return value.replace(/\D/g, "").slice(0, 14) || "unknown";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function addYears(date: Date, years: number) {
  const next = new Date(date);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function billingEmailSubject(kind: string) {
  if (kind === "trial_contract_confirmation") return "30일 체험과 자동 갱신 계약 확인";
  if (kind === "trial_ending_7d") return "무료 체험 종료 7일 전 안내";
  if (kind === "trial_ending_1d") return "무료 체험 종료 1일 전 안내";
  if (kind === "payment_failed") return "정기결제 실패 안내";
  return "OKRI 결제 안내";
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
