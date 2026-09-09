import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installApiMocks } from "./api-mocks";

test("Project and Routine are peer groups with only child Tasks selectable", async ({ page }, testInfo) => {
  await installApiMocks(page, { teamWorkspace: true });
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const title = "고객 인터뷰와 서비스 개선을 위한 긴 프로젝트 이름";
  const work = [
    { id: "routine-task-1", key: "task:routine-task-1", kind: "task", title: "Routine child Task", parentId: "routine-1", parentKind: "routine", parentTitle: "Store management", dueDate: null },
    { id: "project-1", key: "project:project-1", kind: "project", title, parentTitle: "서비스 품질 개선", dueDate: null },
    { id: "task-1", key: "task:task-1", kind: "task", title: "고객 인터뷰 진행", parentId: "project-1", parentKind: "project", parentTitle: title, dueDate: "2026-09-30" },
    { id: "routine-1", key: "routine:routine-1", kind: "routine", title: "고객 의견 점검", parentTitle: "Routine", dueDate: null },
  ];
  const yesterdayWork = [
    { id: "done-1", key: "task:done-1", kind: "task", title: "어제 완료한 인터뷰 정리", parentTitle: title, dueDate: "2026-09-03", completedYesterday: true, willCompleteOnSubmit: false },
    { id: "finish-1", key: "routine:finish-1", kind: "routine", title: "어제 회고 마감", parentTitle: "Routine", dueDate: null, completedYesterday: false, willCompleteOnSubmit: true },
  ];
  let draft = { id: null as string | null, date: "2026-09-04", yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: [] as string[], selectedWorkIds: [] as string[], selectedYesterdayWorkIds: ["task:done-1"] as string[] };
  await page.route(/\/api\/daily-scrum(?:\/|\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      if (path.endsWith("/submit")) return route.fulfill({ json: { submission: { id: "submitted" } } });
      expect(path).toBe("/api/daily-scrum"); draft = { ...draft, ...body, id: "draft" };
    }
    return route.fulfill({ json: { date: draft.date, draft, member: { id: "member-1", displayName: "테스트 사용자", role: "owner" }, candidates: { work, yesterdayWork, tasks: [], groups: [] }, createTargets: { projects: [], routines: [], allowGeneral: false }, team: [], latestSubmission: null, legacyWorkspaceNote: null } });
  });
  await page.goto("/?view=scrum");
  const picker = page.locator(".daily-task-picker").nth(1);
  await expect(picker).toBeVisible();
  await picker.getByRole("searchbox").fill("Store management");
  await expect(picker.getByRole("region", { name: "Store management", exact: true })).toBeVisible();
  await expect(picker.getByRole("checkbox", { name: /Store management/ })).toHaveCount(0);
  const routineHeading = picker.locator(".daily-project-heading h3").filter({ hasText: "Store management" });
  const routineTask = picker.locator(".daily-task-option").filter({ hasText: "Routine child Task" });
  const [headingBox, taskBox] = await Promise.all([routineHeading.boundingBox(), routineTask.locator("b").boundingBox()]);
  expect(taskBox!.x - headingBox!.x).toBeGreaterThanOrEqual(12);
  const hierarchy = await routineTask.evaluate((row) => ({
    border: getComputedStyle(row).borderInlineStartWidth,
    parentWeight: getComputedStyle(row.closest("section")!.querySelector("h3")!).fontWeight,
    taskWeight: getComputedStyle(row.querySelector("b")!).fontWeight,
  }));
  expect(hierarchy.border).toBe("1px");
  expect(Number(hierarchy.parentWeight)).toBeGreaterThan(Number(hierarchy.taskWeight));
  await picker.getByRole("searchbox").fill("");
  const boxes = picker.locator('input[type="checkbox"]');
  for (const box of await boxes.all()) await expect(box).not.toBeChecked();
  await expect(picker.getByRole("heading", { name: title })).toBeVisible();
  await expect(picker.getByRole("checkbox", { name: title + " 선택", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "고객 인터뷰 진행 선택", exact: true }).focus();
  await page.keyboard.press("Space");
  await picker.getByRole("checkbox", { name: /Routine child Task/ }).check();
  const yesterdayPicker = page.locator(".daily-task-picker").first();
  await yesterdayPicker.getByText("완료한 일", { exact: true }).click();
  await expect(yesterdayPicker.getByRole("checkbox", { name: /어제 회고 마감/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "새 Task 제목" })).toBeHidden();
  await page.getByRole("button", { name: "확정 및 공유", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0].body.selectedWorkIds).toEqual(["task:task-1", "task:routine-task-1"]);
  expect(writes[0].body.selectedYesterdayWorkIds).toEqual(["task:done-1"]);
  expect(writes[0].body.selectedTaskIds).toEqual(["task-1", "routine-task-1"]);
  expect(writes[1].path).toBe("/api/daily-scrum/submit");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  if (testInfo.project.name.startsWith("mobile-")) {
    const toolbar = page.locator(".scrum-toolbar");
    const [dateBox, actionsBox] = await Promise.all([toolbar.locator("label").boundingBox(), toolbar.locator(":scope > div").boundingBox()]);
    expect(Math.abs(dateBox!.x - actionsBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(dateBox!.width - actionsBox!.width)).toBeLessThanOrEqual(1);
    expect(actionsBox!.y).toBeGreaterThanOrEqual(dateBox!.y + dateBox!.height);
    const typography = await page.evaluate(() => ({
      pageDescription: getComputedStyle(document.querySelector(".page-header p")!).fontSize,
      taskTitle: getComputedStyle(document.querySelector(".daily-task-option b")!).fontSize,
      taskMeta: getComputedStyle(document.querySelector(".daily-task-option small")!).fontSize,
      navigation: getComputedStyle(document.querySelector(".mobile-navigation .nav-item span")!).fontSize,
    }));
    expect(parseFloat(typography.pageDescription)).toBeLessThan(parseFloat(typography.taskTitle));
    expect(parseFloat(typography.taskMeta)).toBeLessThan(parseFloat(typography.taskTitle));
    expect(parseFloat(typography.navigation)).toBeLessThan(parseFloat(typography.taskTitle));
    for (const button of await toolbar.locator("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: testInfo.outputPath("personal-daily.png"), fullPage: true });
});

test("a shared Daily enables reshare only after its content changes", async ({ page }) => {
  await installApiMocks(page, { teamWorkspace: true });
  const work = [
    { id: "task-a", key: "task:task-a", kind: "task", title: "고객 인터뷰", parentId: "project", parentKind: "project", parentTitle: "서비스 개선", dueDate: null },
    { id: "task-b", key: "task:task-b", kind: "task", title: "인터뷰 정리", parentId: "project", parentKind: "project", parentTitle: "서비스 개선", dueDate: null },
  ];
  let draft = { id: "draft", date: "2026-09-09", yesterdayNote: "", todayNote: "오늘 진행", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: ["task-a", "task-b"], selectedWorkIds: ["task:task-a", "task:task-b"], selectedYesterdayWorkIds: [] as string[] };
  const latestSubmission = { id: "submission-v1", memberId: "member-1", memberName: "테스트 사용자", memberEmail: "test@example.test", date: draft.date, version: 1,
    yesterdayNote: "", todayNote: "오늘 진행", blockersNote: "", noPlannedTasks: false, skipReason: null, skipNote: "", source: "web", submittedAt: "2026-09-09T01:00:00.000Z",
    tasks: work.map((task, index) => ({ id: `snapshot-${index}`, taskId: task.id, taskTitle: task.title, parentKind: "project", parentId: "project", parentTitle: "서비스 개선", status: "todo", isNew: false, sortOrder: index })), work: [], yesterdayWork: [] };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route(/\/api\/daily-scrum(?:\/|\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON(); writes.push({ path, body }); draft = { ...draft, ...body };
    } else if (path.endsWith("/submit")) {
      writes.push({ path, body: route.request().postDataJSON() });
      return route.fulfill({ json: { submission: { ...latestSubmission, id: "submission-v2", version: 2 } } });
    }
    return route.fulfill({ json: { date: draft.date, draft, member: { id: "member-1", displayName: "테스트 사용자", role: "owner" }, candidates: { work, yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [], routines: [], allowGeneral: false }, team: [], latestSubmission, legacyWorkspaceNote: null } });
  });

  await page.goto("/?view=scrum");
  await expect(page.getByText("항목을 추가하거나 빼고 다시 공유하면 기존 Slack 메시지가 업데이트됩니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "변경사항 없음", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "인터뷰 정리 선택", exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "수정 반영 및 다시 공유", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "수정 반영 및 다시 공유", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0]).toMatchObject({ path: "/api/daily-scrum", body: { selectedWorkIds: ["task:task-a"], selectedTaskIds: ["task-a"] } });
  expect(writes[1].path).toBe("/api/daily-scrum/submit");
});

test("submitted completed Tasks show their Project or Routine context", async ({ page }) => {
  await installApiMocks(page, { teamWorkspace: true });
  const submission = {
    id: "submission", memberId: "member-2", memberName: "완료한 구성원", memberEmail: "member@example.test", date: "2026-09-06", version: 1,
    yesterdayNote: "", todayNote: "", blockersNote: "", noPlannedTasks: false, skipReason: null, skipNote: "", source: "web", submittedAt: "2026-09-06T01:00:00.000Z", tasks: [], work: [],
    yesterdayWork: [
      { id: "project-task", key: "task:project-task", kind: "task", title: "고객 인터뷰 정리", parentKind: "project", parentId: "project", parentTitle: "서비스 개선", status: "done", priority: "medium", dueDate: null },
      { id: "routine-task", key: "task:routine-task", kind: "task", title: "주간 지표 입력", parentKind: "routine", parentId: "routine", parentTitle: "주간 운영", status: "done", priority: "medium", dueDate: null },
    ],
  };
  await page.route(/\/api\/daily-scrum(?:\?|$)/, (route) => route.fulfill({ json: {
    date: "2026-09-06", draft: { id: null, date: "2026-09-06", yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: [], selectedWorkIds: [], selectedYesterdayWorkIds: [] },
    member: { id: "member-1", displayName: "테스트 사용자", role: "owner" }, candidates: { work: [], yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [], routines: [], allowGeneral: true },
    team: [{ memberId: "member-2", displayName: "완료한 구성원", email: "member@example.test", role: "member", status: "submitted", slackConnected: true, submission }], latestSubmission: null, legacyWorkspaceNote: null,
  } }));
  await page.goto("/?view=scrum");
  const card = page.locator(".daily-member-card").filter({ hasText: "완료한 구성원" });
  await expect(card.getByText("Project · 서비스 개선", { exact: true })).toBeVisible();
  await expect(card.getByText("Routine · 주간 운영", { exact: true })).toBeVisible();
  const projectRow = card.locator(".daily-submission-work").filter({ hasText: "Project · 서비스 개선" });
  const [parentBox, childBox] = await Promise.all([projectRow.locator("small").boundingBox(), projectRow.locator(".daily-submission-task").boundingBox()]);
  expect(childBox!.x - parentBox!.x).toBeGreaterThanOrEqual(8);
  await expect(projectRow.locator(".daily-submission-task")).toHaveCSS("border-inline-start-width", "1px");
});

test("participant adds a personal Task within a Project and preserves the daily draft on retry", async ({ page }, testInfo) => {
  await installApiMocks(page, { teamWorkspace: true, workspaceRole: "member" });
  const projectTitle = "참여하는 프로젝트의 아주 긴 이름과 CustomerExperienceImprovement2026";
  const tasks = [{ id: "assigned-task", key: "task:assigned-task", kind: "task", title: "기존 내 Task", parentKind: "project", parentId: "assigned", parentTitle: "기존 프로젝트", dueDate: null }];
  let draft = { id: "draft", date: "2026-09-06", yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false, selectedTaskIds: [] as string[], selectedWorkIds: [] as string[], selectedYesterdayWorkIds: [] as string[] };
  const attempts: Array<{ title: string; requestId: string; parentId: string; parentKind: string }> = [];
  await page.route(/\/api\/daily-scrum(?:\/|\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/tasks")) {
      const body = route.request().postDataJSON(); attempts.push(body);
      expect(body.parentKind).toBe("project"); expect(body.parentId).toBe("participant");
      expect(draft.todayNote).toBe("고객에게 공유할 메모");
      expect(draft.selectedWorkIds).toEqual(["task:assigned-task"]);
      if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: "Task를 만들지 못했습니다." } });
      const task = { id: "new-task", key: "task:new-task", kind: "task", title: body.title, parentKind: "project", parentId: "participant", parentTitle: projectTitle, dueDate: null };
      tasks.push(task);
      draft = { ...draft, selectedTaskIds: [...draft.selectedTaskIds, task.id], selectedWorkIds: [...draft.selectedWorkIds, task.key] };
      return route.fulfill({ status: 201, json: { task } });
    }
    if (route.request().method() === "PUT") draft = { ...draft, ...route.request().postDataJSON() };
    return route.fulfill({ json: { date: draft.date, draft, member: { id: "member-1", displayName: "참여자", role: "member" },
      candidates: { work: tasks, yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [
        { id: "assigned", title: "기존 프로젝트", hasTasks: true }, { id: "participant", title: projectTitle, hasTasks: tasks.length > 1 },
      ], routines: [], allowGeneral: false }, team: [], latestSubmission: null, legacyWorkspaceNote: null } });
  });
  await page.goto("/?view=scrum");
  const picker = page.getByRole("group", { name: "오늘 할 일" });
  const project = picker.getByRole("region", { name: projectTitle, exact: true });
  await expect(project.getByText("아직 Task가 없습니다.")).toBeVisible();
  await expect(project.getByRole("checkbox")).toHaveCount(0);
  await picker.getByRole("checkbox", { name: "기존 내 Task 선택", exact: true }).check();
  await page.getByRole("textbox", { name: "오늘 메모", exact: true }).fill("고객에게 공유할 메모");
  const add = project.getByRole("button", { name: projectTitle + "에 Task 추가", exact: true });
  await add.click();
  const titleInput = project.getByRole("textbox", { name: "새 Task 제목", exact: true });
  await expect(titleInput).toBeFocused();
  await titleInput.press("Escape");
  await expect(titleInput).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(attempts).toHaveLength(0);
  await add.press("Enter");
  await titleInput.fill("내가 진행할 인터뷰 자료 정리");
  const create = project.getByRole("button", { name: "추가하고 오늘 할 일에 선택" });
  await create.click();
  await expect(page.getByRole("alert").filter({ hasText: "Task를 만들지 못했습니다." })).toBeVisible();
  await expect(project.getByRole("alert")).toContainText("입력한 내용으로 다시 시도할 수 있습니다.");
  await expect(titleInput).toHaveValue("내가 진행할 인터뷰 자료 정리");
  await project.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(project.getByRole("checkbox", { name: "내가 진행할 인터뷰 자료 정리 선택", exact: true })).toBeChecked();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].requestId).toBe(attempts[1].requestId);
  await expect(picker.getByRole("checkbox", { name: "기존 내 Task 선택", exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "오늘 메모", exact: true })).toHaveValue("고객에게 공유할 메모");
  await expect(titleInput).toHaveCount(0);
  await expect(project.getByRole("status")).toContainText("Task를 추가하고 오늘 할 일에 선택했습니다.");
  await expect(project.getByRole("status")).toBeFocused();
  await project.getByRole("button", { name: "추가 결과 닫기" }).press("Enter");
  await expect(add).toBeFocused();
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await add.click();
  await titleInput.fill("추가로 작성 중인 Task");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  for (const text of await picker.locator("h3, .daily-task-option b, .daily-task-option small").all()) {
    expect(await text.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const bounds = await text.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  for (const button of await project.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    const region = await project.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(region!.x + region!.width + 1);
  }
  expect((await new AxeBuilder({ page: page as never }).include(".daily-task-picker").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
  await project.screenshot({ path: testInfo.outputPath("participant-project.png") });
  await page.screenshot({ path: testInfo.outputPath("participant-task-create.png"), fullPage: true });
});

test("Slack identity diagnostics require explicit account selection and keep failed linking visible", async ({ page }, testInfo) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  let attempts = 0;
  await page.route("**/api/slack/members", async (route) => {
    if (route.request().method() === "POST") {
      attempts++;
      expect(route.request().postDataJSON()).toEqual({ action: "link", memberId: "member-2", slackUserId: "U2", confirmed: true });
      return route.fulfill({ status: 409, json: { error: "연결하지 못했습니다. 기존 연결은 유지됩니다." } });
    }
    return route.fulfill({ json: { members: [{ memberId: "member-2", displayName: "미연결 구성원", email: "member@example.test", reason: "email_not_found", message: "같은 이메일의 Slack 계정을 찾지 못했습니다." }], availableUsers: [{ id: "U2", displayName: "회사 Slack 구성원", email: "company@example.test" }] } });
  });
  await page.goto("/?settings=workspace&tab=integrations&bot=daily");
  await page.getByRole("button", { name: "Slack 멤버 연결 확인" }).click();
  await expect(page.getByText("같은 이메일의 Slack 계정을 찾지 못했습니다.")).toBeVisible();
  const select = page.getByRole("combobox", { name: "미연결 구성원 Slack 계정" });
  await expect(select).toHaveValue("");
  await expect(page.getByRole("button", { name: "계정 연결", exact: true })).toBeDisabled();
  await select.selectOption("U2");
  await page.getByRole("button", { name: "계정 연결", exact: true }).click();
  expect(attempts).toBe(0);
  await page.getByRole("button", { name: "확인 후 연결" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Slack 연결 상태를 확인하지 못했습니다." })).toBeVisible();
  await expect(select).toHaveValue("U2");
  expect(attempts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const contrast = await new AxeBuilder({ page: page as never }).include(".slack-member-repair").withRules(["color-contrast"]).analyze();
  expect(contrast.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("slack-member-repair.png"), fullPage: true });
  if (testInfo.project.name === "desktop-chromium") {
    await page.addInitScript(() => localStorage.setItem("okri.theme", "dark"));
    await page.goto("/?settings=workspace&tab=integrations&bot=daily");
    await page.getByRole("button", { name: "Slack 멤버 연결 확인" }).click();
    await expect(select).toBeVisible();
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page: page as never }).include(".slack-member-repair").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("slack-member-dark-zoom.png"), fullPage: true });
  }
});

test("personal daily light/dark, wide layout and text zoom use rendered Pretendard and accessible contrast", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  await installApiMocks(page, { teamWorkspace: true });
  for (const theme of ["white", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
    for (const width of [320, 768, 1920, 3840]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/?view=scrum");
      await expect(page.getByRole("group", { name: "오늘 할 일" })).toBeVisible();
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    const client = await context.newCDPSession(page);
    await client.send("DOM.enable"); await client.send("CSS.enable");
    const doc = await client.send("DOM.getDocument");
    const node = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".daily-task-picker b" });
    const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    expect(fonts.fonts.some((font) => font.glyphCount > 0 && /Pretendard/.test(font.familyName))).toBeTruthy();
    await client.detach();
    const result = await new AxeBuilder({ page: page as never }).include(".daily-task-picker").withRules(["color-contrast"]).analyze();
    expect(result.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("daily-" + theme + ".png"), fullPage: true });
  }
});
