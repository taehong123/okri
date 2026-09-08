import { env } from "cloudflare:workers";
import { readNativeIdentity, revokeNativeSession } from "@/lib/native-session";
export async function DELETE(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!(await readNativeIdentity(env.DB, token))) return Response.json({ error: "Authentication required" }, { status: 401 });
  await revokeNativeSession(env.DB, token);
  return Response.json({ signedOut: true }, { headers: { "Cache-Control": "no-store" } });
}
