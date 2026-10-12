import { readFile } from "node:fs/promises";
import { compileLanguageModule } from "./language-fixture.mjs";
export const calendar = compileLanguageModule(await readFile(new URL("../../lib/daily-calendar.ts", import.meta.url), "utf8"));
export const googleCalendar = { loadDailyCalendar: async (_auth, _date, timezone) => ({ status: "not_connected", timezone, events: [], selected: [] }) };
export const calendarEvent = (overrides = {}) => ({ key: "gcal:" + "a".repeat(64), title: "고객 미팅", start: "2026-09-04T01:00:00Z", end: "2026-09-04T02:00:00Z", allDay: false, timezone: "Asia/Seoul", ...overrides });
