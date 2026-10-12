export type DailyCalendarEvent = {
  key: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
};

export const MAX_DAILY_CALENDAR_EVENTS = 20;

// Persist only the explicitly shared title and time, never Google event metadata.
export function dailyCalendarSnapshots(raw: unknown): DailyCalendarEvent[] {
  let values: unknown = raw;
  if (typeof raw === "string") {
    try { values = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(values)) return [];
  const events = new Map<string, DailyCalendarEvent>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const { key, title, start, end, allDay, timezone } = value as Record<string, unknown>;
    if (typeof key !== "string" || !/^gcal:[a-f0-9]{64}$/.test(key)
      || typeof title !== "string" || !title.trim() || typeof start !== "string" || typeof end !== "string"
      || typeof allDay !== "boolean" || typeof timezone !== "string") continue;
    if (allDay ? !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
      : !/(?:Z|[+-]\d\d:\d\d)$/.test(start) || !/(?:Z|[+-]\d\d:\d\d)$/.test(end)) continue;
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) continue;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { continue; }
    events.set(key, { key, title: title.trim().replace(/[\r\n\t]/g, " ").slice(0, 240), start, end, allDay, timezone });
    if (events.size >= MAX_DAILY_CALENDAR_EVENTS) break;
  }
  return [...events.values()];
}

export function dailyCalendarTime(event: DailyCalendarEvent, allDayLabel: string) {
  if (event.allDay) return allDayLabel;
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: event.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: event.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const start = new Date(event.start), end = new Date(event.end);
  const endDate = date.format(start) === date.format(end) ? "" : `${date.format(end)} `;
  return `${format.format(start)} - ${endDate}${format.format(end)}`;
}
