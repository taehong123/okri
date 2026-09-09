import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace, listUserWorkspaces } from "@/lib/pace-data";
import { readLanguagePreferences } from "@/lib/language-preferences";
import { nextSetupState, readOnboarding, setupGuard, SetupError } from "@/lib/account-onboarding";
import { setupFileInput } from "@/lib/onboarding";
import { prepareOkrFileCreation } from "@/lib/okr-files";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const auth = await authorizeRequest(request, { allowViewerWrite: true });
  if (auth instanceof Response) return auth;
  if (auth.apiToken) return Response.json({ code: "account_session_required" }, { status: 403, headers });
  return Response.json({ onboarding: (await readOnboarding(env.DB, auth.userId)).state }, { headers });
}

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ code: "same_origin_required" }, { status: 403, headers });
  }
  const auth = await authorizeRequest(request, { allowViewerWrite: true });
  if (auth instanceof Response) return auth;
  if (auth.apiToken) return Response.json({ code: "account_session_required" }, { status: 403, headers });
  try {
    const input = await request.json() as Record<string, unknown>;
    if (!input || typeof input !== "object" || !["start", "draft", "workspace", "save", "pause", "complete", "tour"].includes(String(input.action))) throw new SetupError("invalid_setup");
    const { raw, state, exists } = await readOnboarding(env.DB, auth.userId);
    if (!exists) throw new SetupError("account_session_required", 403);
    // Resolve a lost response before checking revisions; saved data is never created twice.
    if (input.action === "save" && state?.cycleId) return Response.json({ onboarding: state }, { headers });
    if (input.action === "workspace" && state?.workspaceId) return Response.json({ onboarding: state }, { headers });
    const next = nextSetupState(state, input);
    const db = env.DB;
    let statements: D1PreparedStatement[] = [];
    if (input.action === "workspace") {
      if (!state || input.confirmed !== true) throw new SetupError("setup_confirmation_required");
      const workspaces = await listUserWorkspaces(auth.userId, auth.ownerId);
      const existing = input.workspaceId
        ? workspaces.find((w) => w.id === input.workspaceId && !w.scheduledDeletionAt && w.kind === state.draft.kind)
        : state.draft.kind === "personal" ? workspaces.find((w) => w.personal && !w.scheduledDeletionAt) : null;
      if (input.workspaceId && !existing) throw new SetupError("setup_workspace_unavailable", 403);
      if (existing) {
        next.workspaceId = existing.id;
        next.workspaceName = existing.name;
        next.step = existing.role === "viewer" ? "tour" : "goal";
      } else {
        const name = state.draft.workspaceName.trim();
        if (state.draft.kind !== "team" || !name || name.length > 80) throw new SetupError("setup_workspace_name");
        if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(request.url).hostname) && /^OKRI(?:\s+|[-_])QA\b/i.test(name)) throw new SetupError("setup_workspace_name");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const { resolvedLanguage } = await readLanguagePreferences(db, auth.userId);
        next.workspaceId = id;
        next.workspaceName = name;
        next.step = "goal";
        statements = [
          db.prepare("INSERT INTO workspaces (id, name, owner_user_id, kind, message_language, created_at, updated_at) VALUES (?, ?, ?, 'team', ?, ?, ?)").bind(id, name, auth.userId, resolvedLanguage, now, now),
          db.prepare("INSERT INTO workspace_members (id, workspace_id, user_id, email, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'owner', 'active', ?, ?)").bind(crypto.randomUUID(), id, auth.userId, auth.email, auth.displayName, now, now),
        ];
      }
    }
    if (input.action === "save") {
      if (!state?.workspaceId || state.step !== "review" || input.confirmed !== true) throw new SetupError("setup_confirmation_required");
      // Re-authorize the actual saved destination, not whichever workspace cookie is active.
      const targetHeaders = new Headers(request.headers);
      targetHeaders.set("x-okri-workspace-id", state.workspaceId);
      const targetAuth = await authorizeRequest(new Request(request.url, { method: "POST", headers: targetHeaders }));
      if (targetAuth instanceof Response) return targetAuth;
      if (targetAuth.ownerId !== state.workspaceId || targetAuth.userId !== auth.userId) throw new SetupError("setup_workspace_unavailable", 403);
      await ensureWorkspace(state.workspaceId);
      const prepared = await prepareOkrFileCreation(state.workspaceId, auth.userId, setupFileInput(state.draft));
      next.cycleId = prepared.cycleId;
      next.step = "tour";
      statements = prepared.statements;
    }
    await db.batch([setupGuard(db, auth.userId, raw, next), ...statements]);
    return Response.json({ onboarding: next }, { headers });
  } catch (error) {
    const conflict = error instanceof Error && /setup_revision_conflict|malformed JSON/i.test(error.message);
    const code = conflict ? "setup_conflict" : error instanceof SetupError ? error.code : error instanceof Error && /^invalid_setup/.test(error.message) ? "invalid_setup" : "setup_save_failed";
    return Response.json({ code }, { status: conflict ? 409 : error instanceof SetupError ? error.status : code === "invalid_setup" ? 400 : 500, headers });
  }
}
