import { env } from "cloudflare:workers";
import { deliverStoreReviewEvent, parseGooglePlayEmail, verifyStoreWebhookSignature, type StoreReviewRuntime } from "@/lib/store-review-feedback";

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 64 * 1024) return Response.json({ error: "Payload too large" }, { status: 413 });
  const runtime = env as unknown as StoreReviewRuntime & { GOOGLE_PLAY_FEEDBACK_SECRET?: string };
  if (!await verifyStoreWebhookSignature(rawBody, request.headers.get("x-okri-store-signature"), runtime.GOOGLE_PLAY_FEEDBACK_SECRET)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  const payload = await parseJson(rawBody);
  if (!payload) return Response.json({ error: "Invalid JSON" }, { status: 400 });
  const event = parseGooglePlayEmail(payload);
  if (!event) return Response.json({ error: "Invalid event" }, { status: 400 });
  try { return Response.json({ status: await deliverStoreReviewEvent(runtime, event) }); }
  catch { return Response.json({ error: "Delivery unavailable" }, { status: 503 }); }
}

async function parseJson(value: string) { try { return JSON.parse(value) as unknown; } catch { return null; } }
