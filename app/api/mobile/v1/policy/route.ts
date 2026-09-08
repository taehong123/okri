import releases from "@/lib/mobile/releases.json";
import { publicPolicy, type ReleaseRegistry } from "@/lib/mobile/release-policy";

export async function GET(request: Request) {
  const platform = new URL(request.url).searchParams.get("platform");
  const headers = { "Cache-Control": "no-store", "X-OKRI-API-Version": "1" };
  if (platform !== "android" && platform !== "ios") return Response.json({ code: "invalid_platform" }, { status: 400, headers });
  try { return Response.json(publicPolicy(releases as ReleaseRegistry, platform), { headers }); }
  catch { return Response.json({ code: "policy_unavailable" }, { status: 503, headers }); }
}
