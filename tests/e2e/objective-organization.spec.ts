import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { bootstrap, installApiMocks, json } from "./api-mocks";

function okrFile() {
  const objective = bootstrap.items.find(item => item.id === "objective-1")!;
  const kr = bootstrap.items.find(item => item.id === "kr-1")!;
  return { cycle: bootstrap.cycles[0], revision: "latest-revision", objectiveCount: 1, needsSplit: false, initiativeOptions: [], objective: {
    ...objective, clientId: objective.id, keyResults: [{ ...kr, clientId: kr.id,
      initiatives: bootstrap.items.filter(item => item.kind === "initiative").map(item => ({ ...item, clientId: item.id, linkedProjects: item.id === "initiative-1" ? [{ id: "project-1", title: "모바일 사용성 개선", parentId: item.id, cycleId: item.cycleId, taskCount: 1, canTrash: true, updatedAt: item.updatedAt }] : [] })),
    }],
  } };
}

async function fixture(page: Page) {
  await installApiMocks(page, { withRoutine: true, teamWorkspace: true, workspaceRole: "admin" });
  const writes: { path: string; method: string; data: Record<string, unknown> }[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") return route.fallback();
    const data = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};
    if (!["/api/account/marketing-consent", "/api/assistant-drafts"].includes(path)) writes.push({ path, method: request.method(), data });
    if (path === "/api/items" && request.method() === "PATCH") return json(route, { item: { ...bootstrap.items.find(item => item.id === data.id), ...data } });
    if (path === "/api/routines" && request.method() === "PATCH") return json(route, { routine: { id: data.id, title: "주간 점검", cadence: "weekly", active: true, properties: {}, ...data } });
    return route.fallback();
  });
  return writes;
}

test("OKR keeps its context beside a Project and Project edits save explicitly", async ({ page }, info) => {
  const writes = await fixture(page);
  await page.goto("/?view=okr&project=project-1");
  const panel = page.locator(".project-detail-panel");
  await expect(panel).toBeVisible();
  await expect(page.locator(".okr-file-read-surface")).toBeVisible();
  if (info.project.name === "desktop-chromium") {
    const geometry = await page.evaluate(() => ({ right: document.querySelector(".workspace")!.getBoundingClientRect().right, left: document.querySelector(".overlay-docked")!.getBoundingClientRect().left }));
    expect(Math.abs(geometry.right - geometry.left)).toBeLessThanOrEqual(1);
  }
  await panel.locator(".document-properties").getByRole("button", { name: "변경", exact: true }).click();
  const editor = page.locator(".document-properties-editor");
  await editor.getByLabel("Project 이름", { exact: true }).fill("저장 전 Project 초안");
  await editor.getByLabel("기한", { exact: true }).fill("2026-12-12");
  expect(writes).toEqual([]);
  await editor.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(writes.filter(write => write.path === "/api/items")).toEqual([{ path: "/api/items", method: "PATCH", data: { id: "project-1", title: "저장 전 Project 초안", dueDate: "2026-12-12" } }]);
});

test("Task edits preserve drafts on failure and admins can complete and archive", async ({ page }) => {
  const writes = await fixture(page);
  let fail = true;
  await page.route("**/api/items", route => route.request().method() === "PATCH" && fail ? json(route, { error: "save failed" }, 500) : route.fallback());
  await page.goto("/?view=okr&task=task-1");
  const panel = page.locator(".task-detail-panel");
  await expect(panel.getByRole("button", { name: "휴지통으로 이동", exact: true })).toBeVisible();
  await panel.locator(".document-properties").getByRole("button", { name: "변경", exact: true }).click();
  const editor = page.locator(".document-properties-editor");
  await editor.getByLabel("Task 이름", { exact: true }).fill("다시 입력하지 않을 Task");
  expect(writes).toEqual([]);
  await editor.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await expect(editor.getByLabel("Task 이름", { exact: true })).toHaveValue("다시 입력하지 않을 Task");
  fail = false;
  await editor.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await panel.getByRole("button", { name: "완료", exact: true }).click();
  await expect.poll(() => writes.some(write => write.data.status === "done")).toBe(true);
  await panel.getByRole("button", { name: "휴지통으로 이동", exact: true }).click();
  await page.getByRole("dialog", { name: "휴지통으로 이동", exact: true }).getByRole("button", { name: "휴지통으로 이동", exact: true }).click();
  await expect.poll(() => writes.some(write => write.path === "/api/item-trash")).toBe(true);
});

test("Objective editing organizes Projects without removing an Initiative and preserves an overwrite draft", async ({ page }) => {
  const writes = await fixture(page);
  let conflict = true;
  await page.route("**/api/okr-files/cycle-1", async route => {
    if (route.request().method() !== "PUT") return route.fallback();
    const data = route.request().postDataJSON();
    writes.push({ path: "/api/okr-files/cycle-1", method: "PUT", data });
    if (conflict) { conflict = false; return json(route, { error: "conflict", file: okrFile() }, 409); }
    return json(route, { file: { ...okrFile(), objective: data.objective } });
  });
  await page.goto("/?view=okr");
  await page.getByRole("button", { name: "파일 수정", exact: true }).click();
  await page.getByPlaceholder("이번 주기에 달성할 하나의 목표").fill("동시 수정 후에도 남는 목표");
  await page.getByRole("combobox", { name: "모바일 사용성 개선 Project 처리" }).selectOption("move:initiative-2");
  await page.getByRole("button", { name: "전체 저장", exact: true }).click();
  await expect(page.getByPlaceholder("이번 주기에 달성할 하나의 목표")).toHaveValue("동시 수정 후에도 남는 목표");
  await page.getByRole("button", { name: "내 변경사항으로 덮어쓰기", exact: true }).click();
  await expect(page.locator(".okr-file-editor")).toHaveCount(0);
  expect(writes.at(-1)?.data.expectedRevision).toBe("latest-revision");
  expect(writes.at(-1)?.data.projectResolutions).toEqual([{ projectId: "project-1", action: "move", targetInitiativeRef: "initiative-2" }]);
});

test("Routine exposes edit/delete actions and saves name, cadence and assignee together", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto("/?view=routines");
  await page.getByRole("button", { name: "Routine 수정", exact: true }).click();
  const editor = page.locator(".document-properties-editor");
  await editor.getByLabel("Routine 이름", { exact: true }).fill("주간 점검 수정");
  await editor.getByRole("combobox", { name: "반복 주기", exact: true }).selectOption("monthly");
  await editor.getByLabel("Routine 활성 상태", { exact: true }).uncheck();
  await editor.getByRole("combobox", { name: "담당자", exact: true }).selectOption("member-1");
  expect(writes).toEqual([]);
  await editor.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(writes.filter(write => write.path === "/api/routines")).toHaveLength(1);
  expect(writes[0].data).toMatchObject({ title: "주간 점검 수정", cadence: "monthly", active: false, assigneeMemberId: "member-1" });
  await expect(page.getByRole("button", { name: "Routine 삭제", exact: true })).toBeVisible();
});

test("Objective, KR and Initiative controls align across sizes, themes and larger text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(180_000);
  await fixture(page);
  for (const theme of ["white", "dark"]) for (const width of [320, 390, 768, 1440, 3840]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.addInitScript(theme => localStorage.setItem("okri.theme", theme), theme);
    await page.goto("/?view=okr");
    await page.getByRole("button", { name: "파일 수정", exact: true }).click();
    await page.getByPlaceholder("이 KR을 움직일 실행 방향").first().fill("긴 이니셔티브 제목과 실행 계획 Initiative 2026 ".repeat(3));
    for (const size of ["100%", "200%"]) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, size);
      const layout = await page.locator(".okr-file-editor").evaluate(node => ({ overflow: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - innerWidth,
        rows: [...node.querySelectorAll(".okr-file-initiative-editor")].map(row => [...row.querySelectorAll("select, .okr-file-row-tools button")].map(control => ({ height: control.getBoundingClientRect().height, top: control.getBoundingClientRect().top }))) }));
      expect(layout.overflow, `${theme}/${width}/${size}`).toBeLessThanOrEqual(1);
      expect(layout.page).toBeLessThanOrEqual(1);
      for (const row of layout.rows) {
        expect(Math.max(...row.map(control => control.height)) - Math.min(...row.map(control => control.height))).toBeLessThanOrEqual(1);
        expect(Math.abs(row[0].top - row[1].top)).toBeLessThanOrEqual(1);
      }
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    if (width === 1440) {
      await page.screenshot({ path: info.outputPath(`objective-editor-${theme}.png`), fullPage: true });
      const results = await new AxeBuilder({ page: page as never }).include(".okr-file-editor").analyze();
      expect(results.violations.filter(violation => violation.id === "color-contrast")).toEqual([]);
    }
  }
});
