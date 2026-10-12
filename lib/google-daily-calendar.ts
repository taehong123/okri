import { env } from "cloudflare:workers";
import { getGoogleConnection, type RequestAuthorization } from "@/lib/pace-data";
import { decryptSecret, googleConfigured, refreshGoogleAccessToken, type GoogleRuntimeEnv } from "@/lib/google-oauth";
import { zonedDayRange } from "@/lib/daily-work";
import { dailyCalendarSnapshots, type DailyCalendarEvent } from "@/lib/daily-calendar";

export type DailyCalendar = {
  status: "ready" | "not_connected" | "reconnect" | "unavailable";
  timezone: string;
  events: DailyCalendarEvent[];
  selected: string[];
  truncated?: boolean;
};

type GoogleEvent = {
  id?: string; summary?: string; status?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
};

export async function loadDailyCalendar(authorization: RequestAuthorization, date: string, timezone: string): Promise<DailyCalendar> {
  const empty = (status: DailyCalendar["status"]): DailyCalendar => ({ status, timezone, events: [], selected: [] });
  // A Slack member link is not permission to read another user's Google account.
  const member = await env.DB.prepare("SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'")
    .bind(authorization.ownerId, authorization.userId).first();
  if (!member || authorization.apiToken) return empty("not_connected");
  const runtime = env as GoogleRuntimeEnv;
  if (!googleConfigured(runtime)) return empty("unavailable");
  try {
    const connection = await getGoogleConnection(authorization.ownerId, authorization.userId);
    if (!connection) return empty("not_connected");
    const scopes = new Set(connection.scope.split(/[ ,]+/));
    if (!["calendar", "calendar.readonly", "calendar.events", "calendar.events.readonly", "calendar.events.owned", "calendar.events.owned.readonly"]
      .some((scope) => scopes.has(`https://www.googleapis.com/auth/${scope}`))) return empty("reconnect");
    const signal = AbortSignal.timeout(8000);
    const refresh = await decryptSecret(connection.encryptedRefreshToken, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!);
    let accessToken: string;
    try { accessToken = (await refreshGoogleAccessToken(runtime, refresh, signal)).access_token; }
    catch (error) { return empty(!signal.aborted && error instanceof Error && "status" in error && [400, 401].includes(Number(error.status)) ? "reconnect" : "unavailable"); }
    const [start, end] = zonedDayRange(date, timezone);
    const events: DailyCalendarEvent[] = [];
    let pageToken = "";
    for (let page = 0; page < 4; page += 1) {
      const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      url.search = new URLSearchParams({ timeMin: start, timeMax: end, timeZone: timezone,
        singleEvents: "true", orderBy: "startTime", showDeleted: "false", maxResults: "100", maxAttendees: "1",
        fields: "nextPageToken,items(id,summary,status,start,end,attendees(self,responseStatus))",
        ...(pageToken ? { pageToken } : {}) }).toString();
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
      if (!response.ok) return empty([401, 403].includes(response.status) ? "reconnect" : "unavailable");
      const result = await response.json() as { items?: GoogleEvent[]; nextPageToken?: string };
      for (const event of result.items ?? []) {
        if (!event.id || event.status === "cancelled" || event.attendees?.some((person) => person.self && person.responseStatus === "declined")) continue;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${connection.id}:${event.id}`)));
        const key = `gcal:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        const [snapshot] = dailyCalendarSnapshots([{ key, title: event.summary || "(Google Calendar)",
          start: event.start?.date || event.start?.dateTime, end: event.end?.date || event.end?.dateTime,
          allDay: Boolean(event.start?.date), timezone }]);
        if (snapshot && !events.some((existing) => existing.key === key)) events.push(snapshot);
        if (events.length === 100) break;
      }
      pageToken = result.nextPageToken || "";
      if (!pageToken || events.length === 100) break;
    }
    return { status: "ready", timezone, events, selected: [], truncated: Boolean(pageToken) };
  } catch { return empty("unavailable"); }
}
