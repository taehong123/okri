/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { syncDueKrDataConnectionsWithDb } from "@/lib/kr-data-sync";
import { runDueWorkspaceBackups } from "@/lib/workspace-backups";
import { workspaceSubdomainRedirect } from "@/lib/workspace-address";
import { withPublicErrorDetails } from "@/lib/api-error";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  WORKSPACE_AVATARS: R2Bucket;
  WORKSPACE_SUBDOMAINS_ENABLED?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const STATIC_PAGE_PATHS = new Set(["/privacy", "/terms"]);
const STATIC_PAGE_BROWSER_CACHE = "public, max-age=300, stale-while-revalidate=86400";
const STATIC_PAGE_EDGE_CACHE = "public, max-age=31536000, stale-while-revalidate=86400";
const APP_SHELL_BROWSER_CACHE = "no-cache, must-revalidate";
const APP_SHELL_EDGE_CACHE = "no-cache, must-revalidate";
const HASHED_ASSET_CACHE = "public, max-age=31536000, immutable";
const FAVICON_BROWSER_CACHE = "public, max-age=86400";
const SERVICE_WORKER_CACHE = "no-cache";

function isCacheableAssetPath(pathname: string) {
  return pathname === "/"
    || STATIC_PAGE_PATHS.has(pathname)
    || pathname.startsWith("/_next/static/")
    || pathname === "/favicon.svg"
    || pathname === "/sw.js";
}

function withCacheHeaders(request: Request, response: Response, pathname: string) {
  const headers = new Headers(response.headers);
  if (pathname.startsWith("/_next/static/")) {
    headers.set("Cache-Control", HASHED_ASSET_CACHE);
    headers.set("Cloudflare-CDN-Cache-Control", HASHED_ASSET_CACHE);
  } else if (pathname === "/") {
    headers.set("Cache-Control", APP_SHELL_BROWSER_CACHE);
    headers.set("Cloudflare-CDN-Cache-Control", APP_SHELL_EDGE_CACHE);
  } else if (pathname === "/sw.js") {
    headers.set("Cache-Control", SERVICE_WORKER_CACHE);
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.set("Service-Worker-Allowed", "/");
  } else {
    headers.set("Cache-Control", pathname === "/favicon.svg" ? FAVICON_BROWSER_CACHE : STATIC_PAGE_BROWSER_CACHE);
    headers.set("Cloudflare-CDN-Cache-Control", STATIC_PAGE_EDGE_CACHE);
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const workspaceEntry = workspaceSubdomainRedirect(request, env.WORKSPACE_SUBDOMAINS_ENABLED === "true");
    if (workspaceEntry) return workspaceEntry;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const cacheableRequest = (request.method === "GET" || request.method === "HEAD") && isCacheableAssetPath(url.pathname);
    if (cacheableRequest && env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.ok) return withCacheHeaders(request, assetResponse, url.pathname);
    }

    const response = await handler.fetch(request, env, ctx);
    if (response.ok && !["GET", "HEAD", "OPTIONS"].includes(request.method) && (url.pathname.startsWith("/api/") || url.pathname === "/mcp")) {
      ctx.waitUntil(import("@/lib/slack-task-changes").then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB)));
    }
    if (cacheableRequest && response.ok) return withCacheHeaders(request, response, url.pathname);
    if (url.pathname.startsWith("/api/") && !response.ok) return withPublicErrorDetails(response);
    return response;
  },
  scheduled(_controller: ScheduledController, _env: Env, ctx: ExecutionContext) {
    // Delivery queues resume every minute; existing maintenance keeps its 15-minute cadence.
    ctx.waitUntil(import("@/lib/slack-bot-delivery").then(({ runDueSlackBotDeliveries }) => runDueSlackBotDeliveries(_env.DB)));
    ctx.waitUntil(import("@/lib/slack-task-changes").then(({ runDueTaskChanges }) => runDueTaskChanges(_env.DB)));
    ctx.waitUntil(import("@/lib/slack-daily-manual").then(({ runDueDailyManualRuns }) => runDueDailyManualRuns(_env.DB)));
    if (new Date(_controller.scheduledTime).getUTCMinutes() % 15 !== 0) return;
    ctx.waitUntil(import("@/lib/billing").then(({ runBillingBatch }) => runBillingBatch()));
    const managementBotRun = import("@/lib/workspace-management-bot")
      .then(({ runDueWorkspaceManagementBots }) => runDueWorkspaceManagementBots(_env.DB));
    ctx.waitUntil(Promise.all([
      syncDueKrDataConnectionsWithDb(_env.DB),
      managementBotRun,
    ]));
    // Keep backups alive even if an unrelated integration job rejects.
    ctx.waitUntil(runDueWorkspaceBackups(_env));
    ctx.waitUntil(import("@/lib/slack-daily").then(({ runDueSlackDailyReminders }) => runDueSlackDailyReminders()));
  },
};

export default worker;
