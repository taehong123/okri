import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks, json } from "./api-mocks";
import { initialOnboarding, type OnboardingState } from "../../lib/onboarding";

async function setupMocks(page: Page, initial = initialOnboarding(), viewer = false) {
  await installApiMocks(page);
  let state: OnboardingState = structuredClone(initial);
  let saves = 0, workspaceCreates = 0;
  let loseSaveResponse = false;
  const workspaces = bootstrap.workspaces.map(w => ({ ...w, kind: "personal", personal: true, role: "owner" }));
  if (viewer) workspaces.push({ ...workspaces[0], id: "invited-team", name: "초대받은 팀", kind: "team", personal: false, role: "viewer" });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/bootstrap") return json(route, { ...bootstrap, workspaces, user: { ...bootstrap.user, onboarding: state } });
    if (path !== "/api/account/onboarding") return route.fallback();
    if (request.method() === "GET") return json(route, { onboarding: state });
    const input = request.postDataJSON();
    if (input.action === "save" && state.cycleId || input.action === "workspace" && state.workspaceId) return json(route, { onboarding: state });
    if (input.revision !== state.revision) return json(route, { code: "setup_conflict" }, 409);
    if (input.action === "draft") state = { ...state, draft: input.draft, step: input.step };
    if (input.action === "pause") state.status = "paused";
    if (input.action === "complete") state.status = "completed";
    if (input.action === "tour") state.step = "tour";
    if (input.action === "workspace") {
      if (state.draft.kind === "team" && !input.workspaceId) workspaceCreates++;
      state.workspaceId = input.workspaceId || (state.draft.kind === "team" ? "new-team" : workspaces[0].id);
      state.workspaceName = state.draft.kind === "team" && !input.workspaceId ? state.draft.workspaceName : workspaces.find(w => w.id === state.workspaceId)!.name;
      state.step = viewer && input.workspaceId === "invited-team" ? "tour" : "goal";
    }
    if (input.action === "save") { saves++; state.cycleId = "new-cycle"; state.step = "tour"; }
    state.revision++;
    if (input.action === "save" && loseSaveResponse) { loseSaveResponse = false; return route.abort("failed"); }
    return json(route, { onboarding: state });
  });
  return { state: () => state, saves: () => saves, creates: () => workspaceCreates, loseResponse: () => { loseSaveResponse = true; } };
}

test("personal setup explains and saves a whole OKR only after final confirmation", async ({ page }) => {
  const mock = await setupMocks(page);
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "처음 시작하기", exact: true });
  await expect(dialog.getByRole("heading", { name: "누구의 목표를 관리할까요?" })).toBeVisible();
  await dialog.getByRole("radio", { name: /개인으로/ }).check();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "개인 목표를 위한 공간이 준비되어 있어요" })).toBeVisible();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await dialog.getByLabel("이루고 싶은 목표", { exact: true }).fill("영어로 내 생각을 자신 있게 말하기");
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await dialog.getByLabel("결과 1", { exact: true }).fill("영어로 10분 대화하기를 8회 완료하기");
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await dialog.getByRole("textbox").fill("주 2회 회화 연습하기");
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  expect(mock.saves()).toBe(0);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "이전", exact: true }).click();
  await dialog.getByRole("textbox").fill("주 3회 회화 연습하기");
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "확인한 OKR 저장", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "첫 OKR을 저장했어요" })).toBeVisible();
  expect(mock.saves()).toBe(1);
  expect(mock.creates()).toBe(0);
  expect(mock.state().draft.keyResults[0].initiative).toBe("주 3회 회화 연습하기");
  const measurements = await dialog.evaluate(el => {
    const content = el.querySelector(".first-run-setup")!;
    return { font: getComputedStyle(content).fontFamily, width: content.clientWidth, scroll: content.scrollWidth };
  });
  expect(measurements.font).toContain("Pretendard");
  expect(measurements.scroll).toBeLessThanOrEqual(measurements.width + 1);
});

test("team setup saves progress, pauses, and resumes without another workspace", async ({ page }) => {
  const mock = await setupMocks(page);
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "처음 시작하기", exact: true });
  await dialog.getByRole("radio", { name: /팀과 함께/ }).check();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await dialog.getByRole("button", { name: "워크스페이스 만들고 계속" }).click();
  await expect(dialog.getByText("팀 이름을 입력해 주세요.")).toBeVisible();
  await dialog.getByLabel("팀 이름", { exact: true }).fill("고객경험팀");
  await dialog.getByRole("button", { name: "워크스페이스 만들고 계속" }).click();
  await dialog.getByLabel("이루고 싶은 목표", { exact: true }).fill("고객이 다시 찾는 서비스를 만들기");
  await dialog.getByRole("button", { name: "저장하고 나중에 계속", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "처음 설정 이어하기" })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "처음 설정 이어하기" }).click();
  await expect(dialog.getByLabel("이루고 싶은 목표", { exact: true })).toHaveValue("고객이 다시 찾는 서비스를 만들기");
  expect(mock.creates()).toBe(1);
  expect(mock.saves()).toBe(0);
});

test("lost save response is recovered from saved state, never by duplicating the OKR", async ({ page }) => {
  const initial = initialOnboarding();
  initial.step = "review"; initial.workspaceId = "workspace-1"; initial.workspaceName = "Personal";
  initial.draft = { ...initial.draft, objective: "Grow", startDate: "2026-09-01", endDate: "2026-09-30", keyResults: [{ title: "Eight conversations", initiative: "" }] };
  const mock = await setupMocks(page, initial);
  mock.loseResponse();
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "처음 시작하기", exact: true });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "확인한 OKR 저장" }).click();
  await expect(dialog.getByRole("button", { name: "저장 상태 확인" })).toBeVisible();
  await dialog.getByRole("button", { name: "저장 상태 확인" }).click();
  await expect(dialog.getByRole("heading", { name: "첫 OKR을 저장했어요" })).toBeVisible();
  expect(mock.saves()).toBe(1);
});

test("deep links stay in place and invited viewers can use the feature guide", async ({ page }) => {
  const mock = await setupMocks(page, initialOnboarding(), true);
  await page.goto("/?view=work");
  const dialog = page.getByRole("dialog", { name: "처음 시작하기", exact: true });
  await expect(page.getByRole("button", { name: "처음 설정 이어하기" })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "처음 설정 이어하기" }).click();
  await dialog.getByRole("radio", { name: /팀과 함께/ }).check();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await dialog.getByLabel("사용할 워크스페이스").selectOption("invited-team");
  await expect(dialog.getByText("이 공간은 읽기 전용이에요. 목표 작성 대신 기능 안내로 이어집니다.")).toBeVisible();
  await dialog.getByRole("button", { name: "다음", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "필요한 기능부터 시작해 보세요" })).toBeVisible();
  expect(mock.saves()).toBe(0);
  expect(mock.creates()).toBe(0);
});

test("setup keeps long answers readable with keyboard, themes, 4K and text zoom", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(120_000);
  const initial = initialOnboarding();
  initial.workspaceId = "workspace-1"; initial.workspaceName = "Personal"; initial.step = "goal";
  initial.draft.objective = "한글과 English 2026 목표를 함께 읽고 실제로 달성할 수 있도록 차근차근 실행하는 긴 제목";
  await setupMocks(page, initial);
  await page.goto("/");
  const panel = page.locator(".first-run-setup");
  await expect(panel).toBeVisible();
  for (const width of [320, 390, 768, 1440, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const size of ["100%", "200%"]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
      const box = await panel.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
      await expect(panel.getByLabel("이루고 싶은 목표", { exact: true })).toHaveValue(initial.draft.objective);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.screenshot({ path: info.outputPath(`setup-${width}.png`) });
  }
  for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    expect((await new AxeBuilder({ page: page as never }).include(".first-run-setup").withRules(["color-contrast"]).analyze()).violations, theme).toEqual([]);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "white"; });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  await page.evaluate(() => document.fonts.ready);
  const doc = await cdp.send("DOM.getDocument");
  for (const selector of [".setup-conversation h1", ".setup-toolbar > span:nth-child(2)"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  }
  await cdp.detach();
  await panel.getByRole("button", { name: "다음", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("heading", { name: "무엇을 보면 목표에 가까워졌다고 알 수 있을까요?" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
});
