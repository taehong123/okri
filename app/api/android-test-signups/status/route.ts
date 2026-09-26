import { env } from "cloudflare:workers";
import { createAndroidTestFeedback, type AndroidTestFeedbackRuntime } from "@/lib/android-test-feedback";
import { findAndroidTestPortal, parseAndroidTestFeedback, AndroidTestSignupError, type AndroidTestDatabase } from "@/lib/android-test-signup";

type AndroidTestRuntime = AndroidTestFeedbackRuntime & { DB: AndroidTestDatabase };

export async function GET(request: Request) {
  const access = new URL(request.url).searchParams.get("access") ?? "";
  const portal = await findAndroidTestPortal((env as unknown as AndroidTestRuntime).DB, access);
  if (!portal) return Response.json({ code: "not_found" }, { status: 404, headers: noStore });
  return Response.json({ portal }, { headers: noStore });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ code: "invalid_request" }, { status: 403, headers: noStore });
  const payload = await readJson(request);
  if (!payload) return Response.json({ code: "invalid_request" }, { status: 400, headers: noStore });
  try {
    const { access, message } = parseAndroidTestFeedback(payload);
    const runtime = env as unknown as AndroidTestRuntime;
    const portal = await findAndroidTestPortal(runtime.DB, access);
    if (!portal) return Response.json({ code: "not_found" }, { status: 404, headers: noStore });
    await createAndroidTestFeedback(runtime, portal.id, message);
    return Response.json({ ok: true }, { status: 201, headers: noStore });
  } catch (error) {
    const code = error instanceof AndroidTestSignupError ? error.code : "invalid_request";
    return Response.json({ code }, { status: 400, headers: noStore });
  }
}

const noStore = { "Cache-Control": "no-store" };

async function readJson(request: Request) {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 4_096) return null;
  try { return JSON.parse(body) as unknown; } catch { return null; }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
