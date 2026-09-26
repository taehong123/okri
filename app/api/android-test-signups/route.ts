import { env } from "cloudflare:workers";
import { encryptPrivateValue } from "@/lib/secret-crypto";
import { createAndroidTestAccess, parseAndroidTestSignup, phoneLastFour, saveAndroidTestSignup, AndroidTestSignupError, type AndroidTestDatabase } from "@/lib/android-test-signup";

type AndroidTestRuntime = { DB: AndroidTestDatabase; ACCOUNT_DATA_ENCRYPTION_KEY?: string };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ code: "invalid_request" }, { status: 403, headers: noStore });
  const payload = await readJson(request);
  if (!payload) return Response.json({ code: "invalid_request" }, { status: 400, headers: noStore });
  try {
    const signup = parseAndroidTestSignup(payload);
    // Quietly accept bot submissions without storing them or revealing the honeypot.
    if (signup.website) return Response.json({ ok: true }, { status: 201, headers: noStore });
    const runtime = env as unknown as AndroidTestRuntime;
    if (!runtime.ACCOUNT_DATA_ENCRYPTION_KEY) return Response.json({ code: "storage_unavailable" }, { status: 503, headers: noStore });
    const access = await createAndroidTestAccess();
    await saveAndroidTestSignup(runtime.DB, {
      ...signup,
      encryptedPhone: await encryptPrivateValue(signup.phone, runtime.ACCOUNT_DATA_ENCRYPTION_KEY),
      phoneLastFour: phoneLastFour(signup.phone),
      accessTokenHash: access.hash,
    });
    return Response.json({ ok: true, access: access.token }, { status: 201, headers: noStore });
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
