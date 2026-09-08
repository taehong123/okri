import type { Session } from "./types";
import { clientHeaders } from "./client-version";

export const ORIGIN = "https://okri.ai";
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function request<T>(path: string, session: Session | null, workspace: string | null, language: string, init: RequestInit = {}): Promise<T> {
  if (!/^\/api\/(?:mobile\/v1\/|native\/)[a-z/-]+(?:\?[^#]*)?$/.test(path)) throw new Error("Invalid API path");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 20000);
  try {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(clientHeaders())) headers.set(key, value);
    headers.set("Accept", "application/json");
    headers.set("Accept-Language", language);
    if (init.body) headers.set("Content-Type", "application/json");
    if (session) headers.set("Authorization", "Bearer " + session.accessToken);
    if (workspace) headers.set("x-okri-workspace-id", workspace);
    const response = await fetch(ORIGIN + path, { ...init, credentials: "omit", redirect: "error", headers, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data?.code || "", data?.error || "Unable to complete request");
    return data as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
