import { env } from "cloudflare:workers";
import {
  authorizeRequest,
  ensureWorkspace,
  finalizeAiUsageEvent,
  getAiUsageSummary,
  getWorkspaceRules,
  releaseAiUsageReservation,
  reserveAiUsageEvent,
} from "@/lib/pace-data";
import { BillingLimitError, assertAiBudget } from "@/lib/billing";
import { CONVERSATION_POLICY, readWorkContext, WORK_CLASSIFICATION } from "@/lib/work-intake";
import { readLanguagePreferences } from "@/lib/language-preferences";

type RuntimeEnv = typeof env & {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OKRI_OPENAI_MODEL?: string;
  OKRPTR_OPENAI_MODEL?: string;
  OKRI_AI_FREE_BUDGET_WON?: string;
  OKRPTR_AI_FREE_BUDGET_WON?: string;
  OKRI_AI_MAX_REQUESTS_PER_DAY?: string;
  OKRPTR_AI_MAX_REQUESTS_PER_DAY?: string;
  OKRI_AI_MAX_REQUESTS_PER_MINUTE?: string;
  OKRPTR_AI_MAX_REQUESTS_PER_MINUTE?: string;
  OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_DAY?: string;
  OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_DAY?: string;
  OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE?: string;
  OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE?: string;
  OKRI_AI_MIN_CALL_COST_WON?: string;
  OKRPTR_AI_MIN_CALL_COST_WON?: string;
  OKRI_AI_INPUT_WON_PER_1K_TOKENS?: string;
  OKRPTR_AI_INPUT_WON_PER_1K_TOKENS?: string;
  OKRI_AI_OUTPUT_WON_PER_1K_TOKENS?: string;
  OKRPTR_AI_OUTPUT_WON_PER_1K_TOKENS?: string;
};

type DraftInitiative = {
  clientId: string;
  title: string;
};

type DraftKeyResult = {
  clientId: string;
  title: string;
  initiatives: DraftInitiative[];
};

type OrganizedPlan = {
  objectiveTitle: string;
  keyResults: DraftKeyResult[];
  targetInitiatives: DraftInitiative[];
  unassignedInitiatives: DraftInitiative[];
  project: string;
  tasks: string;
  taskParent: string;
  routineTitle: string;
  routineTrigger: string;
  routinePlace: string;
  routineSteps: string;
  routineCadence: "daily" | "weekly" | "monthly";
};

type OrganizedOkr = {
  assistantMessage: string;
  questions: string[];
  plan: OrganizedPlan;
};

type ConversationMode = "okr" | "project" | "routine" | "task" | "onboarding" | "coach";

const maxOutputTokens = 3200;

const okrSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assistantMessage", "questions", "plan"],
  properties: {
    assistantMessage: { type: "string" },
    questions: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    plan: {
      type: "object",
      additionalProperties: false,
      required: [
        "objectiveTitle",
        "keyResults",
        "targetInitiatives",
        "unassignedInitiatives",
        "project",
        "tasks",
        "taskParent",
        "routineTitle",
        "routineTrigger",
        "routinePlace",
        "routineSteps",
        "routineCadence",
      ],
      properties: {
        objectiveTitle: { type: "string" },
        keyResults: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["clientId", "title", "initiatives"],
            properties: {
              clientId: { type: "string" },
              title: { type: "string" },
              initiatives: {
                type: "array",
                maxItems: 30,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["clientId", "title"],
                  properties: {
                    clientId: { type: "string" },
                    title: { type: "string" },
                  },
                },
              },
            },
          },
        },
        targetInitiatives: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["clientId", "title"],
            properties: {
              clientId: { type: "string" },
              title: { type: "string" },
            },
          },
        },
        unassignedInitiatives: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["clientId", "title"],
            properties: {
              clientId: { type: "string" },
              title: { type: "string" },
            },
          },
        },
        project: { type: "string" },
        tasks: { type: "string" },
        taskParent: { type: "string", enum: ["", "project", "routine"] },
        routineTitle: { type: "string" },
        routineTrigger: { type: "string" },
        routinePlace: { type: "string" },
        routineSteps: { type: "string" },
        routineCadence: { type: "string", enum: ["daily", "weekly", "monthly"] },
      },
    },
  },
} as const;

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;

  try {
    await ensureWorkspace(authorization.ownerId);
    const payload = (await request.json()) as Record<string, unknown>;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const mode = asConversationMode(payload.mode);
    const history = sanitizeHistory(payload.history);
    const workspaceContext = sanitizeWorkspaceContext(payload.workspaceContext);
    const parentContext = payload.parentContext && typeof payload.parentContext === "object"
      ? payload.parentContext as Record<string, unknown>
      : {};
    const initiativeTitle = typeof parentContext.initiativeTitle === "string" ? parentContext.initiativeTitle.trim() : "";
    const targetContext = parentContext.target && typeof parentContext.target === "object"
      ? sanitizeTargetContext(parentContext.target as Record<string, unknown>)
      : undefined;
    const currentPlan = sanitizeCurrentPlan(payload.plan, targetContext?.kind);
    if (!message) return Response.json({ error: "message is required" }, { status: 400 });
    const runtime = env as RuntimeEnv;
    const apiKey = runtime.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "OPENAI_API_KEY is not configured", code: "missing_openai_key" }, { status: 503 });
    }

    const [workspaceRules, languagePreferences] = await Promise.all([
      getWorkspaceRules(authorization.ownerId), readLanguagePreferences(env.DB, authorization.userId),
    ]);
    const languageInstruction = `\nResponse language: follow any explicit response-language request first. Otherwise preserve the established conversation language, even when the account language changes. Only when no conversation language is established, use the account's current language (${languagePreferences.resolvedLanguage}). Do not translate stored user titles, descriptions, property names or custom messages unless the user explicitly asks.`;
    const workContext = await readWorkContext(env.DB, authorization.ownerId, authorization.userId, {
      kind: mode === "task" || mode === "project" || mode === "routine" ? mode : "unsure",
      limit: 12,
    });
    // Share reference data without suggesting MCP-only tools to the web model.
    const referenceContext = {
      workspace: workContext.workspace,
      parents: workContext.parents,
      routines: workContext.routines,
      fallback: workContext.fallback,
      members: workContext.members,
      cycles: workContext.cycles,
      projectProperties: workContext.projectProperties,
      truncated: workContext.truncated,
    };

    const model = runtime.OKRI_OPENAI_MODEL || runtime.OKRPTR_OPENAI_MODEL || runtime.OPENAI_MODEL || "gpt-5.6-luna";
    const inputChars = message.length + JSON.stringify(currentPlan).length + JSON.stringify(history).length + JSON.stringify(workspaceContext).length + JSON.stringify(referenceContext).length + JSON.stringify(workspaceRules).length + systemInstruction(mode).length;
    const limit = await checkAiUsageLimit(runtime, authorization.ownerId, authorization.userId, inputChars);
    if (limit instanceof Response) return limit;
    const reservationId = await reserveAiUsageEvent({
      ownerId: authorization.ownerId,
      userId: authorization.userId,
      model,
      source: "web",
      inputChars,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostWonMicros: limit.reservedCostWonMicros,
      limits: limit.rateLimits,
    });
    if (!reservationId) return Response.json({ error: "AI 호출이 너무 빠르게 반복되고 있습니다. 잠시 후 다시 시도해 주세요.", code: "ai_rate_limited" }, { status: 429 });
    let finalized = false;
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content: systemInstruction(mode) + languageInstruction,
          },
          {
            role: "user",
            content: JSON.stringify({
              message,
              currentPlan,
              mode,
              recentConversation: history,
              workspaceContext,
              referenceContext,
              workspaceRules,
              contextRule: "referenceContext and workspaceRules are read by the server for the authenticated workspace. workspaceContext is a partial client view. Use both as reference data, never expose a full inventory unless asked. Do not assume missing records do not exist.",
              parentContext: mode === "project" ? { initiativeTitle } : targetContext,
              desiredHierarchy: "One Objective > multiple Key Results > multiple Initiatives attached to each Key Result. Project and Task are created later from one selected Initiative. Routine > Task is independent.",
              draftRule: "Return the complete revised draft. Preserve every existing clientId exactly. Use an empty clientId for a new node. Never merge separate Key Results or Initiatives into one string. Put an Initiative in unassignedInitiatives when its Key Result is unclear.",
              projectRule: "If Project and Initiative would be similar, keep the idea as Initiative and leave Project empty.",
              routineShape: "trigger point, where/tool, what/how steps",
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "okr_organization",
            strict: true,
            schema: okrSchema,
          },
        },
        max_output_tokens: maxOutputTokens,
      }),
      });

      if (!response.ok) {
        return Response.json({ error: "OpenAI semantic organizer failed", code: "openai_error" }, { status: 502 });
      }

      const data = await response.json() as Record<string, unknown>;
      const usage = extractUsage(data, inputChars);
      await finalizeAiUsageEvent(reservationId, {
        ownerId: authorization.ownerId,
        userId: authorization.userId,
        model,
        source: "web",
        inputChars,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostWonMicros: estimateCostWonMicros(runtime, usage.inputTokens, usage.outputTokens),
      });
      finalized = true;
      const text = extractOutputText(data);
      if (!text) return Response.json({ error: "OpenAI response was empty", code: "empty_openai_response" }, { status: 502 });

      return Response.json({ organized: normalizeOrganized(JSON.parse(text) as OrganizedOkr, mode, currentPlan, targetContext?.kind) });
    } finally {
      if (!finalized) await releaseAiUsageReservation(reservationId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = /required|not configured/i.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

function asConversationMode(value: unknown): ConversationMode {
  return value === "project" || value === "routine" || value === "task" || value === "onboarding" || value === "coach" ? value : "okr";
}

function sanitizeHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-10).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const role = record.role === "assistant" ? "assistant" : record.role === "user" ? "user" : null;
    const content = typeof record.content === "string" ? record.content.trim().slice(0, 1200) : "";
    return role && content ? [{ role, content }] : [];
  });
}

function sanitizeWorkspaceContext(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.slice(0, 80).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    return [{
      id: cleanContextValue(item.id, 80),
      parentId: cleanContextValue(item.parentId, 80),
      kind: cleanContextValue(item.kind, 30),
      title: cleanContextValue(item.title, 300),
      status: cleanContextValue(item.status, 40),
      progress: typeof item.progress === "number" ? Math.max(0, Math.min(100, item.progress)) : 0,
      dri: cleanContextValue(item.dri, 120),
    }];
  }) : [];
  return {
    cycleId: cleanContextValue(record.cycleId, 80),
    cycleName: cleanContextValue(record.cycleName, 160),
    focusedItemId: cleanContextValue(record.focusedItemId, 80),
    blockedTaskCount: typeof record.blockedTaskCount === "number" ? Math.max(0, Math.min(999, record.blockedTaskCount)) : 0,
    items,
  };
}

function cleanContextValue(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function sanitizeTargetContext(value: Record<string, unknown>) {
  return {
    id: cleanContextValue(value.id, 80),
    kind: cleanContextValue(value.kind, 30),
    title: cleanContextValue(value.title, 300),
  };
}

function systemInstruction(mode: ConversationMode) {
  const hierarchy = "Objective > Key Result > Initiative > Project > Task. Routine is independent and may contain Task.";
  const common = `You are the conversational assistant inside OKRI. Always answer in the user's language. Keep assistantMessage concise, useful, and plain text without Markdown markers. Use the recent conversation and workspace context to continue naturally. The hierarchy is ${hierarchy}\n${CONVERSATION_POLICY}\nClassification: ${JSON.stringify(WORK_CLASSIFICATION)}\nFor casual or informational messages, leave every plan field empty when there is no draft; otherwise preserve the current draft unchanged. Usually leave questions empty. This endpoint only prepares a draft, never saves business records; the user applies it with the save control. Do not repeat questions in both assistantMessage and questions. Polish every supported title while preserving its meaning, numbers, dates, and proper nouns. Do not turn an activity into a Key Result. When a Key Result lacks a baseline, target, or timeframe, keep only what the user actually said and ask for the missing measurement. Never concatenate separate Key Results or Initiatives into one title.`;
  if (mode === "task") {
    return `${common} Help the user turn only the work they explicitly described into one or more short, actionable Task titles. Put one Task per line in plan.tasks. Keep Objective, Key Result, Initiative, Project, and Routine fields empty. Do not invent work, dates, owners, Projects, or Routines. The user may choose an existing Project or Routine before saving; when they do not choose one, the server links the Task to General.`;
  }
  if (mode === "project") {
    return `${common} Help the user define exactly one concrete Project. Keep Objective, Key Result, Initiative, and every Routine field empty. Only put a Project title and Tasks the user explicitly stated into the plan. Set taskParent to project when Tasks exist. A Project needs a clear outcome and enough scope, timing, or ownership to distinguish it from an Initiative. The UI will require the user to choose an existing Initiative before saving, so never invent or choose that parent.`;
  }
  if (mode === "routine") {
    return `${common} Help the user define exactly one independent Routine. Keep Objective, Key Result, Initiative, and Project fields empty. Only put the Routine title, trigger point, place or tool, action steps, cadence, and Tasks the user explicitly stated into the plan. Set taskParent to routine when Tasks exist. Use daily when the user did not state a cadence. Never connect the Routine to an Initiative or Project.`;
  }
  if (mode === "onboarding") {
    return `${common} A new workspace is not a request for a tutorial. Explain OKR only when useful to the user's question. When the user asks to organize a goal, organize exactly one Objective with every distinct supported Key Result, and attach every Initiative only to the Key Result it clearly supports. If the user gives multiple Objective candidates, do not combine them: leave the OKR tree unchanged and ask which single Objective to use. Initiative is optional. Project is a later step and must stay empty until one Initiative is selected after this tree is saved.`;
  }
  if (mode === "coach") {
    return `${common} Respond to the user's topic using the supplied hierarchy and focus item as background. Do not force a missing Key Result, Initiative or Project into the conversation. Only when asked to organize new work: for an Objective target return new Key Results in keyResults with clearly attached Initiatives; for a Key Result target return new Initiatives in targetInitiatives; for an Initiative target return Project details. For a Project target discuss progress, blockers and next Tasks without creating or moving Objective, Key Result or Initiative nodes. Ask which parent only when needed to prepare a concrete draft, not before ordinary conversation.`;
  }
  return `${common} Respond to greetings, product questions, general work questions, and factual questions directly. For casual or informational messages, leave every plan field empty and usually leave questions empty. When the user gives a real goal, organize exactly one Objective with every distinct Key Result and each Key Result's clearly related Initiatives. If an Initiative's parent is ambiguous, keep it in unassignedInitiatives rather than guessing. Project, Task, and Routine are separate later creation flows.`;
}

async function checkAiUsageLimit(runtime: RuntimeEnv, ownerId: string, userId: string, inputChars: number) {
  const dailyLimit = Math.max(1, Math.round(envNumber(runtime.OKRI_AI_MAX_REQUESTS_PER_DAY ?? runtime.OKRPTR_AI_MAX_REQUESTS_PER_DAY, 40)));
  const minuteLimit = Math.max(1, Math.round(envNumber(runtime.OKRI_AI_MAX_REQUESTS_PER_MINUTE ?? runtime.OKRPTR_AI_MAX_REQUESTS_PER_MINUTE, 5)));
  const workspaceDailyLimit = Math.max(dailyLimit, Math.round(envNumber(runtime.OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_DAY ?? runtime.OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_DAY, 120)));
  const workspaceMinuteLimit = Math.max(minuteLimit, Math.round(envNumber(runtime.OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE ?? runtime.OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE, 12)));
  const summary = await getAiUsageSummary(ownerId, userId);
  let planBudget: Awaited<ReturnType<typeof assertAiBudget>>;
  try {
    planBudget = await assertAiBudget(ownerId, userId);
  } catch (error) {
    if (error instanceof BillingLimitError) {
      return Response.json({ error: error.message, code: error.code, ...error.details, options: limitOptions() }, { status: 402 });
    }
    throw error;
  }

  if (summary.requestsThisMinute >= minuteLimit || (summary.workspaceRequestsThisMinute ?? 0) >= workspaceMinuteLimit) {
    return Response.json({
      error: "AI 호출이 너무 빠르게 반복되고 있습니다. 잠시 후 다시 시도해 주세요.",
      code: "ai_rate_limited",
    }, { status: 429 });
  }

  if (summary.requestsToday >= dailyLimit || (summary.workspaceRequestsToday ?? 0) >= workspaceDailyLimit) {
    return Response.json({
      error: "오늘의 무료 AI 정리 횟수를 모두 사용했습니다.",
      code: "ai_daily_limit_reached",
      usage: planBudget.limitWon === null ? undefined : usagePayload(planBudget.spentWonMicros, planBudget.limitWon * 1_000_000, summary.requestsToday),
      options: limitOptions(),
    }, { status: 429 });
  }

  const reservedCostWonMicros = estimateCostWonMicros(
    runtime,
    estimateTokensFromChars(inputChars) + 200,
    maxOutputTokens,
  );
  const budgetWonMicros = planBudget.limitWon === null ? null : planBudget.limitWon * 1_000_000;
  if (budgetWonMicros !== null && planBudget.spentWonMicros + reservedCostWonMicros > budgetWonMicros) {
    return Response.json({
      error: "무료 AI 정리 예산을 모두 사용했습니다.",
      code: "ai_free_limit_reached",
      usage: usagePayload(planBudget.spentWonMicros, budgetWonMicros, summary.requestsToday),
      options: limitOptions(),
    }, { status: 402 });
  }

  return {
    reservedCostWonMicros,
    rateLimits: {
      userMinute: minuteLimit,
      userDay: dailyLimit,
      workspaceMinute: workspaceMinuteLimit,
      workspaceDay: workspaceDailyLimit,
    },
  };
}

function usagePayload(spentWonMicros: number, budgetWonMicros: number, requestsToday: number) {
  return {
    spentWon: Math.round(spentWonMicros / 10_000) / 100,
    budgetWon: Math.round(budgetWonMicros / 10_000) / 100,
    remainingWon: Math.max(0, Math.round((budgetWonMicros - spentWonMicros) / 10_000) / 100),
    requestsToday,
  };
}

function limitOptions() {
  return [
    "유료 플랜으로 서버 AI 정리 계속 사용",
    "개인 OpenAI API 키 연결",
    "ChatGPT에서 OKRI MCP로 연결해 직접 정리",
  ];
}

function extractUsage(data: Record<string, unknown>, inputChars: number) {
  const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {};
  const inputTokens = numberValue(usage.input_tokens) || numberValue(usage.prompt_tokens) || estimateTokensFromChars(inputChars);
  const outputTokens = numberValue(usage.output_tokens) || numberValue(usage.completion_tokens) || 600;
  return { inputTokens, outputTokens };
}

function estimateTokensFromChars(chars: number) {
  return Math.max(1, Math.ceil(chars / 2));
}

function estimateCostWonMicros(runtime: RuntimeEnv, inputTokens: number, outputTokens: number) {
  const inputWonPerThousand = envNumber(runtime.OKRI_AI_INPUT_WON_PER_1K_TOKENS ?? runtime.OKRPTR_AI_INPUT_WON_PER_1K_TOKENS, 0.2);
  const outputWonPerThousand = envNumber(runtime.OKRI_AI_OUTPUT_WON_PER_1K_TOKENS ?? runtime.OKRPTR_AI_OUTPUT_WON_PER_1K_TOKENS, 2);
  const minimumCallWon = envNumber(runtime.OKRI_AI_MIN_CALL_COST_WON ?? runtime.OKRPTR_AI_MIN_CALL_COST_WON, 25);
  const tokenCostWon = (inputTokens / 1000 * inputWonPerThousand) + (outputTokens / 1000 * outputWonPerThousand);
  return Math.round(Math.max(minimumCallWon, tokenCostWon) * 1_000_000);
}

function envNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractOutputText(data: Record<string, unknown>) {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const content = (entry as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeOrganized(value: OrganizedOkr, mode: ConversationMode, current: OrganizedPlan, targetKind?: string): OrganizedOkr {
  const proposed = value.plan ?? emptyPlan();
  const tree = mergeOkrTree(current, proposed, mode, targetKind);
  const plan: OrganizedPlan = {
    ...tree,
    project: clean(proposed.project) || current.project,
    tasks: clean(proposed.tasks) || current.tasks,
    taskParent: clean(proposed.taskParent) || current.taskParent,
    routineTitle: clean(proposed.routineTitle) || current.routineTitle,
    routineTrigger: clean(proposed.routineTrigger) || current.routineTrigger,
    routinePlace: clean(proposed.routinePlace) || current.routinePlace,
    routineSteps: clean(proposed.routineSteps) || current.routineSteps,
    routineCadence: asRoutineCadence(proposed.routineCadence) ?? current.routineCadence,
  };
  if (mode === "project") {
    plan.objectiveTitle = "";
    plan.keyResults = [];
    plan.targetInitiatives = [];
    plan.unassignedInitiatives = [];
    plan.routineTitle = "";
    plan.routineTrigger = "";
    plan.routinePlace = "";
    plan.routineSteps = "";
    plan.routineCadence = "daily";
    plan.taskParent = plan.tasks ? "project" : "";
  }
  if (mode === "routine") {
    plan.objectiveTitle = "";
    plan.keyResults = [];
    plan.targetInitiatives = [];
    plan.unassignedInitiatives = [];
    plan.project = "";
    plan.taskParent = plan.tasks ? "routine" : "";
  }
  if (mode === "task") {
    plan.objectiveTitle = "";
    plan.keyResults = [];
    plan.targetInitiatives = [];
    plan.unassignedInitiatives = [];
    plan.project = "";
    plan.taskParent = "";
    plan.routineTitle = "";
    plan.routineTrigger = "";
    plan.routinePlace = "";
    plan.routineSteps = "";
    plan.routineCadence = "daily";
  }
  if (mode === "okr" || mode === "onboarding") {
    plan.project = "";
    plan.tasks = "";
    plan.taskParent = "";
    plan.routineTitle = "";
    plan.routineTrigger = "";
    plan.routinePlace = "";
    plan.routineSteps = "";
    plan.routineCadence = "daily";
  }
  if (mode === "coach") {
    plan.tasks = "";
    plan.taskParent = "";
    plan.routineTitle = "";
    plan.routineTrigger = "";
    plan.routinePlace = "";
    plan.routineSteps = "";
    plan.routineCadence = "daily";
    if (targetKind !== "initiative") plan.project = "";
  }
  if (plan.taskParent !== "project" && plan.taskParent !== "routine") plan.taskParent = "";
  if (plan.taskParent === "project" && !plan.project) plan.taskParent = plan.routineTitle ? "routine" : "";
  if (plan.taskParent === "routine" && !plan.routineTitle) plan.taskParent = plan.project ? "project" : "";
  if (!plan.taskParent && plan.tasks) plan.taskParent = plan.routineTitle && !plan.project ? "routine" : plan.project ? "project" : "";
  return {
    assistantMessage: clean(value.assistantMessage) || (mode === "project" ? "말씀하신 내용을 Project 초안으로 정리했습니다." : mode === "routine" ? "말씀하신 내용을 Routine 초안으로 정리했습니다." : mode === "task" ? "말씀하신 내용을 Task 초안으로 정리했습니다." : "말씀하신 내용을 OKR 초안으로 정리했습니다."),
    questions: Array.isArray(value.questions) ? value.questions.map(clean).filter(Boolean).slice(0, 3) : [],
    plan,
  };
}

function emptyPlan(): OrganizedPlan {
  return {
    objectiveTitle: "",
    keyResults: [],
    targetInitiatives: [],
    unassignedInitiatives: [],
    project: "",
    tasks: "",
    taskParent: "",
    routineTitle: "",
    routineTrigger: "",
    routinePlace: "",
    routineSteps: "",
    routineCadence: "daily",
  };
}

function sanitizeCurrentPlan(value: unknown, targetKind?: string): OrganizedPlan {
  if (!value || typeof value !== "object") return emptyPlan();
  const record = value as Record<string, unknown>;
  const plan = emptyPlan();
  plan.objectiveTitle = clean(record.objectiveTitle) || clean(record.objective);
  plan.keyResults = sanitizeKeyResults(record.keyResults);
  plan.targetInitiatives = sanitizeInitiatives(record.targetInitiatives);
  plan.unassignedInitiatives = sanitizeInitiatives(record.unassignedInitiatives);
  plan.project = clean(record.project);
  plan.tasks = clean(record.tasks);
  plan.taskParent = clean(record.taskParent);
  plan.routineTitle = clean(record.routineTitle);
  plan.routineTrigger = clean(record.routineTrigger);
  plan.routinePlace = clean(record.routinePlace);
  plan.routineSteps = clean(record.routineSteps);
  plan.routineCadence = asRoutineCadence(record.routineCadence) ?? "daily";

  const legacyKeyResult = clean(record.keyResult);
  const legacyInitiative = clean(record.initiative);
  if (!plan.keyResults.length && legacyKeyResult && targetKind !== "key_result") {
    plan.keyResults = [{ clientId: draftId("kr"), title: legacyKeyResult, initiatives: legacyInitiative ? [{ clientId: draftId("initiative"), title: legacyInitiative }] : [] }];
  } else if (!plan.targetInitiatives.length && legacyInitiative && targetKind === "key_result") {
    plan.targetInitiatives = [{ clientId: draftId("initiative"), title: legacyInitiative }];
  }
  return plan;
}

function sanitizeKeyResults(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const title = clean(record.title).slice(0, 500);
    if (!title) return [];
    return [{
      clientId: clean(record.clientId).slice(0, 100) || draftId("kr"),
      title,
      initiatives: sanitizeInitiatives(record.initiatives),
    }];
  });
}

function sanitizeInitiatives(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const title = clean(record.title).slice(0, 500);
    if (!title) return [];
    return [{ clientId: clean(record.clientId).slice(0, 100) || draftId("initiative"), title }];
  });
}

function mergeOkrTree(current: OrganizedPlan, proposed: OrganizedPlan, mode: ConversationMode, targetKind?: string) {
  if (mode === "project" || mode === "routine" || mode === "task" || targetKind === "initiative") {
    return { objectiveTitle: "", keyResults: [], targetInitiatives: [], unassignedInitiatives: [] };
  }

  const currentKeyResults = sanitizeKeyResults(current.keyResults);
  const currentTargetInitiatives = sanitizeInitiatives(current.targetInitiatives);
  const currentUnassigned = sanitizeInitiatives(current.unassignedInitiatives);
  const knownKeyResults = new Map(currentKeyResults.map((entry) => [entry.clientId, entry]));
  const knownInitiatives = new Map([
    ...currentKeyResults.flatMap((entry) => entry.initiatives),
    ...currentTargetInitiatives,
    ...currentUnassigned,
  ].map((entry) => [entry.clientId, entry]));
  const knownKeyResultsByTitle = indexByTitle(currentKeyResults);
  const knownInitiativesByTitle = indexByTitle([...knownInitiatives.values()]);
  const initiativeParentIds = new Map(
    currentKeyResults.flatMap((keyResult) => keyResult.initiatives.map((initiative) => [initiative.clientId, keyResult.clientId] as const)),
  );
  const rawKeyResults = Array.isArray(proposed.keyResults) ? proposed.keyResults : [];
  const rawTargetInitiatives = Array.isArray(proposed.targetInitiatives) ? proposed.targetInitiatives : [];
  const rawUnassigned = Array.isArray(proposed.unassignedInitiatives) ? proposed.unassignedInitiatives : [];
  const resolveKnownInitiative = (entry: DraftInitiative) => {
    const requestedId = clean(entry?.clientId);
    if (knownInitiatives.has(requestedId)) return knownInitiatives.get(requestedId);
    return uniqueTitleMatch(knownInitiativesByTitle, entry?.title);
  };
  const resolveKnownKeyResult = (entry: DraftKeyResult) => {
    const requestedId = clean(entry?.clientId);
    if (knownKeyResults.has(requestedId)) return knownKeyResults.get(requestedId);

    const titleMatch = uniqueTitleMatch(knownKeyResultsByTitle, entry?.title);
    if (titleMatch) return titleMatch;

    const parentIds = new Set(
      (Array.isArray(entry?.initiatives) ? entry.initiatives : [])
        .map(resolveKnownInitiative)
        .map((initiative) => initiative ? initiativeParentIds.get(initiative.clientId) : undefined)
        .filter((parentId): parentId is string => Boolean(parentId)),
    );
    return parentIds.size === 1 ? knownKeyResults.get([...parentIds][0]) : undefined;
  };
  const proposedInitiativeIds = new Set<string>();
  for (const entry of [...rawKeyResults.flatMap((keyResult) => Array.isArray(keyResult?.initiatives) ? keyResult.initiatives : []), ...rawTargetInitiatives, ...rawUnassigned]) {
    const known = resolveKnownInitiative(entry);
    if (known) proposedInitiativeIds.add(known.clientId);
  }
  const usedIds = new Set<string>();

  const normalizeInitiative = (entry: DraftInitiative) => {
    const known = resolveKnownInitiative(entry);
    if (known && usedIds.has(known.clientId)) return [];
    const clientId = known?.clientId ?? draftId("initiative");
    usedIds.add(clientId);
    const title = clean(entry?.title).slice(0, 500) || known?.title || "";
    return title ? [{ clientId, title }] : [];
  };

  const keyResults: DraftKeyResult[] = [];
  for (const entry of rawKeyResults.slice(0, 20)) {
    const known = resolveKnownKeyResult(entry);
    if (known && usedIds.has(known.clientId)) continue;
    const clientId = known?.clientId ?? draftId("kr");
    usedIds.add(clientId);
    const proposedInitiatives = (Array.isArray(entry?.initiatives) ? entry.initiatives : []).slice(0, 30).flatMap(normalizeInitiative);
    const retainedInitiatives = (known?.initiatives ?? []).filter((initiative) => !proposedInitiativeIds.has(initiative.clientId) && !usedIds.has(initiative.clientId));
    retainedInitiatives.forEach((initiative) => usedIds.add(initiative.clientId));
    const title = clean(entry?.title).slice(0, 500) || known?.title || "";
    if (!title) continue;
    const duplicate = keyResults.find((candidate) => !known && titleKey(candidate.title) === titleKey(title));
    if (duplicate) {
      duplicate.initiatives = dedupeInitiatives([...duplicate.initiatives, ...proposedInitiatives, ...retainedInitiatives]);
      continue;
    }
    keyResults.push({ clientId, title, initiatives: dedupeInitiatives([...proposedInitiatives, ...retainedInitiatives]) });
  }
  for (const existing of currentKeyResults) {
    if (keyResults.some((entry) => entry.clientId === existing.clientId)) continue;
    keyResults.push({
      ...existing,
      initiatives: existing.initiatives.filter((initiative) => !proposedInitiativeIds.has(initiative.clientId)),
    });
  }

  const targetInitiatives = mergeInitiativeList(rawTargetInitiatives, currentTargetInitiatives, proposedInitiativeIds, usedIds, normalizeInitiative);
  const unassignedInitiatives = mergeInitiativeList(rawUnassigned, currentUnassigned, proposedInitiativeIds, usedIds, normalizeInitiative);
  return {
    objectiveTitle: targetKind ? "" : clean(proposed.objectiveTitle).slice(0, 500) || current.objectiveTitle,
    keyResults: targetKind === "key_result" ? [] : keyResults,
    targetInitiatives: targetKind === "key_result" ? targetInitiatives : [],
    unassignedInitiatives: targetKind === "key_result" ? [] : unassignedInitiatives,
  };
}

function mergeInitiativeList(
  proposed: DraftInitiative[],
  current: DraftInitiative[],
  proposedIds: Set<string>,
  usedIds: Set<string>,
  normalize: (entry: DraftInitiative) => DraftInitiative[],
) {
  const merged = proposed.slice(0, 30).flatMap(normalize);
  for (const existing of current) {
    if (proposedIds.has(existing.clientId) || usedIds.has(existing.clientId)) continue;
    usedIds.add(existing.clientId);
    merged.push(existing);
  }
  return dedupeInitiatives(merged);
}

function dedupeInitiatives(value: DraftInitiative[]) {
  const seen = new Set<string>();
  return value.filter((entry) => {
    const key = titleKey(entry.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function indexByTitle<T extends { title: string }>(entries: T[]) {
  const index = new Map<string, T[]>();
  for (const entry of entries) {
    const key = titleKey(entry.title);
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), entry]);
  }
  return index;
}

function uniqueTitleMatch<T extends { title: string }>(index: Map<string, T[]>, value: unknown) {
  const matches = index.get(titleKey(clean(value))) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function titleKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function draftId(kind: "kr" | "initiative") {
  return `draft-${kind}-${crypto.randomUUID()}`;
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asRoutineCadence(value: unknown): OrganizedPlan["routineCadence"] | null {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : null;
}
