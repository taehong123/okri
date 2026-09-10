import { env } from "cloudflare:workers";
import { z } from "zod";
import type { RequestAuthorization } from "@/lib/pace-data";
import { approveProjectReview, cancelProjectReview, getProjectReview, getReviewInitiative, listReviewInitiatives,
  ProjectReviewError, projectReviewSummary, type ProjectProposal, type ProjectReview } from "@/lib/project-review";
import { getProjectReviewEditor, prepareEditedProjectReview } from "@/lib/project-review-editor";
import { stageProjectReview } from "@/lib/project-review-service";
import { writeReviewedProject } from "@/lib/project-review-writer";

export const mcpProjectConfirmationSchema = z.object({
  review_id: z.string().uuid(), version: z.string().uuid(), confirmed: z.literal(true),
  initiative_id: z.string().min(1), initiative_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  editor_revision: z.string().regex(/^[a-f0-9]{64}$/),
  proposal: z.record(z.string(), z.unknown()).describe("Complete final proposal shown to and approved by the user, including every field and explicit nulls. Use the selected Initiative's cycleId as requestedCycleId."),
});

export const MCP_CREATE_ITEM_CONFIRM_PREFIX = "okri-confirm:";
export const LEGACY_MCP_CREATE_ITEM_CONFIRM_PREFIX = "okrptr-confirm:";

export const MCP_PROJECT_NEXT_STEP = "웹이나 새 대화로 이동할 필요가 없습니다. 이 대화에서 제목·범위·책임자·기한·속성(미지정 포함)과 추천 이유·Objective→KR→Initiative 경로를 자연스럽게 요약하고 최종 내용을 확인받으세요. 수정도 여기서 반영합니다. 명시적 승인을 받은 뒤 같은 manage_project 도구를 action=confirm으로 다시 호출하세요. 이 도구가 보이지 않고 create_item만 있으면 응답의 same_tool_confirmation 값을 사용자에게 보이지 않은 채 같은 create_item 호출에 재사용하세요. 검토 ID를 복사하게 하거나 @OKRI 재활성화, 새 대화, 별도 화면을 요구하지 마세요. 사용자 승인 없이 후보를 정하거나 생성하지 마세요.";

export function mcpProjectReceipt(review: ProjectReview) {
  return { id: review.id, version: review.version, state: review.state, title: review.proposal.title,
    projectId: review.state === "created" ? review.projectId : null,
    initiativePath: review.selectedParent?.path ?? [], summary: projectReviewSummary(review) };
}

async function reviewContext(authorization: RequestAuthorization, review: ProjectReview, query = "", cycleId?: string | null) {
  const [editor, candidates, recommendations] = await Promise.all([
    getProjectReviewEditor(authorization.ownerId),
    listReviewInitiatives(env.DB, authorization.ownerId, query, cycleId === undefined ? review.proposal.requestedCycleId : cycleId),
    Promise.all(review.recommendations.map(async (entry) => ({ ...entry,
      initiative: await getReviewInitiative(env.DB, authorization.ownerId, entry.initiativeId) }))),
  ]);
  return { proposal: review.proposal, editor, candidates, recommendations, expiresAt: review.expiresAt, nextStep: MCP_PROJECT_NEXT_STEP };
}

export async function stageMcpProjectReview(authorization: RequestAuthorization, input: Record<string, unknown>,
  recommendations: { initiativeId: string; reason: string }[], origin: string) {
  const staged = await stageProjectReview(authorization, input, recommendations, origin);
  const review = await getProjectReview(env.DB, authorization, staged.id);
  return { ...mcpProjectReceipt(review), ...await reviewContext(authorization, review),
    state: "awaiting_user_confirmation", selectedInitiative: null };
}

export async function readMcpProjectReview(authorization: RequestAuthorization, id: string,
  options: { includeContext?: boolean; query?: string; cycleId?: string | null } = {}) {
  const review = await getProjectReview(env.DB, authorization, id);
  return { ...mcpProjectReceipt(review), ...(review.state === "pending" && options.includeContext
    ? await reviewContext(authorization, review, options.query, options.cycleId) : {}) };
}

function assertMcpReviewWriter(authorization: RequestAuthorization) {
  // The MCP transport checks token validity and current membership; the atomic writer rechecks write eligibility.
  if (!authorization.userId || authorization.userId === "api-token") {
    throw new ProjectReviewError("personal_connection_required", "계정에 연결된 개인 MCP 연결로 생성해 주세요. 공용 서버 키로 사용자를 대신할 수 없습니다.", 403);
  }
  const scopes = authorization.oauthScopes?.split(" ") ?? [];
  if (authorization.role === "viewer" || (authorization.apiToken
    && !scopes.some((scope) => scope === "okri:write" || scope === "okrptr:write"))) {
    throw new ProjectReviewError("read_only", "이 MCP 연결은 읽기 전용입니다.", 403);
  }
}

export async function confirmMcpProjectReview(authorization: RequestAuthorization, raw: unknown,
  reviewUserId = authorization.userId) {
  assertMcpReviewWriter(authorization);
  const input = mcpProjectConfirmationSchema.parse(raw);
  const reviewIdentity = { ownerId: authorization.ownerId, userId: reviewUserId };
  const review = await approveProjectReview(env.DB, reviewIdentity, {
    id: input.review_id, version: input.version, initiativeId: input.initiative_id, initiativeFingerprint: input.initiative_fingerprint,
  }, (draft, parent, completed) => writeReviewedProject(authorization, draft, parent, completed),
  (draft, parent) => prepareEditedProjectReview(authorization.ownerId, draft, parent, input.proposal, input.editor_revision));
  return mcpProjectReceipt(review);
}

export async function confirmMcpProjectReviewFromCreateItem(
  authorization: RequestAuthorization,
  reviewId: string,
  initiativeId: string,
  proposalOverrides: Partial<ProjectProposal> = {},
) {
  assertMcpReviewWriter(authorization);
  const [review, editor, initiative] = await Promise.all([
    getProjectReview(env.DB, authorization, reviewId),
    getProjectReviewEditor(authorization.ownerId),
    getReviewInitiative(env.DB, authorization.ownerId, initiativeId),
  ]);
  if (!initiative) throw new ProjectReviewError("invalid_initiative", "Choose an active Initiative from the Project proposal.", 400);
  const approvedOverrides = Object.fromEntries(
    Object.entries(proposalOverrides).filter(([, value]) => value !== undefined),
  );
  return confirmMcpProjectReview(authorization, {
    review_id: review.id,
    version: review.version,
    confirmed: true,
    initiative_id: initiative.id,
    initiative_fingerprint: initiative.fingerprint,
    editor_revision: editor.revision,
    proposal: { ...review.proposal, ...approvedOverrides, requestedCycleId: initiative.cycleId },
  });
}

export async function cancelMcpProjectReview(authorization: RequestAuthorization, id: string, version: string) {
  assertMcpReviewWriter(authorization);
  return mcpProjectReceipt(await cancelProjectReview(env.DB, authorization, id, version));
}
