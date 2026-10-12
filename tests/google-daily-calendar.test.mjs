import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { compileLanguageModule } from "./helpers/language-fixture.mjs";
import { calendar, calendarEvent } from "./helpers/daily-calendar-fixture.mjs";
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const work = compileLanguageModule(await read("../lib/daily-work.ts"));
const source = await read("../lib/google-daily-calendar.ts");
const scope = "https://www.googleapis.com/auth/calendar.events";
const auth = { ownerId: "w", userId: "u", apiToken: false };
const day = "2026-09-04";
const googleEvent = (overrides = {}) => ({ id: "meeting", summary: "고객 미팅", status: "confirmed", start: { dateTime: day + "T10:00:00+09:00" }, end: { dateTime: day + "T11:00:00+09:00" }, ...overrides });

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE workspace_members(id TEXT, workspace_id TEXT, user_id TEXT, status TEXT); INSERT INTO workspace_members VALUES('m','w','u','active'),('x','other','other-u','active');");
  t.after(() => sqlite.close());
  const state = { connection: { id: "connection", scope, encryptedRefreshToken: "encrypted-u" }, pages: [{ items: [googleEvent()] }], refreshError: null, status: 200 };
  const calls = [];
  const api = compileLanguageModule(source, {
    "cloudflare:workers": { env: { GOOGLE_CLIENT_ID: "test-id", GOOGLE_CLIENT_SECRET: "test-secret", GOOGLE_TOKEN_ENCRYPTION_KEY: "test-key", DB: { prepare(sql) {
      return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args) ?? null; } }; } };
    } } } },
    "@/lib/pace-data": { async getGoogleConnection(owner, user) { calls.push({ owner, user }); assert.deepEqual([owner, user], ["w", "u"]); return state.connection; } },
    "@/lib/google-oauth": { googleConfigured: () => true, decryptSecret: async (token) => { assert.equal(token, "encrypted-u"); return "refresh-u"; },
      refreshGoogleAccessToken: async (_runtime, token, signal) => { assert.equal(token, "refresh-u"); assert.ok(signal instanceof AbortSignal); if (state.refreshError) throw state.refreshError; return { access_token: "access-u" }; } },
    "@/lib/daily-calendar": calendar, "@/lib/daily-work": work,
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (raw, options) => {
    const url = new URL(raw);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(options.headers.Authorization, "Bearer access-u");
    assert.ok(!options.method || options.method === "GET", "calendar is read-only");
    calls.push(url);
    if (state.status !== 200) return new Response(null, { status: state.status });
    return Response.json(state.pages[url.searchParams.has("pageToken") ? Number(url.searchParams.get("pageToken")) : 0]);
  };
  t.after(() => { globalThis.fetch = original; });
  return { api, sqlite, state, calls };
}

test("calendar reads are scoped to the linked active account/workspace and never use workspace owner fallback", async (t) => {
  const { api, sqlite, calls } = fixture(t);
  for (const attempt of [{ ...auth, userId: "other-u" }, { ...auth, ownerId: "other" }, { ...auth, apiToken: true }]) {
    assert.equal((await api.loadDailyCalendar(attempt, day, "Asia/Seoul")).status, "not_connected");
  }
  assert.equal(calls.length, 0);
  sqlite.exec("UPDATE workspace_members SET status='removed' WHERE id='m'");
  assert.equal((await api.loadDailyCalendar(auth, day, "Asia/Seoul")).status, "not_connected");
  assert.equal(calls.length, 0);
});

test("today query expands recurrences, includes overnight overlap and only requests minimal metadata", async (t) => {
  const { api, state, calls } = fixture(t);
  state.pages = [{ items: [googleEvent(), googleEvent({ id: "all-day", start: { date: day }, end: { date: "2026-09-05" } }),
    googleEvent({ id: "canceled", status: "cancelled" }), googleEvent({ id: "declined", attendees: [{ self: true, responseStatus: "declined" }] })] }];
  const result = await api.loadDailyCalendar(auth, day, "Asia/Seoul");
  assert.equal(result.status, "ready"); assert.equal(result.events.length, 2); assert.deepEqual(result.selected, []);
  const query = calls.find((entry) => entry instanceof URL).searchParams;
  assert.equal(query.get("timeMin"), "2026-09-03T15:00:00.000Z");
  assert.equal(query.get("timeMax"), "2026-09-04T15:00:00.000Z");
  assert.equal(query.get("singleEvents"), "true"); assert.equal(query.get("orderBy"), "startTime");
  assert.doesNotMatch(query.get("fields"), /email|description|location|htmlLink/);
  assert.deepEqual(Object.keys(result.events[0]).sort(), ["key", "title", "start", "end", "allDay", "timezone"].sort());
  assert.equal(result.events[1].allDay, true);
});

test("calendar paging handles empty pages and is bounded to 100 events with explicit truncation", async (t) => {
  const { api, state } = fixture(t);
  state.pages = [{ items: [], nextPageToken: "1" }, { items: Array.from({ length: 100 }, (_, i) => googleEvent({ id: String(i) })), nextPageToken: "2" }];
  const result = await api.loadDailyCalendar(auth, day, "Asia/Seoul");
  assert.equal(result.events.length, 100); assert.equal(result.truncated, true);
});

test("missing connections, insufficient scope, revoked grants and outages stay nonblocking and never expose raw errors", async (t) => {
  const { api, state, calls } = fixture(t);
  state.connection = null;
  assert.equal((await api.loadDailyCalendar(auth, day, "Asia/Seoul")).status, "not_connected");
  state.connection = { id: "connection", scope: "openid email", encryptedRefreshToken: "encrypted-u" };
  assert.equal((await api.loadDailyCalendar(auth, day, "Asia/Seoul")).status, "reconnect");
  assert.ok(!calls.some((entry) => entry instanceof URL));
  state.connection.scope = scope;
  state.refreshError = Object.assign(new Error("sensitive token detail"), { status: 400 });
  assert.equal((await api.loadDailyCalendar(auth, day, "Asia/Seoul")).status, "reconnect");
  state.refreshError = Object.assign(new Error("sensitive token detail"), { status: 503 });
  assert.equal((await api.loadDailyCalendar(auth, day, "Asia/Seoul")).status, "unavailable");
  state.refreshError = null;
  for (const status of [401, 403, 429, 500]) {
    state.status = status;
    const result = await api.loadDailyCalendar(auth, day, "Asia/Seoul");
    assert.equal(result.status, status < 429 ? "reconnect" : "unavailable");
    assert.deepEqual(result.events, []); assert.doesNotMatch(JSON.stringify(result), /sensitive|access-u|encrypted/);
  }
});

test("day boundaries respect DST and formatting keeps all-day and local times distinct", () => {
  for (const [day, hours] of [["2026-03-08", 23], ["2026-11-01", 25]]) {
    const [start, end] = work.zonedDayRange(day, "America/New_York");
    assert.equal((Date.parse(end) - Date.parse(start)) / 3_600_000, hours);
  }
  assert.equal(calendar.dailyCalendarTime(calendarEvent(), "All day"), "10:00 - 11:00");
  assert.equal(calendar.dailyCalendarTime(calendarEvent({ allDay: true }), "All day"), "All day");
});

test("snapshots strip metadata, cap selections and ignore malformed stored data", () => {
  const saved = calendar.dailyCalendarSnapshots([calendarEvent({ description: "private", attendees: ["private"], htmlLink: "private" })]);
  assert.equal(saved.length, 1); assert.doesNotMatch(JSON.stringify(saved), /private/);
  for (const invalid of ["{", "{}", null, [calendarEvent({ key: "forged" })], [calendarEvent({ end: "invalid" })], [calendarEvent({ timezone: "invalid" })]]) assert.deepEqual(calendar.dailyCalendarSnapshots(invalid), []);
  const many = Array.from({ length: 30 }, (_, i) => calendarEvent({ key: "gcal:" + i.toString(16).padStart(64, "0") }));
  assert.equal(calendar.dailyCalendarSnapshots(many).length, 20);
});
