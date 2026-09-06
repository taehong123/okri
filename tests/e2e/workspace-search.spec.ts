import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks, json } from "./api-mocks";
import { THEME_STORAGE_KEY } from "../../lib/themes";

const remoteProject = { ...bootstrap.items[3], id: "project-remote", title: "전체 대시보드 만들기 — 길고 긴 프로젝트 이름과 Workspace 123", assignments: bootstrap.items[3].assignments };
const remoteTask = { ...bootstrap.items[4], id: "task-remote", title: "검색으로 찾은 Task", parentId: remoteProject.id };
const otherCycle = { ...bootstrap.cycles[0], id: "cycle-other", name: "다른 파일" };
const otherObjective = { ...bootstrap.items[0], id: "objective-other", cycleId: otherCycle.id };
const otherKr = { ...bootstrap.items[1], id: "kr-other", cycleId: otherCycle.id, parentId: otherObjective.id };
const otherIni = { ...bootstrap.items[2], id: "ini-other", title: "다른 파일의 검색 Initiative", cycleId: otherCycle.id, parentId: otherKr.id };
const resultFor = (item: typeof remoteProject) => ({ id: item.id, kind: item.kind, title: item.title, parentId: item.parentId, parentTitle: "상위 업무", cycleId: item.cycleId, cycleName: "2026 하반기", routineId: null, status: item.status, dueDate: item.dueDate, assignee: "테스트 사용자" });

async function setup(page: Page, role: "owner" | "viewer" = "owner") {
  await installApiMocks(page, { teamWorkspace: true, withRoutine: true, workspaceRole: role });
  const state = { searches: [] as URL[], resolves: [] as URL[], fail: false, resolveFail: false, delay: 0, bootstrapReads: 0 };
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/bootstrap") state.bootstrapReads++; });
  await page.route(/\/api\/search(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url()); state.searches.push(url);
    expect(route.request().headers()["x-okri-workspace-id"]).toBe("workspace-1");
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (state.fail) return json(route, { error: "search_unavailable" }, 503);
    const q = url.searchParams.get("q") ?? "";
    const options = [resultFor(remoteProject), resultFor(remoteTask), resultFor(otherIni), { ...resultFor(remoteTask), kind: "member", id: "member-1", title: "테스트 사용자" }];
    let results = options.filter((row) => !q || row.title.includes(q));
    if (url.searchParams.get("assignee")) results = options.filter((row) => row.kind === "task");
    if (url.searchParams.get("kind")) results = results.filter((row) => row.kind === url.searchParams.get("kind"));
    const refs = url.searchParams.getAll("ref");
    if (refs.length) results = results.filter((row) => refs.includes(`${row.kind}:${row.id}`));
    return json(route, { results, nextOffset: null });
  });
  await page.route(/\/api\/search\/resolve\?/, async (route) => {
    state.resolves.push(new URL(route.request().url()));
    if (state.resolveFail) return json(route, { code: "search_item_unavailable" }, 404);
    return json(route, { items: [...bootstrap.items, remoteProject, remoteTask, otherObjective, otherKr, otherIni], cycles: [otherCycle, ...bootstrap.cycles], routines: [], propertyValues: {}, hiddenByProject: {} });
  });
  return state;
}
async function openSearch(page: Page) {
  await page.getByRole("button", { name: "업무 또는 메뉴 검색", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "업무 또는 메뉴 검색", exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}

test("quiet workspace selector keeps types in its menu; search closes on the same work view", async ({ page }, info) => {
  await setup(page); await page.goto("/?view=work");
  if (info.project.name === "desktop-chromium") {
    await expect(page.locator(".workspace-switcher small")).toHaveCount(0);
    await page.locator(".workspace-switcher").click();
    await expect(page.locator(".workspace-menu")).toContainText("팀 · Owner");
    await page.locator(".workspace-switcher").click();
    await expect(page.locator(".workspace-settings-trigger")).toBeVisible();
    await expect(page.locator(".workspace-topbar-settings")).toBeHidden();
  }
  await expect(page.locator(".workspace-topbar > b")).toHaveCount(0);
  const dialog = await openSearch(page);
  await dialog.getByRole("searchbox").fill("보존할 검색어");
  await dialog.getByRole("button", { name: "검색 닫기" }).click();
  await expect(dialog).toHaveCount(0); await expect(page).toHaveURL(/view=work/);
  await expect(page).not.toHaveURL(/search=1/);
  await openSearch(page); await expect(dialog.getByRole("searchbox")).toHaveValue("보존할 검색어");
});

test("server-only Task resolves latest context; parent navigation and Back restore the search", async ({ page }) => {
  const state = await setup(page); await page.goto("/?view=work");
  const dialog = await openSearch(page); const reads = state.bootstrapReads;
  await dialog.getByRole("searchbox").fill(remoteTask.title);
  await dialog.getByRole("button").filter({ hasText: remoteTask.title }).click();
  await expect(page.locator(".task-title-input")).toHaveValue(remoteTask.title);
  expect(state.resolves).toHaveLength(1);
  await page.locator(".task-detail-panel .detail-parent-link").click();
  await expect(page.locator(".project-title-input")).toHaveValue(remoteProject.title);
  await page.goBack(); await expect(page.locator(".task-title-input")).toHaveValue(remoteTask.title);
  await page.locator(".task-detail-panel").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole("searchbox")).toHaveValue(remoteTask.title);
  expect(state.bootstrapReads).toBe(reads);
});

test("search opens the correct OKR file and expands only the ancestor of the found Initiative", async ({ page }) => {
  await setup(page); await page.goto("/?view=work");
  const dialog = await openSearch(page);
  await dialog.getByRole("searchbox").fill(otherIni.title);
  await dialog.getByRole("button").filter({ hasText: otherIni.title }).click();
  await expect(page).toHaveURL(/view=okr/);
  await expect(page).toHaveURL(/cycle=cycle-other/);
  await expect(page.locator(`#okr-search-${otherIni.id}`)).toBeVisible();
  await expect(page.locator(`#okr-search-${otherIni.id}`)).toHaveClass(/search-target/);
  await expect(page.locator(`#okr-search-${otherKr.id} > button`)).toHaveAttribute("aria-expanded", "true");
  await page.locator(`#okr-search-${otherKr.id} > button`).click();
  await openSearch(page);
  await dialog.getByRole("button").filter({ hasText: otherIni.title }).click();
  await expect(page.locator(`#okr-search-${otherKr.id} > button`)).toHaveAttribute("aria-expanded", "true");
  await page.goBack(); await expect(dialog).toBeVisible();
});

test("search reopens a collapsed Routine with fresh server content without replacing its user-written text", async ({ page }) => {
  await setup(page);
  const routine = { ...bootstrap.routines[0], id: "routine-remote", systemKey: null, title: "검색할 정기 리뷰", description: "원래 메모", triggerPoint: "월요일" };
  await page.route(/\/api\/search(?:\?|$)/, (route) => json(route, { results: [{ ...resultFor(remoteTask), id: routine.id, kind: "routine", title: routine.title, cycleId: null }], nextOffset: null }));
  await page.route(/\/api\/search\/resolve\?/, (route) => json(route, { items: [], cycles: [], routines: [routine], propertyValues: {}, hiddenByProject: {} }));
  await page.route(/\/api\/routines(?:\?|$)/, (route) => json(route, { routines: [routine] }));
  await page.goto("/?view=work"); const dialog = await openSearch(page);
  await dialog.getByRole("searchbox").fill(routine.title);
  await dialog.getByRole("button").filter({ hasText: routine.title }).click();
  const card = page.locator(`#routine-search-${routine.id}`);
  await expect(card.getByRole("button", { name: /검색할 정기 리뷰/ })).toHaveAttribute("aria-expanded", "true");
  await card.getByRole("button", { name: /검색할 정기 리뷰/ }).click();
  routine.description = "서버에서 갱신된 사용자 메모";
  await openSearch(page); await dialog.getByRole("button").filter({ hasText: routine.title }).click();
  await expect(card.getByRole("button", { name: /검색할 정기 리뷰/ })).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByLabel("목적/메모")).toHaveValue(routine.description);
});

test("person results become assignee filters and menu search opens the daily bot", async ({ page }) => {
  const state = await setup(page); await page.goto("/?view=work");
  const dialog = await openSearch(page);
  await dialog.getByRole("searchbox").fill("테스트 사용자");
  await dialog.getByRole("button").filter({ hasText: "담당 업무 보기" }).click();
  await expect(dialog.getByLabel("담당자", { exact: true })).toHaveValue("member-1");
  await expect.poll(() => state.searches.at(-1)?.searchParams.get("assignee")).toBe("member-1");
  await dialog.getByRole("button", { name: "필터 초기화" }).click();
  await dialog.getByRole("searchbox").fill("데일리 봇");
  await dialog.getByRole("region", { name: "메뉴 바로가기" }).getByRole("button").filter({ hasText: "데일리 봇" }).click();
  await expect(page).toHaveURL(/settings=workspace/); await expect(page).toHaveURL(/bot=daily/);
  await expect(page.getByRole("dialog", { name: "워크스페이스 설정", exact: true })).toBeVisible();
  await page.goBack(); await expect(dialog).toBeVisible();
});

test("slow, failed and missing results preserve the query, filters and previous visible results", async ({ page }) => {
  const state = await setup(page); await page.goto("/?view=work");
  const dialog = await openSearch(page); await dialog.getByRole("searchbox").fill(remoteProject.title);
  await expect(dialog.getByRole("button").filter({ hasText: remoteProject.title })).toBeVisible();
  state.delay = 650; state.fail = true;
  await dialog.getByRole("combobox", { name: "유형", exact: true }).selectOption("project");
  await expect(dialog.getByRole("button").filter({ hasText: remoteProject.title })).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("검색하지 못했습니다");
  await expect(dialog.getByRole("searchbox")).toHaveValue(remoteProject.title);
  state.fail = false; state.delay = 0; state.resolveFail = true;
  await dialog.getByRole("button").filter({ hasText: remoteProject.title }).click();
  await expect(dialog.getByRole("alert")).toContainText("항목을 열지 못했습니다");
  await expect(page).toHaveURL(/view=work/); await expect(dialog).toBeVisible();
});

test("keyboard search does not discard an OKR draft when a destination is cancelled", async ({ page }) => {
  await setup(page); await page.goto("/?view=okr");
  await page.getByRole("button", { name: "파일 수정", exact: true }).click();
  const title = page.locator(".okr-file-editor input").first();
  await title.fill("저장하지 않은 초안");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "업무 또는 메뉴 검색", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox").fill("Task"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "OKR 수정 중", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "OKR 수정 중", exact: true }).getByRole("button", { name: "취소", exact: true }).click();
  await dialog.getByRole("button", { name: "검색 닫기" }).click();
  await expect(title).toHaveValue("저장하지 않은 초안");
});

test("closing search preserves the AI conversation view and its composer draft", async ({ page }, info) => {
  await setup(page); await page.goto("/?view=work");
  const nav = page.locator(info.project.name === "desktop-chromium" ? ".desktop-navigation" : ".mobile-navigation");
  await nav.getByRole("button", { name: "AI 대화", exact: true }).click();
  const composer = page.locator(".workspace textarea").first();
  await composer.fill("작성 중인 대화는 검색을 닫아도 그대로");
  const dialog = await openSearch(page);
  await dialog.getByRole("button", { name: "검색 닫기" }).click();
  await expect(nav.getByRole("button", { name: "AI 대화", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(composer).toHaveValue("작성 중인 대화는 검색을 닫아도 그대로");
});

test("a read-only member can search; recent work is rechecked on reopening and menus close back to search", async ({ page }) => {
  const state = await setup(page, "viewer"); const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    // Opening any settings screen records the existing consent prompt exposure.
    if (path.startsWith("/api/") && path !== "/api/account/marketing-consent" && !["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  await page.goto("/?view=work"); const dialog = await openSearch(page);
  await dialog.getByRole("searchbox").fill(remoteTask.title);
  await dialog.getByRole("button").filter({ hasText: remoteTask.title }).click();
  await page.goBack(); await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox").fill("");
  await expect(dialog.getByRole("region", { name: "최근 열어본 업무" })).toContainText(remoteTask.title);
  expect(state.searches.at(-1)?.searchParams.getAll("ref")).toContain("task:task-remote");
  await dialog.getByRole("searchbox").fill("테마");
  await dialog.getByRole("region", { name: "메뉴 바로가기" }).getByRole("button").click();
  const settings = page.getByRole("dialog", { name: "내 설정", exact: true });
  await expect(settings).toBeVisible(); await settings.getByRole("button", { name: "내 설정 닫기" }).click();
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole("searchbox")).toHaveValue("테마");
  expect(writes).toEqual([]);
});

test("at 200 percent text on a short phone, filters and result actions remain scrollable and usable", async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 320, height: 568 }); await page.goto("/?view=work");
  const dialog = await openSearch(page); await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await dialog.getByRole("searchbox").fill(remoteTask.title);
  const result = dialog.getByRole("button").filter({ hasText: remoteTask.title });
  await result.scrollIntoViewIfNeeded(); await expect(result).toBeVisible(); await result.click();
  await expect(page.locator(".task-title-input")).toHaveValue(remoteTask.title);
});

test("workspace search uses the same font scale, semantic contrast and touch targets from mobile to 4K", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "One sequential viewport/theme matrix");
  test.setTimeout(180_000);
  await setup(page);
  for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.addInitScript(({ key, theme }) => localStorage.setItem(key, theme), { key: THEME_STORAGE_KEY, theme });
    for (const width of [320, 390, 1440, 3840]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto("/?view=work");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const dialog = await openSearch(page); await dialog.getByRole("searchbox").fill("전체 대시보드");
      await expect(dialog.getByRole("button").filter({ hasText: remoteProject.title })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.locator(".workspace-search-panel").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      expect(await dialog.getByRole("searchbox").evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
      expect((await new AxeBuilder({ page: page as never }).include(".workspace-search-panel").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
      if (width === 320) expect((await dialog.getByLabel("검색 닫기").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if (theme === "white" && width === 1440) {
        await page.screenshot({ path: info.outputPath("search-desktop.png") });
        const cdp = await context.newCDPSession(page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".workspace-search-result-copy > span" });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        expect(fonts.length).toBeGreaterThan(0); expect(fonts.every((font) => font.isCustomFont && font.familyName.includes("Pretendard"))).toBe(true);
        await cdp.detach();
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await dialog.getByRole("searchbox").fill("테스트");
      await expect(dialog.getByRole("searchbox")).toBeInViewport();
      expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      if (theme === "white") await page.screenshot({ path: info.outputPath(`search-${width}.png`) });
    }
  }
});

test("five interface languages preserve work titles and show translated search controls", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "One sequential language matrix");
  await setup(page);
  let language = "ko";
  await page.route(/\/api\/bootstrap(?:\?|$)/, (route) => json(route, { ...bootstrap, user: { ...bootstrap.user, preferences: { language, resolvedLanguage: language, revision: 1 } } }));
  for (const [id, label] of [["ko", "업무 또는 메뉴 검색"], ["en", "Search work or menus"], ["ja", "業務・メニューを検索"], ["zh", "搜索工作或菜单"], ["es", "Buscar trabajo o menús"]]) {
    language = id; await page.goto("/?view=work");
    await expect(page.locator("html")).toHaveAttribute("lang", id === "zh" ? "zh-Hans" : id);
    await page.getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: label, exact: true });
    await dialog.getByRole("searchbox").fill(remoteTask.title);
    await expect(dialog.getByRole("button").filter({ hasText: remoteTask.title })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
});
