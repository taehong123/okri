import { initialOnboarding, parseOnboarding, setupSteps, validateSetupDraft, type OnboardingState } from "./onboarding";

export class SetupError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export async function readOnboarding(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT onboarding_state FROM users WHERE id = ?").bind(userId).first<{ onboarding_state: string | null }>();
  return { exists: Boolean(row), raw: row?.onboarding_state ?? null, state: parseOnboarding(row?.onboarding_state) };
}

// First statement in each write batch: a stale revision aborts the WHOLE batch.
// JSON validation intentionally raises an SQLite error, never a partial no-op.
export function setupGuard(db: D1Database, userId: string, raw: string | null, next: OnboardingState) {
  return db.prepare(`UPDATE users SET onboarding_state = CASE WHEN onboarding_state IS ? THEN ?
    ELSE json('setup_revision_conflict') END WHERE id = ?`)
    .bind(raw, JSON.stringify(next), userId);
}

export function nextSetupState(current: OnboardingState | null, input: Record<string, unknown>) {
  const state = current ?? initialOnboarding();
  if (input.revision !== state.revision) throw new SetupError("setup_conflict", 409);
  const next = { ...state, revision: state.revision + 1 };
  if (input.action === "start") { next.status = "active"; return next; }
  if (!current) throw new SetupError("setup_not_started");
  if (input.action === "pause") { next.status = "paused"; return next; }
  if (input.action === "complete") { next.status = "completed"; return next; }
  if (input.action === "tour") { next.step = "tour"; return next; }
  if (input.action === "draft") {
    if (state.cycleId || state.status === "completed") throw new SetupError("setup_already_saved", 409);
    next.draft = validateSetupDraft(input.draft);
    if (state.workspaceId && next.draft.kind !== state.draft.kind) throw new SetupError("setup_workspace_fixed");
    if (typeof input.step !== "string" || !setupSteps.includes(input.step as OnboardingState["step"]) || input.step === "tour") throw new SetupError("invalid_setup");
    next.step = input.step as OnboardingState["step"];
    return next;
  }
  return next;
}
