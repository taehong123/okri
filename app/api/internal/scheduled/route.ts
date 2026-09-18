import { env } from "cloudflare:workers";
import { runScheduledJobs, type ScheduledRuntime } from "@/lib/scheduled-jobs";

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const results = await runScheduledJobs(env as ScheduledRuntime);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    console.error("scheduled_jobs_failed", JSON.stringify(failed));
    return Response.json({ status: "partial_failure", results }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ status: "ok", results }, { headers: { "Cache-Control": "no-store" } });
}

function authorized(request: Request) {
  const secret = env.OKRI_SCHEDULER_TOKEN?.trim();
  if (!secret) return false;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return constantTimeEqual(token, secret);
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}
