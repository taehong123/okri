import { env } from "cloudflare:workers";
import {
  decryptSecret,
  encryptSecret,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleConfigured,
  googlePublicOrigin,
  type GoogleRuntimeEnv,
} from "@/lib/google-oauth";
import {
  clearGoogleSignInStateCookies,
  createGoogleSessionCookie,
  GOOGLE_SIGN_IN_STATE_OWNER,
  GOOGLE_SIGN_IN_STATE_PREFIX,
  GOOGLE_SIGN_IN_STATE_USER,
  readGoogleSignInState,
} from "@/lib/google-session";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const stateValue = requestUrl.searchParams.get("state") ?? "";
  const runtime = env as GoogleRuntimeEnv;
  const serverStateSignIn = stateValue.startsWith(GOOGLE_SIGN_IN_STATE_PREFIX);
  const signingIn = serverStateSignIn;
  const signInState = serverStateSignIn
    ? await readGoogleSignInState(request, stateValue, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY)
    : null;
  const savedState = signingIn ? null : await consumeStoredGoogleOAuthState(stateValue);
  const state = signInState
    ? { ownerId: GOOGLE_SIGN_IN_STATE_OWNER, userId: GOOGLE_SIGN_IN_STATE_USER, returnTo: signInState.returnTo }
    : savedState;
  const returnTo = state?.returnTo ?? "/";

  if (!state || requestUrl.searchParams.get("error")) {
    return signingIn ? redirectWithAuthStatus(request, returnTo, "failed", true) : redirectWithGoogleStatus(request, returnTo, "failed");
  }

  if (!googleConfigured(runtime)) {
    return signingIn ? redirectWithAuthStatus(request, returnTo, "missing_config", true) : redirectWithGoogleStatus(request, returnTo, "missing_config");
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) return signingIn ? redirectWithAuthStatus(request, returnTo, "failed", true) : redirectWithGoogleStatus(request, returnTo, "failed");

  try {
    const tokens = await exchangeGoogleCode(runtime, request, code);
    const profile = await fetchGoogleProfile(tokens.access_token);
    if (state.ownerId === GOOGLE_SIGN_IN_STATE_OWNER) {
      const headers = new Headers({
        Location: new URL(returnTo, googlePublicOrigin(request)).toString(),
        "Set-Cookie": await createGoogleSessionCookie(profile, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!),
      });
      appendGoogleSignInStateClearCookies(headers);
      return new Response(null, {
        status: 303,
        headers,
      });
    }
    const { getGoogleConnection, saveGoogleConnection } = await import("@/lib/pace-data");
    const existing = await getGoogleConnection(state.ownerId, state.userId);
    const refreshToken = tokens.refresh_token
      ?? (existing ? await decryptSecret(existing.encryptedRefreshToken, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!) : "");
    if (!refreshToken) return redirectWithGoogleStatus(request, returnTo, "no_refresh_token");

    await saveGoogleConnection({
      ownerId: state.ownerId,
      userId: state.userId,
      googleAccountId: profile.sub,
      email: profile.email,
      displayName: profile.name || profile.email,
      encryptedRefreshToken: await encryptSecret(refreshToken, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!),
      scope: tokens.scope ?? "",
    });
    return redirectWithGoogleStatus(request, returnTo, "connected");
  } catch {
    return signingIn ? redirectWithAuthStatus(request, returnTo, "failed", true) : redirectWithGoogleStatus(request, returnTo, "failed");
  }
}

function redirectWithAuthStatus(request: Request, returnTo: string, status: string, clearState = false) {
  const url = new URL(returnTo, googlePublicOrigin(request));
  url.searchParams.set("auth", status);
  const headers = new Headers({ Location: url.toString() });
  if (clearState) appendGoogleSignInStateClearCookies(headers);
  return new Response(null, { status: 303, headers });
}

async function consumeStoredGoogleOAuthState(state: string) {
  const { consumeGoogleOAuthState } = await import("@/lib/pace-data");
  return consumeGoogleOAuthState(state);
}

function appendGoogleSignInStateClearCookies(headers: Headers) {
  clearGoogleSignInStateCookies().forEach((cookie) => headers.append("Set-Cookie", cookie));
}

function redirectWithGoogleStatus(request: Request, returnTo: string, status: string) {
  const url = new URL(returnTo, googlePublicOrigin(request));
  url.searchParams.set("google", status);
  return Response.redirect(url.toString(), 303);
}
