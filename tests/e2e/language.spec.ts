import { expect, test, type Page } from "@playwright/test";
import { bootstrap, installApiMocks, json } from "./api-mocks";
import type { Language, LanguagePreferences } from "../../lib/language";

async function fixture(page: Page, state: { preferences: LanguagePreferences; fail?: boolean; conflict?: boolean; slackState?: "service_unavailable" | "workspace_disconnected" | "setup_required" | "connected" | "reauthorization_required"; slackSetupComplete?: boolean; teamWorkspace?: boolean }) {
  await installApiMocks(page, { slackState: state.slackState, slackSetupComplete: state.slackSetupComplete, teamWorkspace: state.teamWorkspace });
  const requests: string[] = [], writes: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/api/bootstrap") return json(route, {
      ...bootstrap,
      user: { ...bootstrap.user, preferences: state.preferences },
      workspaces: state.teamWorkspace ? bootstrap.workspaces.map((workspace) => ({ ...workspace, kind: "team", personal: false })) : bootstrap.workspaces,
      team: state.teamWorkspace ? { ...bootstrap.team, workspace: { ...bootstrap.team.workspace, kind: "team" } } : bootstrap.team,
    });
    if (path === "/api/account/preferences") {
      if (request.method() === "PATCH") {
        const input = request.postDataJSON(); writes.push(input);
        if (state.fail) return json(route, { code: "preferences_save_failed", error: "mock write rejected" }, 500);
        if (state.conflict) {
          state.conflict = false;
          state.preferences = { ...state.preferences, revision: state.preferences.revision + 1 };
          return json(route, { code: "preference_conflict", error: "mock concurrent update" }, 409);
        }
        state.preferences = { language: input.language, resolvedLanguage: input.language === "auto" ? "en" : input.language, revision: state.preferences.revision + 1 };
      }
      return json(route, { preferences: state.preferences });
    }
    if (path === "/api/slack/automations" && request.method() === "GET") return json(route, {
      automations: [{ id: "custom-rule", name: "사용자 작성 규칙", triggerType: "task_created", triggerStatus: "", channelId: "C123", messageTemplate: "사용자 작성 메시지", messageTemplateKind: "custom", active: true, lastTriggeredAt: null, lastDeliveryStatus: "never", lastError: "", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }],
      deliveries: [],
      messageLanguage: state.preferences.resolvedLanguage,
    });
    // Existing consent-prompt bookkeeping is mocked by the shared fixture.
    if (request.method() !== "GET" && path !== "/api/account/marketing-consent" && path !== "/api/project-documents") throw new Error(`Unexpected write in language test: ${path}`);
    return route.fallback();
  });
  return { requests, writes };
}

async function openPreferences(page: Page) {
  if (page.viewportSize()!.width <= 700) {
    await page.locator(".mobile-navigation button").last().click();
    await page.locator(".mobile-account-entry").click();
  } else await page.locator(".sidebar .profile-row").click();
  await expect(page.locator(".language-settings select")).toBeVisible();
}

for (const id of ["ko", "en", "ja", "zh", "es"] as const) {
  test(`bootstrap language ${id} preserves user content and requires no preference preflight`, async ({ page }, info) => {
    const { requests } = await fixture(page, { preferences: { language: id, resolvedLanguage: id, revision: 1 } });
    await page.goto("/?view=my_work");
    await expect(page.locator(".workspace")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", id === "zh" ? "zh-Hans" : id);
    await expect(page.locator(".my-work-item").filter({ hasText: "오버레이 동작 점검" })).toBeVisible();
    expect(requests.filter((value) => value.includes("/api/account/preferences"))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`language-${id}.png`) });
  });
}

test("all bot types, management signals and recommended automations follow the selected language", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Run the bot language matrix once in the desktop project.");
  const copy = {
    ko: { daily: "데일리 봇", management: "관리 봇", work: "업무 생성 관리 봇", automation: "Task 변동 알림 봇", signal: "활성 Project·Task 중 마감일이 비어 있는 항목", completed: "Task 완료 알림", created: "새 Task 알림" },
    en: { daily: "Daily bot", management: "Management bot", work: "Work creation bot", automation: "Task change notification bot", signal: "Active Projects and Tasks with no due date", completed: "Task completion alert", created: "New Task alert" },
    ja: { daily: "デイリーボット", management: "管理ボット", work: "業務作成管理ボット", automation: "Task変更通知ボット", signal: "期限が設定されていない進行中のProject・Task", completed: "Task完了通知", created: "新しいTaskの通知" },
    zh: { daily: "日报机器人", management: "管理机器人", work: "工作创建管理机器人", automation: "Task 变更通知机器人", signal: "没有截止日期的活跃 Project 和 Task", completed: "Task 完成提醒", created: "新 Task 提醒" },
    es: { daily: "Bot diario", management: "Bot de gestión", work: "Bot de creación de trabajo", automation: "Bot de avisos de cambios de Task", signal: "Projects y Tasks activos sin fecha límite", completed: "Aviso de Task completada", created: "Alerta de nueva Task" },
  } as const;
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences, slackState: "connected" as const, slackSetupComplete: true, teamWorkspace: true };
  await fixture(page, state);

  for (const [index, id] of (["ko", "en", "ja", "zh", "es"] as const).entries()) {
    state.preferences = { language: id, resolvedLanguage: id, revision: index + 1 };
    await page.goto("/?settings=workspace&tab=integrations&bot=management");
    const rows = page.locator(".bot-accordion-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator(".bot-accordion-copy > b")).toHaveText(copy[id].daily);
    await expect(rows.nth(1).locator(".bot-accordion-copy > b")).toHaveText(copy[id].management);
    await expect(rows.nth(2).locator(".bot-accordion-copy > b")).toHaveText(copy[id].work);
    await expect(rows.nth(3).locator(".bot-accordion-copy > b")).toHaveText(copy[id].automation);

    await rows.nth(1).locator("details.bot-advanced-settings > summary").click();
    await expect(rows.nth(1)).toContainText(copy[id].signal);
    await rows.nth(3).locator("button.bot-accordion-trigger").click();
    const recommendations = rows.nth(3).locator(".automation-recommendations");
    await expect(recommendations).toContainText(copy[id].completed);
    await expect(recommendations).toContainText(copy[id].created);
    await expect(rows.nth(3)).toContainText("사용자 작성 규칙");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});

test("changing language saves only preferences without reloading workspace data", async ({ page }) => {
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences };
  const { requests, writes } = await fixture(page, state);
  await page.goto("/?view=work");
  await expect(page.locator(".workspace")).toBeVisible();
  await openPreferences(page);
  const before = requests.filter((entry) => entry.includes("/api/bootstrap")).length;
  for (const id of ["en", "ja", "zh", "es", "ko"] as Language[]) {
    await page.locator(".language-settings select").selectOption(id);
    await expect(page.locator("html")).toHaveAttribute("lang", id === "zh" ? "zh-Hans" : id);
    await page.locator(".language-settings button.primary-action").click();
    await expect(page.locator(".language-settings button.primary-action")).toBeDisabled();
    expect(state.preferences.language).toBe(id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  expect(writes).toHaveLength(5);
  expect(requests.filter((entry) => entry.includes("/api/bootstrap"))).toHaveLength(before);
  expect(new URL(page.url()).searchParams.get("view")).toBe("work");
});

test("failed preference save keeps the preview and offers retry without changing the account", async ({ page }) => {
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences, fail: true };
  await fixture(page, state);
  await page.goto("/?view=work");
  await openPreferences(page);
  await page.locator(".language-settings select").selectOption("en");
  await page.locator(".language-settings button.primary-action").click();
  await expect(page.locator(".language-settings [role=alert]")).toBeVisible();
  await expect(page.locator(".language-settings select")).toHaveValue("en");
  expect(state.preferences.language).toBe("ko");
  state.fail = false;
  await page.locator(".language-settings button.primary-action").click();
  await expect(page.locator(".language-settings button.primary-action")).toBeDisabled();
  expect(state.preferences.language).toBe("en");
});

test("a concurrent preference update keeps the chosen language and retries with the fresh revision", async ({ page }) => {
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences, conflict: true };
  const { writes } = await fixture(page, state);
  await page.goto("/?view=work");
  await openPreferences(page);
  await page.locator(".language-settings select").selectOption("en");
  await page.locator(".language-settings button.primary-action").click();
  await expect(page.locator(".language-settings [role=alert]")).toBeVisible();
  await expect(page.locator(".language-settings select")).toHaveValue("en");
  expect(state.preferences.language).toBe("ko");
  await page.locator(".language-settings button.primary-action").click();
  await expect(page.locator(".language-settings button.primary-action")).toBeDisabled();
  expect(state.preferences.language).toBe("en");
  expect(writes).toMatchObject([{ language: "en", revision: 0 }, { language: "en", revision: 1 }]);
});

test("a language change in another tab preserves the open form and its draft", async ({ page, context }) => {
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences };
  const { requests } = await fixture(page, state);
  await page.goto("/?view=work");
  await page.getByRole("button", { name: "직접 추가", exact: true }).click();
  const title = page.locator(".create-item-form input").first();
  await title.fill("사용자 작성 초안 / Customer draft 123");
  const before = requests.filter((entry) => entry.includes("/api/bootstrap")).length;
  const second = await context.newPage();
  await fixture(second, state);
  await second.goto("/?view=work");
  await openPreferences(second);
  await second.locator(".language-settings select").selectOption("en");
  await second.locator(".language-settings button.primary-action").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(title).toHaveValue("사용자 작성 초안 / Customer draft 123");
  await expect(page.locator(".create-item-form")).toBeVisible();
  expect(requests.filter((entry) => entry.includes("/api/bootstrap"))).toHaveLength(before);
  await second.close();
});

test("editor language changes preserve the editor node, content and undo history", async ({ page, context }) => {
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences };
  const { requests } = await fixture(page, state);
  await page.goto("/?view=work&project=project-1");
  const editor = page.locator(".project-block-editor .bn-editor");
  await expect(editor).toBeVisible();
  const node = await editor.elementHandle();
  await editor.click();
  await page.keyboard.type("Customer draft preserved 123");
  await expect(editor).toContainText("Customer draft preserved 123");
  const before = requests.filter((entry) => entry.startsWith("GET ")).length;
  const second = await context.newPage();
  await fixture(second, state);
  await second.goto("/?view=work");
  await openPreferences(second);
  await second.locator(".language-settings select").selectOption("en");
  await second.locator(".language-settings button.primary-action").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(editor).toContainText("Customer draft preserved 123");
  expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
  // The only new application GET is the account preference read from BroadcastChannel.
  expect(requests.filter((entry) => entry.startsWith("GET ")).slice(before)).toEqual(["GET /api/account/preferences"]);
  await page.bringToFront();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Customer draft preserved 123");
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("listbox")).toContainText("Heading");
  await second.close();
});

test("cancelling an unsaved language preview restores the saved account choice", async ({ page }) => {
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences };
  const { writes } = await fixture(page, state);
  await page.goto("/?view=work");
  await openPreferences(page);
  await page.locator(".language-settings select").selectOption("es");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.locator(".language-settings > button.secondary").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator(".language-settings button.primary-action")).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test("all languages keep the wide layout readable with 200 percent user text and CJK fallbacks", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Run the wide text matrix once in the desktop project.");
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 3840, height: 2160 });
  const state = { preferences: { language: "ko", resolvedLanguage: "ko", revision: 0 } as LanguagePreferences };
  await fixture(page, state);
  await page.goto("/?view=my_work");
  await openPreferences(page);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  for (const id of ["ko", "en", "ja", "zh", "es"] as Language[]) {
    await page.locator(".language-settings select").selectOption(id);
    await expect(page.locator("html")).toHaveAttribute("lang", id === "zh" ? "zh-Hans" : id);
    const family = await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily);
    expect(family).toContain("Pretendard");
    if (id === "ja") expect(family).toContain("OKRI Japanese");
    if (id === "zh") expect(family).toContain("OKRI Simplified Chinese");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator(".my-work-item").first()).toBeVisible();
  }
});
