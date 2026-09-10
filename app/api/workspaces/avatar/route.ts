import { env } from "cloudflare:workers";
import {
  authorizeRequest,
  clearWorkspaceAvatar,
  countAiUsageEvents,
  finalizeAiUsageEvent,
  getAiUsageSummary,
  getManageableWorkspaceForAvatar,
  getWorkspaceAvatarForUser,
  releaseAiUsageReservation,
  reserveAiUsageEvent,
  saveWorkspaceAvatar,
  type RequestAuthorization,
} from "@/lib/pace-data";
import { BillingLimitError, assertAiBudget } from "@/lib/billing";

type AvatarRuntimeEnv = typeof env & {
  WORKSPACE_AVATARS?: R2Bucket;
  OPENAI_API_KEY?: string;
  OKRI_WORKSPACE_AVATAR_MODEL?: string;
  OKRPTR_WORKSPACE_AVATAR_MODEL?: string;
  OKRI_AI_FREE_BUDGET_WON?: string;
  OKRPTR_AI_FREE_BUDGET_WON?: string;
  OKRI_AI_MAX_REQUESTS_PER_MINUTE?: string;
  OKRPTR_AI_MAX_REQUESTS_PER_MINUTE?: string;
  OKRI_AI_MAX_REQUESTS_PER_DAY?: string;
  OKRPTR_AI_MAX_REQUESTS_PER_DAY?: string;
  OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE?: string;
  OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE?: string;
  OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_DAY?: string;
  OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_DAY?: string;
  OKRI_AI_MAX_IMAGE_REQUESTS_PER_DAY?: string;
  OKRPTR_AI_MAX_IMAGE_REQUESTS_PER_DAY?: string;
  OKRI_AI_IMAGE_COST_WON?: string;
  OKRPTR_AI_IMAGE_COST_WON?: string;
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const AVATAR_SOURCE = "workspace_avatar";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
    const workspace = await getWorkspaceAvatarForUser(authorization, workspaceId);
    if (!workspace.avatarKey) return Response.json({ error: "Workspace image not found" }, { status: 404 });
    const bucket = avatarBucket();
    const object = await bucket.get(workspace.avatarKey);
    if (!object) return Response.json({ error: "Workspace image not found" }, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", headers.get("Content-Type") || "image/webp");
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  } catch (error) {
    return avatarError(error);
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const workspace = await getManageableWorkspaceForAvatar(authorization);
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) return Response.json({ error: "Image file is required" }, { status: 400 });
    if (!file.size || file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "Image must be 5 MB or smaller" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = verifiedImageType(bytes);
    if (!contentType) return Response.json({ error: "Only PNG, JPEG, and WebP images are supported" }, { status: 400 });
    return Response.json(await replaceWorkspaceAvatar(authorization, workspace.id, bytes, contentType));
  } catch (error) {
    return avatarError(error);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const runtime = env as AvatarRuntimeEnv;
    const workspace = await getManageableWorkspaceForAvatar(authorization);
    avatarBucket();
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const prompt = typeof payload.prompt === "string" ? payload.prompt.trim().slice(0, 240) : "";
    const limit = await checkImageUsageLimit(runtime, authorization);
    if (limit instanceof Response) return limit;
    const apiKey = runtime.OPENAI_API_KEY?.trim();
    if (!apiKey) return Response.json({ error: "AI image generation is not configured" }, { status: 503 });

    const model = runtime.OKRI_WORKSPACE_AVATAR_MODEL?.trim() || runtime.OKRPTR_WORKSPACE_AVATAR_MODEL?.trim() || "gpt-image-2";
    const imagePrompt = [
      `Create a polished square team workspace avatar for a productivity app. Workspace name: ${workspace.name}.`,
      prompt ? `Creative direction: ${prompt}.` : "Use a confident, friendly abstract symbol with a distinctive color palette.",
      "No words, letters, numbers, trademarks, UI mockups, borders, or photorealistic people. Center the subject and keep it legible at 32 pixels.",
    ].join(" ");
    const reservationId = await reserveAiUsageEvent({
      ownerId: authorization.ownerId,
      userId: authorization.userId,
      model,
      source: AVATAR_SOURCE,
      inputChars: imagePrompt.length,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostWonMicros: limit.reservedCostWonMicros,
      limits: limit.rateLimits,
    });
    if (!reservationId) return Response.json({ error: "AI 요청이 너무 빠르게 반복되고 있습니다. 잠시 후 다시 시도해 주세요." }, { status: 429 });
    let finalized = false;
    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: imagePrompt,
          n: 1,
          size: "1024x1024",
          quality: "low",
          output_format: "webp",
          background: "opaque",
          moderation: "auto",
        }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const providerMessage = openAiErrorMessage(data);
        return Response.json({ error: providerMessage || "AI image generation failed" }, { status: response.status === 429 ? 429 : 502 });
      }
      const encoded = generatedBase64(data);
      if (!encoded) return Response.json({ error: "AI image response was empty" }, { status: 502 });
      const bytes = decodeBase64(encoded);
      if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || verifiedImageType(bytes) !== "image/webp") {
        return Response.json({ error: "AI returned an invalid image" }, { status: 502 });
      }
      const usage = imageUsage(data);
      await finalizeAiUsageEvent(reservationId, {
        ownerId: authorization.ownerId,
        userId: authorization.userId,
        model,
        source: AVATAR_SOURCE,
        inputChars: imagePrompt.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostWonMicros: imageCostWonMicros(runtime),
      });
      finalized = true;
      const avatar = await replaceWorkspaceAvatar(authorization, workspace.id, bytes, "image/webp");
      return Response.json({ ...avatar, revisedPrompt: typeof data.revised_prompt === "string" ? data.revised_prompt : null });
    } finally {
      if (!finalized) await releaseAiUsageReservation(reservationId);
    }
  } catch (error) {
    return avatarError(error);
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const bucket = avatarBucket();
    const result = await clearWorkspaceAvatar(authorization);
    if (result.previousAvatarKey) await bucket.delete(result.previousAvatarKey);
    return Response.json({ avatarUrl: null, avatarUpdatedAt: result.avatarUpdatedAt });
  } catch (error) {
    return avatarError(error);
  }
}

async function replaceWorkspaceAvatar(
  authorization: RequestAuthorization,
  workspaceId: string,
  bytes: Uint8Array,
  contentType: "image/png" | "image/jpeg" | "image/webp",
) {
  const bucket = avatarBucket();
  const extension = contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "webp";
  const key = `workspace-avatars/${workspaceId}/${crypto.randomUUID()}.${extension}`;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { workspaceId },
  });
  try {
    const result = await saveWorkspaceAvatar(authorization, key);
    if (result.previousAvatarKey && result.previousAvatarKey !== key) await bucket.delete(result.previousAvatarKey);
    return { avatarUrl: result.avatarUrl, avatarUpdatedAt: result.avatarUpdatedAt };
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
}

function avatarBucket() {
  const bucket = (env as AvatarRuntimeEnv).WORKSPACE_AVATARS;
  if (!bucket) throw new Error("Workspace image storage is not configured");
  return bucket;
}

function verifiedImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function generatedBase64(data: Record<string, unknown>) {
  const images = Array.isArray(data.data) ? data.data : [];
  const first = images[0];
  if (!first || typeof first !== "object") return "";
  const value = (first as Record<string, unknown>).b64_json;
  return typeof value === "string" ? value : "";
}

function decodeBase64(value: string) {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function openAiErrorMessage(data: Record<string, unknown>) {
  const error = data.error;
  if (!error || typeof error !== "object") return "";
  const message = (error as Record<string, unknown>).message;
  if (typeof message !== "string") return "";
  if (/moderation|safety|policy/i.test(message)) return "이미지 설명을 조금 다르게 바꿔 다시 시도해 주세요.";
  return "AI 이미지를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function imageUsage(data: Record<string, unknown>) {
  const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : {};
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

async function checkImageUsageLimit(runtime: AvatarRuntimeEnv, authorization: RequestAuthorization) {
  const summary = await getAiUsageSummary(authorization.ownerId, authorization.userId);
  const minuteLimit = positiveNumber(runtime.OKRI_AI_MAX_REQUESTS_PER_MINUTE ?? runtime.OKRPTR_AI_MAX_REQUESTS_PER_MINUTE, 5);
  const dayLimit = positiveNumber(runtime.OKRI_AI_MAX_REQUESTS_PER_DAY ?? runtime.OKRPTR_AI_MAX_REQUESTS_PER_DAY, 40);
  const workspaceMinuteLimit = Math.max(minuteLimit, positiveNumber(runtime.OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE ?? runtime.OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_MINUTE, 12));
  if (summary.requestsThisMinute >= minuteLimit || (summary.workspaceRequestsThisMinute ?? 0) >= workspaceMinuteLimit) {
    return Response.json({ error: "AI 요청이 너무 빠르게 반복되고 있습니다. 잠시 후 다시 시도해 주세요." }, { status: 429 });
  }
  const workspaceDayLimit = Math.max(
    dayLimit,
    positiveNumber(runtime.OKRI_AI_MAX_WORKSPACE_REQUESTS_PER_DAY ?? runtime.OKRPTR_AI_MAX_WORKSPACE_REQUESTS_PER_DAY, 120),
  );
  if ((summary.workspaceRequestsToday ?? 0) >= workspaceDayLimit) {
    return Response.json({ error: "오늘의 워크스페이스 AI 사용 한도를 모두 사용했습니다." }, { status: 429 });
  }
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const imageRequestsToday = await countAiUsageEvents(authorization.ownerId, authorization.userId, AVATAR_SOURCE, dayStart.toISOString());
  if (imageRequestsToday >= positiveNumber(runtime.OKRI_AI_MAX_IMAGE_REQUESTS_PER_DAY ?? runtime.OKRPTR_AI_MAX_IMAGE_REQUESTS_PER_DAY, 5)) {
    return Response.json({ error: "오늘의 워크스페이스 이미지 생성 횟수를 모두 사용했습니다." }, { status: 429 });
  }
  try {
    const planBudget = await assertAiBudget(authorization.ownerId, authorization.userId);
    if (planBudget.limitWon !== null && planBudget.spentWonMicros + imageCostWonMicros(runtime) > planBudget.limitWon * 1_000_000) {
      return Response.json({ error: "이번 달 AI 안전 한도에 도달했습니다.", code: "ai_budget_exceeded", resetsAt: planBudget.resetsAt }, { status: 402 });
    }
  } catch (error) {
    if (error instanceof BillingLimitError) return Response.json({ error: error.message, code: error.code, ...error.details }, { status: 402 });
    throw error;
  }
  return {
    reservedCostWonMicros: imageCostWonMicros(runtime),
    rateLimits: {
      userMinute: minuteLimit,
      userDay: dayLimit,
      workspaceMinute: workspaceMinuteLimit,
      workspaceDay: workspaceDayLimit,
    },
  };
}

function imageCostWonMicros(runtime: AvatarRuntimeEnv) {
  return positiveNumber(runtime.OKRI_AI_IMAGE_COST_WON ?? runtime.OKRPTR_AI_IMAGE_COST_WON, 15) * 1_000_000;
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function avatarError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status = /Owner|Admin|Personal|access denied/i.test(message)
    ? 403
    : /required|supported|5 MB|scheduled|not found/i.test(message)
      ? 400
      : /not configured/i.test(message)
        ? 503
        : 500;
  return Response.json({ error: message }, { status });
}
