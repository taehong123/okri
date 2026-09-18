import { env } from "cloudflare:workers";
import { ensureRuntimeSchema } from "@/lib/pace-data";

/** Lightweight readiness endpoint; it never exposes workspace or integration data. */
export async function GET() {
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    await ensureRuntimeSchema();
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
