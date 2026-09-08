import { env } from "cloudflare:workers";
import { deleteNativeUserAccount } from "@/lib/pace-data";
import { readNativeIdentity } from "@/lib/native-session";
export async function DELETE(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const user = await readNativeIdentity(env.DB, token);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (Date.parse(user.createdAt) < Date.now() - 15 * 60000) return Response.json({ error: "Sign in again before deleting your account.", code: "reauthentication_required" }, { status: 403 });
  const body = await request.json().catch(() => null) as { confirmation?: string } | null;
  if (body?.confirmation !== "DELETE") return Response.json({ error: "Deletion confirmation required" }, { status: 400 });
  try {
    await deleteNativeUserAccount(user.id);
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const transfer = error instanceof Error && error.message === "transfer_workspace_ownership";
    return Response.json({ error: transfer ? "Transfer ownership of shared workspaces first." : "Deletion could not be completed. Please retry.", code: transfer ? "transfer_workspace_ownership" : "deletion_failed" }, { status: transfer ? 409 : 503 });
  }
}
