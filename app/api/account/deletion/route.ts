import { env } from "cloudflare:workers";
import { clearGoogleSessionCookies, readGoogleSession } from "@/lib/google-session";
import { authorizeRequest, deleteNativeUserAccount } from "@/lib/pace-data";

const RECENT_AUTH_SECONDS = 15 * 60;
const supportedLanguages = new Set(["ko", "en", "ja", "zh", "es"]);

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const contentType = request.headers.get("content-type") ?? "";
  const input = contentType.includes("application/json")
    ? await request.json().catch(() => null) as Record<string, unknown> | null
    : Object.fromEntries(await request.formData().catch(() => new FormData()));
  const language = supportedLanguages.has(String(input?.language)) ? String(input?.language) : "en";
  const destination = new URL("/account-deletion", request.url);
  destination.searchParams.set("lang", language);

  if (request.headers.get("origin") !== requestUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return redirect(destination, "invalid_request");
  }
  if (input?.confirmation !== "DELETE" || input?.understood !== "yes") return redirect(destination, "confirmation");

  const secret = (env as { GOOGLE_TOKEN_ENCRYPTION_KEY?: string }).GOOGLE_TOKEN_ENCRYPTION_KEY;
  const session = await readGoogleSession(request, secret);
  const now = Math.floor(Date.now() / 1000);
  if (!session?.issuedAt || now - session.issuedAt > RECENT_AUTH_SECONDS) return redirect(destination, "reauth");

  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response || authorization.apiToken) return redirect(destination, "reauth");
  try {
    await deleteNativeUserAccount(authorization.userId);
    destination.searchParams.set("deleted", "1");
    const headers = new Headers({ Location: destination.toString(), "Cache-Control": "no-store" });
    clearGoogleSessionCookies().forEach((cookie) => headers.append("Set-Cookie", cookie));
    headers.append("Set-Cookie", "okri_workspace_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 303, headers });
  } catch (error) {
    return redirect(destination, error instanceof Error && error.message === "transfer_workspace_ownership" ? "ownership" : "unavailable");
  }
}

function redirect(destination: URL, error: string) {
  destination.searchParams.set("error", error);
  return new Response(null, { status: 303, headers: { Location: destination.toString(), "Cache-Control": "no-store" } });
}
