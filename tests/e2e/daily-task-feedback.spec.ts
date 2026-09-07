import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installApiMocks } from "./api-mocks";

test("retry after a lost response confirms the stored Task without duplicating it", async ({ page }) => {
  await installApiMocks(page, { teamWorkspace: true });
  const tasks: Array<{ id: string; key: string; kind: string; title: string; parentId: string; parentKind: string; parentTitle: string }> = [];
  const requests: string[] = [];
  const draft = { id: "draft", date: "2026-09-06", yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: [] as string[], selectedWorkIds: [] as string[], selectedYesterdayWorkIds: [] };
  await page.route(/\/api\/daily-scrum(?:\/|\?|$)/, async (route) => {
    if (route.request().method() !== "GET") {
      expect(new URL(route.request().url()).pathname).toBe("/api/daily-scrum/tasks");
      const body = route.request().postDataJSON(); requests.push(body.requestId);
      if (!tasks.length) {
        tasks.push({ id: "persisted", key: "task:persisted", kind: "task", title: body.title, parentId: "project-1", parentKind: "project", parentTitle: "서비스 개선" });
        draft.selectedTaskIds.push("persisted"); draft.selectedWorkIds.push("task:persisted");
        return route.abort("failed");
      }
      return route.fulfill({ status: 201, json: { task: tasks[0] } });
    }
    return route.fulfill({ json: { date: draft.date, draft, member: { id: "member-1", displayName: "테스트 사용자", role: "owner" }, candidates: { work: tasks, yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [{ id: "project-1", title: "서비스 개선", hasTasks: Boolean(tasks.length) }], routines: [], allowGeneral: false }, team: [], latestSubmission: null, legacyWorkspaceNote: null } });
  });
  await page.goto("/?view=scrum");
  const picker = page.getByRole("group", { name: "오늘 할 일", exact: true });
  await picker.getByRole("button", { name: "서비스 개선에 Task 추가" }).click();
  const input = picker.getByRole("textbox", { name: "새 Task 제목" });
  await input.fill("실제로 저장된 Task");
  await picker.getByRole("button", { name: "추가하고 오늘 할 일에 선택", exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText("입력한 내용으로 다시 시도할 수 있습니다.");
  await expect(input).toHaveValue("실제로 저장된 Task");
  await expect(picker.locator(".daily-create-feedback")).toHaveCount(0);
  await input.fill("재시도 전에 변경한 입력");
  await picker.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(picker.getByRole("status")).toContainText("실제로 저장된 Task");
  await expect(picker.getByRole("status")).not.toContainText("재시도 전에 변경한 입력");
  await expect(picker.getByRole("checkbox", { name: "실제로 저장된 Task 선택", exact: true })).toBeChecked();
  expect(tasks).toHaveLength(1);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
});

test("Routine is a peer container and creates a selectable child Task", async ({ page }) => {
  await installApiMocks(page, { teamWorkspace: true });
  const routine = { id: "routine-1", key: "routine:routine-1", kind: "routine", title: "Store management", status: "todo", priority: "medium", parentTitle: "Routine", dueDate: null };
  const work: Array<Record<string, unknown>> = [routine];
  const draft = { id: "draft", date: "2026-09-06", yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: [] as string[], selectedWorkIds: [] as string[], selectedYesterdayWorkIds: [] };
  const requests: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/daily-scrum(?:\/|\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/tasks")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      const task = { id: "routine-task", key: "task:routine-task", kind: "task", title: body.title, status: "todo", priority: "medium", parentId: "routine-1", parentKind: "routine", parentTitle: "Store management", dueDate: null };
      work.push(task); draft.selectedTaskIds.push(task.id); draft.selectedWorkIds.push(task.key);
      return route.fulfill({ status: 201, json: { task } });
    }
    return route.fulfill({ json: { date: draft.date, draft, member: { id: "member-1", displayName: "Owner", role: "owner" }, candidates: { work, yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [], routines: [{ id: "routine-1", title: "Store management", hasTasks: work.length > 1 }], allowGeneral: false }, team: [], latestSubmission: null, legacyWorkspaceNote: null } });
  });
  await page.goto("/?view=scrum");
  const picker = page.locator(".daily-task-picker").nth(1);
  const group = picker.getByRole("region", { name: "Store management", exact: true });
  await expect(group).toBeVisible();
  await expect(group.locator('.daily-task-option input[type="checkbox"]')).toHaveCount(0);
  await group.locator("header .icon-button").click();
  await group.locator(".daily-project-create input").fill("Open store checklist");
  await group.locator('.daily-project-create button[type="submit"]').click();
  await expect(group.getByRole("checkbox", { name: /Open store checklist/ })).toBeChecked();
  expect(requests).toHaveLength(1);
  expect(requests[0].parentKind).toBe("routine");
  expect(requests[0].parentId).toBe("routine-1");
});

for (const theme of ["white", "dark"]) {
  test(`daily Task creation shows pending, selected and persistent success (${theme})`, async ({ page, context }, testInfo) => {
    await installApiMocks(page, { teamWorkspace: true });
    await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
    const taskTitle = "고객 인터뷰 결과와 CustomerExperienceImprovement2026 자료를 정리하고 팀에게 공유하기";
    const projectTitle = "서비스 개선 프로젝트";
    const tasks = [{ id: "existing", key: "task:existing", kind: "task", title: "기존 선택된 할 일", parentId: "project-1", parentKind: "project", parentTitle: projectTitle, dueDate: null }];
    const draft = { id: "draft", date: "2026-09-06", yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: ["existing"], selectedWorkIds: ["task:existing"], selectedYesterdayWorkIds: [] };
    let writes = 0;
    let refreshStarted = false;
    let releaseCreate!: () => void;
    let releaseRefresh!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    await page.route(/\/api\/daily-scrum(?:\/|\?|$)/, async (route) => {
      if (route.request().method() !== "GET") {
        expect(new URL(route.request().url()).pathname).toBe("/api/daily-scrum/tasks");
        writes++;
        const body = route.request().postDataJSON();
        expect(body.title).toBe(taskTitle);
        expect(body.requestId).toBeTruthy();
        await createGate;
        const task = { ...tasks[0], id: "created", key: "task:created", title: body.title };
        tasks.push(task); draft.selectedTaskIds.push(task.id); draft.selectedWorkIds.push(task.key);
        return route.fulfill({ status: 201, json: { task } });
      }
      if (writes) { refreshStarted = true; await refreshGate; }
      return route.fulfill({ json: { date: draft.date, draft, member: { id: "member-1", displayName: "테스트 사용자", role: "owner" }, candidates: { work: tasks, yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [{ id: "project-1", title: projectTitle, hasTasks: true }], routines: [], allowGeneral: false }, team: [], latestSubmission: null, legacyWorkspaceNote: null } });
    });
    await page.goto("/?view=scrum");
    const picker = page.getByRole("group", { name: "오늘 할 일", exact: true });
    const project = picker.getByRole("region", { name: projectTitle, exact: true });
    await picker.getByRole("searchbox").fill("기존 선택된");
    const add = project.getByRole("button", { name: `${projectTitle}에 Task 추가` });
    await add.click();
    const form = project.getByRole("form", { name: "Task 추가", exact: true });
    await form.getByRole("textbox", { name: "새 Task 제목" }).fill(taskTitle);
    const action = form.getByRole("button", { name: "추가하고 오늘 할 일에 선택", exact: true });
    const originalBounds = await action.boundingBox();
    await action.press("Enter");
    const pending = form.getByRole("button", { name: "추가하고 선택 중", exact: true });
    await expect(pending).toBeDisabled();
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(form.getByRole("status")).toHaveText("추가하고 선택 중");
    await expect(form.getByRole("textbox")).toBeDisabled();
    await expect(picker.getByRole("searchbox")).toBeDisabled();
    expect((await pending.boundingBox())!.width).toBeCloseTo(originalBounds!.width, 0);
    await form.evaluate((element) => { element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await expect.poll(() => writes).toBe(1);
    releaseCreate();
    await expect.poll(() => refreshStarted).toBe(true);
    await expect(pending).toBeVisible();
    await expect(project.locator(".daily-create-feedback")).toHaveCount(0);
    releaseRefresh();
    const feedback = project.getByRole("status");
    await expect(feedback).toBeFocused();
    await expect(feedback).toContainText(taskTitle);
    await expect(feedback).toContainText("Task를 추가하고 오늘 할 일에 선택했습니다.");
    await expect(picker.getByRole("searchbox")).toHaveValue("");
    const checkbox = project.getByRole("checkbox", { name: `${taskTitle} 선택`, exact: true });
    await expect(checkbox).toBeChecked();
    await expect(project.getByRole("checkbox", { name: "기존 선택된 할 일 선택", exact: true })).toBeChecked();
    await expect(picker.locator("summary small")).toHaveText("2개 선택");
    await expect(project.locator(".daily-task-option.is-selected")).toHaveCount(2);
    await expect(form).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "오늘 기한의 Task를 만들고" })).toHaveCount(0);
    expect(writes).toBe(1);
    await page.getByRole("textbox", { name: "오늘 메모", exact: true }).fill("다음 입력을 해도 결과 유지");
    await expect(feedback).toBeVisible();
    await project.screenshot({ path: testInfo.outputPath(`created-${theme}.png`) });
    await page.evaluate(() => document.fonts.ready);
    if (testInfo.project.name === "desktop-chromium") {
      const client = await context.newCDPSession(page);
      await client.send("DOM.enable"); await client.send("CSS.enable");
      const doc = await client.send("DOM.getDocument");
      const node = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".daily-create-feedback b" });
      const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
      expect(fonts.fonts.every((font) => !font.glyphCount || /Pretendard/.test(font.familyName))).toBeTruthy();
      await client.detach();
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    for (const text of await feedback.locator("b, span").all()) expect(await text.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    if (testInfo.project.name.startsWith("mobile")) {
      const available = await feedback.evaluate((node) => node.clientWidth - parseFloat(getComputedStyle(node).paddingLeft) - parseFloat(getComputedStyle(node).paddingRight));
      expect((await feedback.locator("b").boundingBox())!.width).toBeGreaterThanOrEqual(available - 1);
    }
    expect((await new AxeBuilder({ page: page as never }).include(".daily-task-picker").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
    await feedback.screenshot({ path: testInfo.outputPath(`created-zoom-${theme}.png`) });
    await checkbox.uncheck();
    await expect(project.locator(".daily-create-feedback")).toHaveCount(0);
    await expect(checkbox).not.toBeChecked();
    await expect(picker.locator("summary small")).toHaveText("1개 선택");
    expect(writes).toBe(1);
  });
}
