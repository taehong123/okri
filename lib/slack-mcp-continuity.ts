export type SlackMcpStoredToolTurn = {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  at: string;
  actorUserId?: string;
};

export type PendingProjectApproval = {
  arguments: {
    action: "confirm";
    confirmation: {
      review_id: string;
      version: string;
      confirmed: true;
      initiative_id: string;
      initiative_fingerprint: string;
      editor_revision: string;
      proposal: Record<string, unknown>;
    };
  };
  reviewUserId?: string;
  title: string;
  initiativePath: string[];
};

const approvalPhrases = new Set([
  "ㄱㄱ", "고고", "진행", "진행해", "진행해줘", "진행해주세요",
  "확정", "확정해", "확정해줘", "확정해주세요",
  "승인", "승인해", "승인해줘", "승인해주세요",
  "생성", "생성해", "생성해줘", "생성해주세요",
  "프로젝트생성", "프로젝트생성해", "프로젝트생성해줘", "프로젝트생성해주세요",
  "이대로진행", "이대로진행해", "이대로진행해줘", "이대로진행해주세요",
  "이대로확정", "이대로확정해", "이대로확정해줘", "이대로확정해주세요",
  "이대로승인", "이대로승인해", "이대로승인해줘", "이대로승인해주세요",
  "이대로생성", "이대로생성해", "이대로생성해줘", "이대로생성해주세요",
  "만들어줘", "만들어주세요", "좋아", "좋습니다", "오케이", "응", "네", "그래",
  "ok", "okay", "yes",
]);

export function isExplicitProjectApproval(value: string) {
  const normalized = value.normalize("NFC")
    .replace(/<@[A-Z0-9]+>/giu, "")
    .toLocaleLowerCase()
    .replace(/[\s.!?~…。，、]+/gu, "")
    .trim();
  return approvalPhrases.has(normalized);
}

export function pendingProjectApproval(turns: SlackMcpStoredToolTurn[]): PendingProjectApproval | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.name !== "manage_project" && turn.name !== "propose_project") continue;
    const action = text(turn.arguments.action) || "propose";
    if (action !== "propose") return null;

    const result = record(turn.result);
    const structured = record(result?.structuredContent);
    const review = record(structured?.review);
    if (!review || !["awaiting_user_confirmation", "pending"].includes(text(review.state))) return null;

    const proposal = record(review.proposal);
    const editor = record(review.editor);
    const recommendations = Array.isArray(review.recommendations) ? review.recommendations.map(record).filter(Boolean) : [];
    const requested = Array.isArray(turn.arguments.recommended_initiatives)
      ? turn.arguments.recommended_initiatives.map(record).find(Boolean)
      : null;
    const initiativeId = text(requested?.initiative_id) || text(recommendations[0]?.initiativeId);
    const recommendation = recommendations.find((entry) => text(entry?.initiativeId) === initiativeId) ?? recommendations[0];
    const initiative = record(recommendation?.initiative)
      ?? candidateById(record(review.candidates), initiativeId);
    const resolvedInitiativeId = text(initiative?.id) || initiativeId;
    const fingerprint = text(initiative?.fingerprint);
    const reviewId = text(review.id);
    const version = text(review.version);
    const editorRevision = text(editor?.revision);
    if (!proposal || !reviewId || !version || !resolvedInitiativeId || !fingerprint || !editorRevision) return null;

    const cycleId = initiative && Object.hasOwn(initiative, "cycleId") ? initiative.cycleId : null;
    const path = Array.isArray(initiative?.path) ? initiative.path.filter((value): value is string => typeof value === "string") : [];
    return {
      arguments: {
        action: "confirm",
        confirmation: {
          review_id: reviewId,
          version,
          confirmed: true,
          initiative_id: resolvedInitiativeId,
          initiative_fingerprint: fingerprint,
          editor_revision: editorRevision,
          proposal: { ...proposal, requestedCycleId: cycleId ?? null },
        },
      },
      reviewUserId: turn.actorUserId,
      title: text(review.title) || text(proposal.title),
      initiativePath: path,
    };
  }
  return null;
}

function candidateById(candidates: Record<string, unknown> | null, initiativeId: string) {
  if (!Array.isArray(candidates?.choices)) return null;
  return candidates.choices.map(record).find((entry) => text(entry?.id) === initiativeId) ?? null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
