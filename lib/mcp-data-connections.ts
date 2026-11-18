import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDataConnection, getItem, listDataConnections, syncDataConnection, updateDataConnection, type DataConnectionSummary, type RequestAuthorization } from "./pace-data";
import { readKrSource, saveKrSource } from "./kr-data-sources";
import { normalizeEndpoint } from "./kr-data-sync";

const kind = z.enum(["key_result", "project"]);
const cadence = z.enum(["hourly", "daily", "weekly", "manual"]);
const itemId = z.string().trim().min(1).max(128);
export const dataConnectionUpsertInput = z.object({
  item_id: itemId, target_kind: kind.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  endpoint_url: z.string().trim().min(1).max(4000).optional().describe("Required for a new connection. Omit to retain the saved endpoint; never invent a URL."),
  value_path: z.string().trim().max(500).optional(),
  baseline_value: z.number().finite().optional(), target_value: z.number().finite().optional(),
  unit: z.string().trim().max(24).optional(), cadence: cadence.optional(), active: z.boolean().optional(),
});
type UpsertInput = z.infer<typeof dataConnectionUpsertInput>;
const connectionOutput = z.object({
  id: z.string(), itemId: z.string(), targetKind: kind, name: z.string(),
  endpointOrigin: z.string().nullable(), endpointConfigured: z.boolean(),
  valuePath: z.string(), baselineValue: z.number(), targetValue: z.number(), unit: z.string(),
  cadence, active: z.boolean(), sourceMode: z.enum(["api", "projects"]),
  lastValue: z.number().nullable(), lastSyncStatus: z.enum(["never", "success", "error"]),
  lastError: z.string(), lastSyncedAt: z.string().nullable(), nextSyncAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export class DataConnectionToolError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "DataConnectionToolError"; }
}
function requireWrite(auth: RequestAuthorization) {
  if (auth.role === "viewer" || auth.oauthScopes !== undefined && !auth.oauthScopes.split(/\s+/).includes("okri:write")) {
    throw new DataConnectionToolError("write_access_required", "Data connection changes require workspace write access.");
  }
}
async function target(auth: RequestAuthorization, id: string, expected?: "key_result" | "project", allowArchived = false) {
  const item = await getItem(auth.ownerId, id);
  if (!item || !["key_result", "project"].includes(item.kind) || !allowArchived && item.archivedAt) {
    throw new DataConnectionToolError("data_target_not_found", "An accessible KR or Project is required.");
  }
  if (expected && item.kind !== expected) throw new DataConnectionToolError("data_target_kind_mismatch", "target_kind does not match the saved item.");
  return item;
}
function publicConnection(c: DataConnectionSummary, sourceMode: "api" | "projects") {
  let origin: string | null = null;
  try { origin = new URL(c.endpointUrl).origin; } catch { /* Do not disclose malformed saved URLs. */ }
  return {
    id: c.id, itemId: c.itemId, targetKind: c.targetKind, name: c.name,
    endpointOrigin: origin, endpointConfigured: Boolean(c.endpointUrl),
    valuePath: c.valuePath, baselineValue: c.baselineValue, targetValue: c.targetValue, unit: c.unit,
    cadence: c.cadence as z.infer<typeof cadence>, active: c.active, sourceMode,
    lastValue: c.lastValue, lastSyncStatus: c.lastSyncStatus as "never" | "success" | "error",
    lastError: c.lastSyncStatus === "error" ? "API collection failed. Check the saved endpoint and value path." : "",
    lastSyncedAt: c.lastSyncedAt, nextSyncAt: c.nextSyncAt, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}
export async function listMcpDataConnections(db: D1Database, auth: RequestAuthorization, input: {item_id?: string; target_kind?: "key_result" | "project"}) {
  if (input.item_id) await target(auth, input.item_id, input.target_kind, true);
  const [connections, projectModes] = await Promise.all([
    listDataConnections(auth.ownerId, input.item_id),
    db.prepare("SELECT kr_item_id FROM kr_project_metrics WHERE owner_id=? AND active=1").bind(auth.ownerId).all<{kr_item_id: string}>(),
  ]);
  const manual = new Set(projectModes.results.map(row => row.kr_item_id));
  return connections.filter(c => !input.target_kind || c.targetKind === input.target_kind)
    .map(c => publicConnection(c, c.targetKind === "key_result" && manual.has(c.itemId) ? "projects" : "api"));
}
type ApiConfig = {name:string;endpointUrl:string;valuePath:string;baselineValue:number;targetValue:number;unit:string;cadence:string;active:boolean};
const sameConfig = (a: ApiConfig, b: ApiConfig) =>
  a.name === b.name && a.endpointUrl === b.endpointUrl && a.valuePath === b.valuePath && a.baselineValue === b.baselineValue
  && a.targetValue === b.targetValue && a.unit === b.unit && a.cadence === b.cadence && a.active === b.active;

export async function upsertMcpDataConnection(db: D1Database, auth: RequestAuthorization, raw: UpsertInput) {
  requireWrite(auth);
  const input = dataConnectionUpsertInput.parse(raw), item = await target(auth, input.item_id, input.target_kind);
  const state = item.kind === "key_result" ? await readKrSource(db, auth.ownerId, item.id) : null;
  const [current] = state ? [] : await listDataConnections(auth.ownerId, item.id);
  const previous = state ? state.api : current;
  const endpoint = input.endpoint_url ?? previous?.endpointUrl;
  if (!endpoint) throw new DataConnectionToolError("endpoint_url_required", "Provide the dedicated HTTPS API URL for a new connection.");
  let endpointUrl: string;
  try { endpointUrl = normalizeEndpoint(endpoint); } catch {
    throw new DataConnectionToolError("invalid_data_endpoint", "Use a public HTTPS API URL without embedded username/password credentials.");
  }
  const baselineValue = input.baseline_value ?? previous?.baselineValue, targetValue = input.target_value ?? previous?.targetValue;
  if (baselineValue === undefined || targetValue === undefined || baselineValue === targetValue) {
    throw new DataConnectionToolError("invalid_metric_range", "Different baseline_value and target_value numbers are required.");
  }
  const config = {name: input.name ?? previous?.name ?? item.title.slice(0,120), endpointUrl,
    valuePath: input.value_path ?? previous?.valuePath ?? "", baselineValue, targetValue,
    unit: input.unit ?? previous?.unit ?? "", cadence: cadence.parse(input.cadence ?? previous?.cadence ?? "daily"), active: input.active ?? previous?.active ?? true};
  if (previous && (!state || state.mode === "api") && sameConfig(previous, config)) {
    const latestState = state ? await readKrSource(db,auth.ownerId,item.id) : null;
    const [latest] = await listDataConnections(auth.ownerId,item.id);
    if (!latest || !sameConfig(latest,config) || latestState && latestState.mode !== "api") {
      throw new DataConnectionToolError("data_connection_conflict", "The connection changed. List its settings before retrying.");
    }
    return {connection: publicConnection(latest,"api"),created:false,changed:false};
  }
  if (state) {
    await saveKrSource(db, auth.ownerId, auth.userId, item.id, {revision: state.revision, mode: "api", api: config});
  } else if (current) {
    await updateDataConnection(auth.ownerId, current.id, config, current);
  } else {
    try { await createDataConnection(auth.ownerId, auth.userId, {itemId: item.id, ...config}); }
    catch (error) {
      const [raced] = await listDataConnections(auth.ownerId, item.id);
      if (raced && sameConfig(raced, config)) return {connection: publicConnection(raced, "api"), created: false, changed: false};
      if (raced) throw new DataConnectionToolError("data_connection_conflict", "Another connection was saved. List it before changing it again.");
      throw error;
    }
  }
  const [saved] = await listDataConnections(auth.ownerId, item.id);
  if (!saved) throw new DataConnectionToolError("data_connection_save_failed", "Could not verify the saved connection.");
  return {connection: publicConnection(saved, "api"), created: !previous, changed: true};
}
export async function syncMcpDataConnection(db: D1Database, auth: RequestAuthorization, input: {item_id:string; target_kind?: "key_result" | "project"}) {
  requireWrite(auth);
  const item = await target(auth, input.item_id, input.target_kind), [connection] = await listDataConnections(auth.ownerId, item.id);
  if (!connection) throw new DataConnectionToolError("data_connection_not_found", "Save this item's API connection before syncing.");
  if (item.kind === "key_result" && (await readKrSource(db, auth.ownerId, item.id)).mode !== "api") {
    throw new DataConnectionToolError("project_source_active", "This KR uses Project contributions. Use upsert_data_connection to select API measurement explicitly.");
  }
  try {
    const result = await syncDataConnection(auth.ownerId, connection.id);
    return {success: true, value: result.value, progress: result.progress, connection: publicConnection(result.connection as DataConnectionSummary, "api")};
  } catch {
    const [latest] = await listMcpDataConnections(db, auth, {item_id: item.id}), current = await getItem(auth.ownerId, item.id);
    return {success: false, value: null, progress: current?.progress ?? item.progress, connection: latest ?? publicConnection(connection, "api")};
  }
}
function failure(error: unknown) {
  const code = error instanceof DataConnectionToolError ? error.code
    : error instanceof z.ZodError ? "invalid_data_connection"
      : (error as {code?:string})?.code === "contribution_conflict" || error instanceof Error && error.message === "Data connection changed; read settings again" ? "data_connection_conflict" : "data_connection_failed";
  const message = error instanceof DataConnectionToolError ? error.message
    : code === "data_connection_conflict" ? "The KR changed while saving. List the current connection and retry."
      : "Could not complete the data connection request. Check its settings and access.";
  return {isError: true, content: [{type:"text" as const,text:JSON.stringify({code, error:message})}]};
}
export function registerDataConnectionTools(server: McpServer, db: D1Database, auth: RequestAuthorization) {
  server.registerTool("list_data_connections", {
    title: "List KR and Project API connections",
    description: "Read existing API settings for an owned KR or Project. Filter by item_id and target_kind. Endpoint paths/query credentials are never returned; omit endpoint_url in upsert_data_connection to retain a saved endpoint.",
    inputSchema: {item_id: itemId.optional(), target_kind: kind.optional()},
    outputSchema: {connections: z.array(connectionOutput)},
    annotations: {readOnlyHint:true, destructiveHint:false, openWorldHint:false},
  }, async input => {
    try { const connections=await listMcpDataConnections(db,auth,input);return {structuredContent:{connections},content:[{type:"text" as const,text:JSON.stringify({connections})}]}; }
    catch(error){return failure(error);}
  });
  server.registerTool("upsert_data_connection", {
    title: "Create or update one item's API connection",
    description: "Save the user's supplied API settings by item_id without fetching; call sync_data_connection to verify collection. Reuse the existing connection ID and preserve omitted settings. A new connection needs endpoint_url, baseline_value and target_value. Selects API measurement for a KR while retaining Project defaults and applied credits. Project API connections remain independent. Repeating unchanged settings does not create duplicates or history markers. Never invent an endpoint or backfill measurements.",
    inputSchema: dataConnectionUpsertInput.shape,
    outputSchema: {connection: connectionOutput, created: z.boolean(), changed: z.boolean()},
    annotations: {readOnlyHint:false, destructiveHint:false, openWorldHint:true},
  }, async input => {
    try {const result=await upsertMcpDataConnection(db,auth,input);return {structuredContent:result,content:[{type:"text" as const,text:JSON.stringify(result)}]};}
    catch(error){return failure(error);}
  });
  server.registerTool("sync_data_connection", {
    title: "Collect an item's API metric now",
    description: "Fetch the saved KR or Project API, update its actual value/progress and report success. Successful KR reads append a factual observation; failures do not invent values. Does not switch a KR away from Project measurement. Requires write access, including for a manually paused connection.",
    inputSchema: {item_id: itemId, target_kind: kind.optional()},
    outputSchema: {success:z.boolean(),value:z.number().nullable(),progress:z.number(),connection:connectionOutput},
    annotations: {readOnlyHint:false, destructiveHint:false, openWorldHint:true},
  }, async input => {
    try {const result=await syncMcpDataConnection(db,auth,input);return {...(!result.success?{isError:true}:{}),structuredContent:result,content:[{type:"text" as const,text:JSON.stringify(result)}]};}
    catch(error){return failure(error);}
  });
}
