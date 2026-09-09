export type SetupStep = "purpose" | "workspace" | "goal" | "results" | "approach" | "review" | "tour";
export type SetupDraft = {
  kind: "personal" | "team";
  workspaceName: string;
  workspaceChoiceId: string;
  objective: string;
  startDate: string;
  endDate: string;
  keyResults: { title: string; initiative: string }[];
};
export type OnboardingState = {
  version: 1;
  revision: number;
  status: "active" | "paused" | "completed";
  step: SetupStep;
  draft: SetupDraft;
  workspaceId: string | null;
  workspaceName: string;
  cycleId: string | null;
};

export function initialOnboarding(): OnboardingState {
  return { version: 1, revision: 0, status: "active", step: "purpose", workspaceId: null, workspaceName: "", cycleId: null,
    draft: { kind: "personal", workspaceName: "", workspaceChoiceId: "", objective: "", startDate: "", endDate: "", keyResults: [{ title: "", initiative: "" }] } };
}

export function parseOnboarding(value: string | null | undefined): OnboardingState | null {
  if (!value) return null;
  try {
    const state = JSON.parse(value) as OnboardingState;
    if (state.version !== 1 || !Number.isInteger(state.revision) || !["active", "paused", "completed"].includes(state.status)) return null;
    return { ...state, draft: validateSetupDraft(state.draft), step: setupSteps.includes(state.step) ? state.step : "purpose" };
  } catch { return null; }
}

export const setupSteps: SetupStep[] = ["purpose", "workspace", "goal", "results", "approach", "review", "tour"];
export function validateSetupDraft(input: unknown): SetupDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_setup");
  const value = input as Record<string, unknown>;
  const string = (text: unknown, max: number) => { if (typeof text !== "string" || text.length > max) throw new Error("invalid_setup"); return text; };
  if (value.kind !== "personal" && value.kind !== "team") throw new Error("invalid_setup");
  if (!Array.isArray(value.keyResults) || !value.keyResults.length || value.keyResults.length > 5) throw new Error("invalid_setup");
  return { kind: value.kind, workspaceName: string(value.workspaceName, 80), workspaceChoiceId: string(value.workspaceChoiceId ?? "", 100), objective: string(value.objective, 200),
    startDate: string(value.startDate, 10), endDate: string(value.endDate, 10),
    keyResults: value.keyResults.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("invalid_setup");
      const row = entry as Record<string, unknown>;
      return { title: string(row.title, 200), initiative: string(row.initiative, 200) };
    }) };
}

export function setupGoalErrors(draft: SetupDraft) {
  const errors: string[] = [];
  if (!draft.objective.trim()) errors.push("objective");
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!validDate(draft.startDate) || !validDate(draft.endDate) || draft.endDate < draft.startDate) errors.push("dates");
  if (draft.keyResults.some((row) => !row.title.trim())) errors.push("keyResults");
  return errors;
}

export function setupFileInput(draft: SetupDraft) {
  if (setupGoalErrors(draft).length) throw new Error("invalid_setup_goal");
  return {
    metadata: { name: draft.objective.trim(), department: "", startDate: draft.startDate, endDate: draft.endDate, status: "active" as const },
    objective: { clientId: "setup-objective", title: draft.objective.trim(), status: "todo" as const,
      keyResults: draft.keyResults.map((row, index) => ({ clientId: `setup-kr-${index}`, title: row.title.trim(), status: "todo" as const, progress: 0,
        initiatives: row.initiative.trim() ? [{ clientId: `setup-initiative-${index}`, title: row.initiative.trim(), status: "todo" as const }] : [] })) },
  };
}

// Explicit destinations (invitations, detail links and OAuth returns) always win.
export function canAutoOpenSetup(search: string, hash: string) {
  const params = new URLSearchParams(search);
  return !hash && [...params.keys()].every((key) => key === "release") && !params.has("auth");
}
