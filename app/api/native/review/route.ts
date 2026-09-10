import { env } from "cloudflare:workers";
import { authenticateNativeReviewer, reviewAccessConfigured, type NativeReviewEnv } from "@/lib/native-review";

const runtime = () => env as unknown as NativeReviewEnv;
const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

export async function GET() {
  return Response.json({ enabled: reviewAccessConfigured(runtime()) }, { headers: noStore });
}

export async function POST(request: Request) {
  if (!reviewAccessConfigured(runtime())) return Response.json({ error: "Not found" }, { status: 404, headers: noStore });
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) return Response.json({ error: "Invalid credentials" }, { status: 400, headers: noStore });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.username !== "string" || typeof body?.password !== "string") {
    return Response.json({ error: "Invalid credentials" }, { status: 400, headers: noStore });
  }
  const session = await authenticateNativeReviewer(runtime(), body.username, body.password);
  return Response.json(session ?? { error: "Invalid credentials" }, { status: session ? 200 : 401, headers: noStore });
}
