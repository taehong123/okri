import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installApiMocks, json } from "./api-mocks";


test("Google 인증 이메일 사용자는 전화 인증 없이 바로 시작한다", async ({ page }) => {
  let phoneRequestCount = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/account/phone/")) phoneRequestCount += 1;
  });
  await installApiMocks(page);
  await page.goto("/");
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.getByRole("heading", { name: "휴대전화 소유 확인" })).toHaveCount(0);
  expect(phoneRequestCount).toBe(0);
});


test.describe("개인 설정과 워크스페이스 관리 정보 구조", () => {
  test("데스크톱 사이드바는 워크스페이스 톱니바퀴와 개인 진입점만 제공한다", async ({ page, isMobile }) => {
    test.skip(isMobile);
    await installApiMocks(page, { teamWorkspace: true });
    await page.goto("/?view=okr");

    const sidebar = page.locator(".sidebar");
    const workspaceSettings = sidebar.locator(".workspace-settings-trigger");
    await expect(workspaceSettings).toBeVisible();
    await expect(sidebar.getByText("AI 연결", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("개인 앱 연동", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("팀 멤버", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("그룹 관리", { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText("내 설정", { exact: true })).toHaveCount(0);

    await workspaceSettings.click();
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await expect(settingsDialog).toBeVisible();
    for (const tab of ["일반", "멤버", "그룹", "Project 설정", "관리 요약", "자동화 봇", "위험 구역"]) {
      await expect(settingsDialog.getByRole("button", { name: new RegExp(`^${tab}`) })).toBeVisible();
    }
    await expect(settingsDialog.getByRole("button", { name: /^관리 봇/ })).toHaveCount(0);
    await expect(page).toHaveURL(/settings=workspace/);
    await settingsDialog.getByRole("button", { name: "워크스페이스 설정 닫기" }).click();
    await expect(page).not.toHaveURL(/settings=workspace/);

    await sidebar.locator(".profile-row").click();
    const personalDialog = page.getByRole("dialog", { name: "내 설정" });
    await expect(personalDialog.getByRole("heading", { name: "내 계정" })).toBeVisible();
    await expect(personalDialog.getByRole("heading", { name: "테마" })).toBeVisible();
    await expect(personalDialog.getByText("워크스페이스 삭제", { exact: false })).toHaveCount(0);
  });

  test("모바일은 상단과 더보기에서 같은 워크스페이스 설정 시트를 연다", async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await installApiMocks(page, { teamWorkspace: true });
    await page.goto("/?view=okr");

    await page.locator(".workspace-topbar").getByRole("button", { name: "워크스페이스 설정" }).click();
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.locator(".workspace-settings-panel")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await settingsDialog.getByRole("button", { name: "워크스페이스 설정 닫기" }).click();

    await page.getByRole("button", { name: "더보기", exact: true }).click();
    const moreDialog = page.getByRole("dialog", { name: "더보기 메뉴" });
    await expect(moreDialog.getByText("팀 멤버", { exact: true })).toHaveCount(0);
    await expect(moreDialog.getByText("그룹 관리", { exact: true })).toHaveCount(0);
    await expect(moreDialog.getByText("내 설정", { exact: true })).toHaveCount(0);
    await expect(moreDialog.locator(".mobile-account-entry")).toContainText("테스트 사용자");
    await moreDialog.getByRole("button", { name: "워크스페이스 설정" }).click();
    await expect(settingsDialog).toBeVisible();
  });

  test("Member의 워크스페이스 관리는 조회 전용으로 표시한다", async ({ page }) => {
    await installApiMocks(page, { teamWorkspace: true, workspaceRole: "member", slackState: "connected" });
    await page.goto("/?settings=workspace&tab=general");
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.getByText(/읽기 전용/)).toBeVisible();
    await expect(settingsDialog.getByRole("button", { name: /이미지 변경/ })).toHaveCount(0);
    await expect(settingsDialog.getByRole("button", { name: /^위험 구역/ })).toHaveCount(0);

    await settingsDialog.getByRole("button", { name: /^멤버/ }).click();
    await expect(settingsDialog.getByRole("button", { name: "멤버 초대" })).toHaveCount(0);
    await settingsDialog.getByRole("button", { name: /^자동화 봇/ }).click();
    await expect(settingsDialog.getByRole("button", { name: "Slack 연결 해제" })).toHaveCount(0);
    await settingsDialog.getByRole("button", { name: /^관리 봇/ }).click();
    await expect(settingsDialog.getByText(/관리 봇 설정은 읽기 전용/)).toBeVisible();
    await expect(settingsDialog.getByRole("button", { name: "설정 저장" })).toHaveCount(0);
    await expect(settingsDialog.getByRole("button", { name: "테스트 보내기" })).toHaveCount(0);
  });

  test("Owner는 관리 봇의 정보 부족·Urgency 신호를 선택해 Slack으로 시험 발송한다", async ({ page }) => {
    const patches: Record<string, unknown>[] = [];
    await installApiMocks(page, { teamWorkspace: true, slackState: "connected" });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/workspace-management-bot" && request.method() === "PATCH") {
        patches.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await page.goto("/?settings=workspace&tab=integrations&bot=management");

    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.getByRole("heading", { name: "자동화 봇" })).toBeVisible();
    await expect(settingsDialog.getByRole("button", { name: /^관리 봇/ })).toHaveAttribute("aria-expanded", "true");
    await settingsDialog.getByText("고급 설정", { exact: true }).click();
    for (const signal of ["기한 없음", "책임자·담당자 없음", "기한 초과", "어제 완료", "오늘 마감"]) {
      await expect(settingsDialog.getByText(signal, { exact: true }).first()).toBeVisible();
    }
    await settingsDialog.getByLabel("Slack 발송 채널").selectOption("C123");
    await settingsDialog.locator(".management-bot-toggle > label").click();
    await expect(settingsDialog.getByRole("checkbox", { name: "워크스페이스 관리 봇 사용" })).toBeChecked();
    await settingsDialog.getByRole("button", { name: "테스트 보내기" }).click();

    await expect.poll(() => patches.length).toBe(2);
    expect(patches[0]).toMatchObject({
      enabled: true,
      channelId: "C123",
      signals: ["missing_due_date", "missing_owner", "overdue", "completed_yesterday", "due_today"],
    });
    expect(patches[1]).toEqual({ action: "test" });
    await expect(page.getByText(/관리 리포트 테스트를 보냈습니다/)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("자동화 봇은 한 번에 하나만 펼치고 뒤로가기로 펼침 상태를 복원한다", async ({ page }) => {
    await installApiMocks(page, { teamWorkspace: true, slackState: "connected" });
    await page.goto("/?settings=workspace&tab=integrations");
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    const daily = settingsDialog.getByRole("button", { name: /^데일리 봇/ });
    const management = settingsDialog.getByRole("button", { name: /^관리 봇/ });
    const work = settingsDialog.getByRole("button", { name: /^업무 관리 봇/ });
    const automation = settingsDialog.getByRole("button", { name: /^Task 변동 알림 봇/ });
    await expect(daily).toHaveAttribute("aria-expanded", "false");
    await expect(management).toHaveAttribute("aria-expanded", "false");
    await expect(work).toHaveAttribute("aria-expanded", "false");
    await expect(automation).toHaveAttribute("aria-expanded", "false");
    await daily.click();
    await expect(daily).toHaveAttribute("aria-expanded", "true");
    await management.click();
    await expect(daily).toHaveAttribute("aria-expanded", "false");
    await expect(management).toHaveAttribute("aria-expanded", "true");
    await expect(page).toHaveURL(/bot=management/);
    await Promise.all([
      page.waitForURL(/bot=daily/),
      page.evaluate(() => window.history.back()),
    ]);
    await expect(daily).toHaveAttribute("aria-expanded", "true");
    await expect(management).toHaveAttribute("aria-expanded", "false");
  });

  test("관리 요약은 다섯 관리 그룹과 Project별 하위 Task 지연을 표시한다", async ({ page }) => {
    const summaryRequests: string[] = [];
    await installApiMocks(page, { teamWorkspace: true, slackState: "connected" });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workspace-management-bot" && url.searchParams.get("mode") === "summary") summaryRequests.push(url.href);
    });
    await page.goto("/?settings=workspace&tab=management");
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await expect(settingsDialog.getByRole("heading", { name: "관리 요약" })).toBeVisible();
    await expect(settingsDialog.getByRole("heading", { name: "자동화 봇" })).toHaveCount(0);
    for (const signal of ["기한 없음", "책임자·담당자 없음", "기한 초과", "어제 완료", "오늘 마감"]) {
      await expect(settingsDialog.getByText(signal, { exact: true })).toBeVisible();
    }
    await expect.poll(() => summaryRequests.length).toBe(1);
    const managementGroups = settingsDialog.locator(".management-summary-groups details");
    const missingDueGroup = managementGroups.nth(0);
    await missingDueGroup.locator("summary").click();
    await expect(missingDueGroup.getByText("모바일 사용성 개선", { exact: true })).toBeVisible();
    const overdueGroup = managementGroups.nth(2);
    await overdueGroup.locator("summary").click();
    const overdueProject = overdueGroup.locator(".management-summary-project", { hasText: "출시 준비" });
    await expect(overdueProject.getByText("Project 기한 초과", { exact: true })).toBeVisible();
    await expect(overdueProject.getByText("기한 초과 Task 1개", { exact: true })).toBeVisible();
    await expect(overdueProject.getByText("지난 기한 Task", { exact: true })).toBeVisible();
    await expect(overdueProject.getByText("Task 기한 초과", { exact: true })).toBeVisible();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(overdueProject.getByText("Project 기한 초과", { exact: true })).toBeVisible();
    expect(await settingsDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  });

  test("추천 자동화는 채널만 선택해 만들고 같은 규칙의 중복을 막는다", async ({ page }) => {
    let createCount = 0;
    await installApiMocks(page, { teamWorkspace: true, slackState: "connected" });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/slack/automations" && request.method() === "POST") createCount += 1;
    });
    await page.goto("/?settings=workspace&tab=integrations&bot=automation");
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await settingsDialog.getByLabel("Task 완료 알림 Slack 채널").selectOption("C123");
    const recommendation = settingsDialog.locator(".automation-recommendations article", { hasText: "Task 완료 알림" });
    await recommendation.getByRole("button", { name: "추가" }).click();
    await expect.poll(() => createCount).toBe(1);
    await recommendation.getByRole("button", { name: "추가" }).click();
    await expect(page.getByText(/규칙이 이미 있습니다/)).toBeVisible();
    expect(createCount).toBe(1);
  });

  test("개인 워크스페이스에는 팀 Slack 기반 관리 봇을 노출하지 않는다", async ({ page }) => {
    await installApiMocks(page, { teamWorkspace: false, slackState: "connected" });
    await page.goto("/?settings=workspace&tab=general");
    const settingsDialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
    await expect(settingsDialog.getByRole("button", { name: /^관리 봇/ })).toHaveCount(0);
    await expect(settingsDialog.getByRole("button", { name: /^자동화 봇/ })).toHaveCount(0);
  });
});

test.describe("개인 데일리와 팀 롤업", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto("/?view=scrum");
    await expect(page.locator(".daily-workspace")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("group", { name: "오늘 할 일" }).getByText("오늘 할 일", { exact: true }).click();
  });

  test("할당 Task 선택과 초안 저장은 Item API를 호출하지 않는다", async ({ page }) => {
    const itemMutations: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/items" && request.method() !== "GET") itemMutations.push(request.method());
    });
    await page.getByRole("checkbox", { name: "오버레이 동작 점검 선택", exact: true }).check();
    const saveRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/daily-scrum" && request.method() === "PUT");
    await page.getByRole("button", { name: "초안 저장" }).click();
    const payload = (await saveRequest).postDataJSON() as { selectedTaskIds: string[]; noPlannedTasks: boolean };
    expect(payload.selectedTaskIds).toEqual(["task-1"]);
    expect(payload.noPlannedTasks).toBe(false);
    expect(itemMutations).toEqual([]);
  });

  test("작성 중 초안은 내용 대신 상태만 공개한다", async ({ page }) => {
    const card = page.locator(".daily-member-card", { hasText: "초안 멤버" });
    await expect(card).toContainText("작성 중");
    await expect(card).toContainText("내용은 제출 후 공개됩니다");
    await expect(page.getByText("기존 공용 메모")).toBeHidden();
  });

  test("데일리 스킵 사유를 저장하고 공유 확정할 수 있다", async ({ page }) => {
    await expect(page.getByLabel("데일리 스킵 사유")).toHaveCount(0);
    await expect(page.getByLabel("데일리 스킵 상세 사유")).toHaveCount(0);
    await page.getByRole("checkbox", { name: "오늘은 데일리를 스킵합니다" }).check();
    await expect(page.getByLabel("데일리 스킵 사유")).toBeVisible();
    await expect(page.getByLabel("데일리 스킵 상세 사유")).toBeVisible();
    await page.getByLabel("데일리 스킵 사유").selectOption("other");
    await expect(page.getByLabel("데일리 스킵 상세 사유")).toHaveAttribute("required", "");
    await page.getByLabel("데일리 스킵 사유").selectOption("vacation");
    await page.getByLabel("데일리 스킵 상세 사유").fill("오후까지 휴가입니다.");
    await expect(page.getByRole("checkbox", { name: "오버레이 동작 점검 선택", exact: true })).toBeDisabled();
    const saveRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/daily-scrum" && request.method() === "PUT");
    await page.getByRole("button", { name: "초안 저장" }).click();
    const payload = (await saveRequest).postDataJSON() as { selectedTaskIds: string[]; noPlannedTasks: boolean; skipReason: string; skipNote: string };
    expect(payload).toMatchObject({ selectedTaskIds: [], noPlannedTasks: false, skipReason: "vacation", skipNote: "오후까지 휴가입니다." });
    const submitRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/daily-scrum/submit" && request.method() === "POST");
    await page.getByRole("button", { name: "스킵 확정 및 공유" }).click();
    await submitRequest;
  });

  test("확정된 스킵 사유만 팀 롤업에 공유한다", async ({ page }) => {
    await page.unroute("**/api/**");
    await installApiMocks(page, { skippedTeam: true });
    await page.reload();
    const card = page.locator(".daily-member-card", { hasText: "휴가 멤버" });
    await expect(card).toContainText("스킵");
    await expect(card).toContainText("개인 일정");
    await expect(card).toContainText("병원 일정");
  });

  test("DRI 무Task Project에서 명시적 Task 생성으로 진입한다", async ({ page }) => {
    await page.getByText("새 Task 추가", { exact: true }).click();
    await expect(page.getByLabel("새 Task 상위 항목")).toHaveValue("project:project-empty");
    await page.getByLabel("새 Task 제목").fill("새 실행 Task");
    const createRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/daily-scrum/tasks");
    await page.getByRole("button", { name: "Task 생성" }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ title: "새 실행 Task", parentKind: "project", parentId: "project-empty" });
  });

  test("390px에서 가로 넘침이 없고 핵심 컨트롤이 접근 가능하다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const results = await new AxeBuilder({ page: page as never }).include(".daily-workspace").analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("개인 앱 연동과 워크스페이스 자동화 봇", () => {
  test("개인 앱 연동에는 개인 Slack 설정만 표시한다", async ({ page }) => {
    await installApiMocks(page, { slackState: "workspace_disconnected", teamWorkspace: true });
    await page.goto("/?view=integrations");
    await expect(page).toHaveURL(/view=integrations/);
    await expect(page.getByRole("heading", { name: "개인 앱 연동" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Slack 개인 DM" })).toBeVisible();
    await expect(page.getByText("팀 연결 필요", { exact: true })).toBeVisible();
    await expect(page.getByText(/워크스페이스 설정의 자동화 봇/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Slack 연결" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "개인 앱 연동" })).toHaveCount(0);
  });

  test("개인 화면은 Slack 서비스 장애에서도 팀 관리 버튼을 노출하지 않는다", async ({ page }) => {
    await installApiMocks(page, { slackState: "service_unavailable", teamWorkspace: true });
    await page.goto("/?view=integrations");
    await expect(page.getByText("팀 연결 필요", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "다시 확인" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Slack 연결" })).toHaveCount(0);
  });

  test("Slack 관리자 승인과 중복 연결 오류는 워크스페이스 설정에서 안내한다", async ({ page }) => {
    await installApiMocks(page, { slackState: "workspace_disconnected", teamWorkspace: true });
    await page.goto("/?settings=workspace&tab=integrations&bot=daily&slack=slack_admin_approval_required");
    await expect(page.getByRole("button", { name: /^데일리 봇/ })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Slack 연결 후 데일리 봇을 설정할 수 있습니다")).toBeVisible();
    const oauthAlert = page.locator(".slack-service-card .integration-state-message[role='alert']");
    await expect(oauthAlert).toContainText("Slack 관리자 승인이 필요합니다");
    await expect(oauthAlert).toContainText("앱 설치 정책");
    await page.goto("/?settings=workspace&tab=integrations&slack=workspace_already_connected");
    await expect(oauthAlert).toContainText("이미 다른 OKRI 워크스페이스에 연결된 Slack입니다");
  });

  test("일반 멤버의 개인 앱 화면에는 개인 Slack DM 설정만 보인다", async ({ page }) => {
    await installApiMocks(page, { slackState: "connected", workspaceRole: "member", teamWorkspace: true });
    await page.goto("/?view=integrations");
    await expect(page.getByText("내 Slack 계정이 연결되었습니다")).toBeVisible();
    await expect(page.getByText("내 Slack DM 알림 사용")).toBeVisible();
    await expect(page.getByRole("heading", { name: "팀 공유 채널" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Slack 연결 해제" })).toHaveCount(0);
  });

  test("팀 Slack 연결과 공용 설정은 워크스페이스 설정에 표시한다", async ({ page }) => {
    await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
    await page.goto("/?settings=workspace&tab=integrations");
    await expect(page.getByRole("dialog", { name: "워크스페이스 설정" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "자동화 봇" })).toBeVisible();
    await expect(page.locator(".slack-service-card > header")).toContainText("고객 Slack A");
    await expect(page.locator(".slack-service-card .integration-status-badge")).toHaveText("연결 완료");
    await page.getByRole("button", { name: /^데일리 봇/ }).click();
    await expect(page.getByText("1명", { exact: true })).toBeVisible();
    await expect(page.locator(".slack-connected-summary dd", { hasText: "#daily" })).toBeVisible();
    await expect(page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true })).toBeVisible();
    await expect(page.getByText("멤버 연결·발송 관리")).toBeVisible();
    await expect(page.getByRole("heading", { name: "팀 공유 채널" })).toHaveCount(0);
  });

  test("워크스페이스 설정에서 팀 데일리 초기 설정을 완료한다", async ({ page }) => {
    await installApiMocks(page, { slackState: "setup_required", slackSetupComplete: false, teamWorkspace: true });
    await page.goto("/?settings=workspace&tab=integrations&bot=daily&slack=setup_required");
    await expect(page.getByRole("heading", { name: "데일리 설정" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "채널 공유 안 함" })).toBeVisible();
    await page.getByText("#daily", { exact: true }).click();
    const onboardingRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/slack/onboarding");
    await page.getByRole("button", { name: "변경사항 저장" }).click();
    expect((await onboardingRequest).postDataJSON()).toMatchObject({ weekdays: [1, 2, 3, 4, 5], reminderTime: "09:00", timezone: "Asia/Seoul", memberIds: ["member-1"], channelIds: ["C123"] });
    await expect(page.getByText("설치자 DM 테스트 생략")).toBeVisible();
    await expect(page.getByText("#daily 테스트 성공")).toHaveCount(0);
    await expect(page.locator(".slack-service-card > header")).toContainText("고객 Slack A");
    const metrics = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    expect(metrics.overflow).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page: page as never }).include(".workspace-settings-panel").analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("공통 오버레이", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto("/?view=work");
  });

  test("배경·Escape로 닫히고 포커스와 스크롤이 복원된다", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium");
    const trigger = page.getByRole("button", { name: "서비스 안내" });
    await trigger.click();
    const dialog = page.locator("dialog.overlay-dialog");
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await dialog.click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");

    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("변경된 폼은 버리기 확인을 거친다", async ({ page }) => {
    await page.getByRole("button", { name: "직접 추가", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "새 항목" });
    await createDialog.getByLabel("이름").fill("작성 중인 Project");
    await createDialog.getByRole("button", { name: "새 항목 닫기" }).click();

    const discardDialog = page.getByRole("alertdialog", { name: "변경사항을 버릴까요?" });
    await expect(discardDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(discardDialog).toBeHidden();
    await expect(createDialog.getByLabel("이름")).toHaveValue("작성 중인 Project");

    await createDialog.getByRole("button", { name: "새 항목 닫기" }).click();
    await discardDialog.getByRole("button", { name: "변경사항 버리기" }).click();
    await expect(createDialog).toBeHidden();
  });
});

test("상세 URL과 뒤로가기가 UI 상태를 복원한다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=work");
  await page.getByRole("button", { name: "모바일 사용성 개선", exact: true }).or(page.locator(".project-card-open").filter({ hasText: "모바일 사용성 개선" })).click();
  await expect(page).toHaveURL(/view=work.*project=project-1/);
  await expect(page.getByRole("dialog", { name: /모바일 사용성 개선 Project 상세/ })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/view=work/);
  await expect(page).not.toHaveURL(/project=/);

  await page.goto("/?view=work&project=missing");
  await expect(page).not.toHaveURL(/project=missing/);
  await expect(page.getByRole("alert")).toContainText("찾을 수 없");
});

test("저장 실패 시 가짜 Task나 허위 성공 메시지를 만들지 않는다", async ({ page }) => {
  await installApiMocks(page, { failItemCreate: true });
  await page.goto("/?view=inbox");
  await page.getByRole("button", { name: "직접 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 항목" });
  const title = dialog.getByLabel("이름");
  const container = dialog.getByLabel("연결 대상 · 선택 사항");
  await expect(container).toHaveValue("");
  await expect(container.locator("option:checked")).toHaveText("선택 안 함 — General에 저장");
  await title.fill("서버에 저장되지 않은 Task");
  await dialog.getByRole("button", { name: "만들기" }).click();
  await expect(dialog.getByRole("alert")).toContainText("항목을 만들지 못했습니다.");
  await expect(title).toHaveValue("서버에 저장되지 않은 Task");
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("연결할 Project·Routine이 없으면 직접 추가와 AI 추가 모두 General 안내를 표시한다", async ({ page }) => {
  await installApiMocks(page, { withoutTaskContainers: true, slowRoutineRefresh: true });
  await page.goto("/?view=inbox");

  await page.getByRole("button", { name: "직접 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 항목" });
  await expect(dialog.getByLabel("연결 대상 · 선택 사항")).toHaveCount(0);
  await expect(dialog.getByText("연결할 Project·Routine이 없어 General(기본)에 저장됩니다.", { exact: true })).toBeVisible();
  await dialog.getByLabel("이름").fill("General 저장 확인");
  await expect(dialog.getByRole("button", { name: "만들기" })).toBeEnabled();
  await dialog.getByRole("button", { name: "새 항목 닫기" }).click();
  await page.getByRole("alertdialog", { name: "변경사항을 버릴까요?" }).getByRole("button", { name: "변경사항 버리기" }).click();

  await page.getByRole("button", { name: "AI 대화로 추가", exact: true }).click();
  await page.getByRole("textbox", { name: "메시지" }).fill("AI로 Task를 정리해 주세요");
  await page.getByRole("button", { name: "메시지 보내기" }).click();
  await expect(page.getByLabel("Task 초안")).toHaveValue("AI로 정리된 Task");
  await expect(page.getByLabel("연결 대상 · 선택 사항")).toHaveCount(0);
  await expect(page.getByText("연결할 Project·Routine이 없어 General(기본)에 저장됩니다.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Task 1개 만들기" })).toBeEnabled();

  await page.goto("/?view=routines");
  await expect(page.getByText("Routine을 불러오는 중입니다", { exact: true })).toHaveCount(0);
  const generalCard = page.getByRole("article").filter({ hasText: "General" });
  await expect(generalCard).toContainText("General");
  await expect(generalCard.getByText("기본", { exact: true })).toBeVisible();
  await expect(generalCard).toContainText("Project·Routine에 연결하지 않은 Task가 모이는 기본 목록");
});

test("Project·Task·Routine 추가 진입과 AI 도우미를 같은 구조로 제공한다", async ({ page, isMobile }) => {
  await installApiMocks(page);
  const flows = [
    { view: "work", placeholder: "만들 Project의 결과와 범위를 설명해 주세요" },
    { view: "inbox", placeholder: "해야 할 일을 편하게 설명해 주세요" },
    { view: "routines", placeholder: "언제 무엇을 반복할지 설명해 주세요" },
  ];

  for (const flow of flows) {
    await page.goto(`/?view=${flow.view}`);
    const aiButton = page.getByRole("button", { name: "AI 대화로 추가", exact: true });
    const directButton = page.getByRole("button", { name: "직접 추가", exact: true });
    await expect(aiButton).toBeVisible();
    await expect(directButton).toBeVisible();
    if (isMobile) {
      expect((await aiButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect((await directButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await aiButton.click();
    const assistant = page.getByRole("region", { name: "AI 대화", exact: true });
    await expect(assistant).toBeVisible();
    await expect(assistant.getByPlaceholder(flow.placeholder)).toBeVisible();
    await expect(assistant.locator(".assistant-target-picker, .assistant-example, .chat-presets, .assistant-followups")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  }

  await page.goto("/?view=routines");
  await page.getByRole("button", { name: "직접 추가", exact: true }).click();
  const routineDialog = page.getByRole("dialog", { name: "새 Routine" });
  await expect(routineDialog.getByLabel("반복 주기")).toHaveValue("daily");
  await expect(routineDialog.getByLabel("Routine 담당자")).toHaveValue("");
  await expect(routineDialog.getByText("Initiative", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(routineDialog).toBeHidden();
});

test("AI 참고 항목 선택은 요청할 때만 열리고 검색과 Escape를 지원한다", async ({ page }) => {
  await installApiMocks(page, { teamWorkspace: true });
  await page.goto("/?view=okr");
  await page.getByRole("button", { name: "AI 대화", exact: true }).first().click();
  const assistant = page.getByRole("region", { name: "AI 대화", exact: true });
  const picker = assistant.locator(".assistant-target-picker");
  const trigger = assistant.getByRole("button", { name: "참고 항목 선택", exact: true });
  const message = assistant.getByRole("textbox", { name: "메시지", exact: true });
  await expect(picker).toHaveCount(0);
  await message.fill("진행 상황을 같이 검토해 주세요");
  await trigger.click();
  await expect(picker).toBeVisible();
  await picker.getByRole("textbox").fill("고객 경험");
  await expect(picker.locator(".assistant-target-options button")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(message).toHaveValue("진행 상황을 같이 검토해 주세요");
  await trigger.click();
  await picker.locator(".assistant-target-options button").click();
  await expect(picker).toHaveCount(0);
  await expect(assistant.locator(".assistant-message").last()).toContainText("고객 경험 개선");
});

test("Project 생성창 닫기는 현재 화면을 유지하고 AI 대화 초안은 다시 열린다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=work");

  await page.getByRole("button", { name: "직접 추가", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "새 항목" });
  await createDialog.getByRole("button", { name: "새 항목 닫기" }).click();
  await expect(createDialog).toBeHidden();
  await expect(page).toHaveURL(/view=work/);

  await page.getByRole("button", { name: "AI 대화로 추가", exact: true }).click();
  const assistant = page.getByRole("region", { name: "AI 대화", exact: true });
  await assistant.getByLabel("메시지", { exact: true }).fill("셀러 쇼핑몰 전체 오더 플로우 안정화 개발");
  await assistant.getByRole("button", { name: "메시지 보내기" }).click();
  await expect(assistant.getByLabel("Project", { exact: true })).toHaveValue("셀러 쇼핑몰 전체 오더 플로우 안정화 개발");
  await expect(assistant.getByText("임시저장됨")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const fieldsFit = await assistant.locator(".home-draft-fields input, .home-draft-fields select, .home-draft-fields textarea").evaluateAll((fields) => fields.every((field) => {
    const fieldBox = field.getBoundingClientRect();
    const panelBox = field.closest(".home-draft-fields")?.getBoundingClientRect();
    return Boolean(panelBox && fieldBox.left >= panelBox.left - 1 && fieldBox.right <= panelBox.right + 1);
  }));
  expect(fieldsFit).toBe(true);

  await page.getByRole("button", { name: "Project", exact: true }).first().click();
  await page.getByRole("button", { name: "AI 대화로 추가", exact: true }).click();
  const restoredAssistant = page.getByRole("region", { name: "AI 대화", exact: true });
  await expect(restoredAssistant.getByLabel("Project", { exact: true })).toHaveValue("셀러 쇼핑몰 전체 오더 플로우 안정화 개발");
  await expect(restoredAssistant.getByText("임시저장됨")).toBeVisible();
});

test("OKR 읽기 화면은 별도 파일 요청 없이 bootstrap 데이터로 즉시 열린다", async ({ page }) => {
  await installApiMocks(page);
  let attempts = 0;
  await page.route("**/api/okr-files/cycle-1**", async (route) => {
    attempts += 1;
    await json(route, { error: "일시적인 연결 오류" }, 503);
  });
  await page.goto("/?view=okr");
  await expect(page.getByRole("heading", { name: "2026 하반기" })).toBeVisible();
  await expect(page.getByText("OKR 파일을 불러오는 중")).toHaveCount(0);
  expect(attempts).toBe(0);
});

test("OKR 화면 재진입은 bootstrap 최신화 한 번만 공유하고 파일을 다시 요청하지 않는다", async ({ page }) => {
  await installApiMocks(page);
  let readRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/okr-files/cycle-1" && url.searchParams.get("mode") === "read" && request.method() === "GET") readRequests += 1;
  });
  await page.goto("/?view=okr");
  await expect(page.getByRole("heading", { name: "2026 하반기" })).toBeVisible();
  expect(readRequests).toBe(0);
  await page.getByRole("button", { name: "Project", exact: true }).first().click();
  await page.getByRole("button", { name: "OKR", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "2026 하반기" })).toBeVisible();
  await expect(page.getByText("OKR 파일을 불러오는 중")).toHaveCount(0);
  expect(readRequests).toBe(0);
});

test("모바일 Project 기본 보기는 카드이며 페이지가 가로로 넘치지 않는다", async ({ page, isMobile }) => {
  test.skip(!isMobile);
  await installApiMocks(page);
  await page.goto("/?view=work");
  await expect(page.getByRole("tab", { name: "카드" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("list", { name: "Project 카드 목록" })).toBeVisible();
  await expect(page.locator(".project-card .type-icon")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Project 필터" })).toContainText("필터");
  await expect(page.getByRole("button", { name: "Project 정렬" })).toContainText("정렬");
  await expect(page.getByRole("button", { name: "Project 속성 관리" })).toContainText("속성");
  await expect(page.getByRole("checkbox", { name: /Project .* 삭제 선택/ })).toHaveCount(0);
  await page.getByRole("button", { name: "선택", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Project .* 삭제 선택/ })).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("모바일 Task 완료 체크는 작게 보이고 삭제 선택은 선택 모드에서만 나타난다", async ({ page, isMobile }) => {
  test.skip(!isMobile);
  await installApiMocks(page);
  await page.goto("/?view=inbox");
  const completion = page.getByRole("button", { name: "오버레이 동작 점검 완료" });
  await expect(completion).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Task .* 삭제 선택/ })).toHaveCount(0);
  const visualSize = await completion.evaluate((element) => getComputedStyle(element, "::before").width);
  expect(visualSize).toBe("18px");
  const completionTarget = await completion.boundingBox();
  expect(completionTarget!.width).toBeGreaterThanOrEqual(44);
  expect(completionTarget!.height).toBeGreaterThanOrEqual(44);
  expect(await completion.evaluate((element) => getComputedStyle(element, "::before").borderRadius)).toBe("50%");
  await page.getByRole("button", { name: "선택", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Task .* 삭제 선택/ })).toHaveCount(1);
});

test("OKR은 파일 배너 없이 Objective부터 보여주고 목록 선택과 계층 탐색을 유지한다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=okr");
  const header = page.locator(".page-header");
  const surface = page.locator(".okr-file-read-surface");
  await expect(header.getByRole("heading")).toHaveText("OKR");
  await expect(header.getByRole("button")).toHaveText("목록보기");
  await expect(header.locator("p")).toHaveCount(0);
  await expect(surface.getByRole("heading").first()).toHaveText("고객 경험 개선");
  await expect(surface).not.toContainText("2026 하반기");
  await expect(surface.getByRole("button", { name: "Project 탭", exact: true })).toHaveCount(0);
  await header.getByRole("button", { name: "목록보기" }).click();
  await page.getByRole("button", { name: "2026 하반기 열기" }).click();
  await expect(page.getByRole("dialog", { name: "OKR 파일 목록" })).toHaveCount(0);
  await expect(surface.getByRole("heading").first()).toHaveText("고객 경험 개선");
  const kr = page.locator("button.okr-tree-kr-row").first();
  await kr.focus();
  await page.keyboard.press("Enter");
  await page.locator("button.okr-tree-initiative-row").first().click();
  await page.locator("button.okr-tree-project-main").first().click();
  await page.getByRole("button", { name: /오버레이 동작 점검/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(surface.getByRole("heading").first()).toHaveText("고객 경험 개선");
  await expect(kr).toHaveAttribute("aria-expanded", "true");
});

test("OKR 파일 정보와 O·KR·Initiative를 저장 한 번으로 수정한다", async ({ page }) => {
  await installApiMocks(page);
  let editRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/okr-files/cycle-1" && !url.search && request.method() === "GET") editRequests += 1;
  });
  await page.goto("/?view=okr");
  await page.getByRole("button", { name: "파일 수정" }).click();
  expect(editRequests).toBe(1);
  await page.getByLabel("파일명").fill("2026 통합 OKR");
  await page.getByPlaceholder("이번 주기에 달성할 하나의 목표").fill("고객이 첫날 핵심 가치를 경험한다");
  await page.getByPlaceholder("측정 가능한 핵심 결과").fill("첫날 활성화율을 60%로 높인다");
  const saveRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/okr-files/cycle-1" && request.method() === "PUT");
  await page.getByRole("button", { name: "전체 저장" }).click();
  const payload = (await saveRequest).postDataJSON() as { expectedRevision: string; metadata: { name: string }; objective: { title: string; keyResults: Array<{ title: string }> } };
  expect(payload.expectedRevision).toBe("test-revision");
  expect(payload.metadata.name).toBe("2026 통합 OKR");
  expect(payload.objective.title).toBe("고객이 첫날 핵심 가치를 경험한다");
  expect(payload.objective.keyResults[0].title).toBe("첫날 활성화율을 60%로 높인다");
});

test("새 OKR 파일은 저장 전에는 서버에 생성하지 않는다", async ({ page }) => {
  await installApiMocks(page);
  const creates: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/okr-files" && request.method() === "POST") creates.push(request.method());
  });
  await page.goto("/?view=okr");
  await page.getByRole("button", { name: "목록보기" }).click();
  await page.getByRole("button", { name: "새로 만들기" }).click();
  await page.getByLabel("파일명").fill("새 통합 OKR");
  await page.getByPlaceholder("이번 주기에 달성할 하나의 목표").fill("신규 목표");
  await page.getByPlaceholder("측정 가능한 핵심 결과").fill("신규 핵심 결과");
  expect(creates).toEqual([]);
  const createRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/okr-files" && request.method() === "POST");
  await page.getByRole("button", { name: "전체 저장" }).click();
  const payload = (await createRequest).postDataJSON() as { expectedRevision: null; objective: { keyResults: unknown[] } };
  expect(payload.expectedRevision).toBeNull();
  expect(payload.objective.keyResults).toHaveLength(1);
  expect(creates).toEqual(["POST"]);
});

test("Initiative 삭제 저장 전에 연결 Project 처리 결정을 요구한다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=okr");
  await page.getByRole("button", { name: "파일 수정" }).click();
  const initiative = page.locator(".okr-file-initiative-editor").filter({ hasText: "핵심 흐름 개편" });
  await initiative.getByRole("button", { name: "Initiative 삭제" }).click();
  await expect(page.getByText("연결 Project 정리 필요")).toBeVisible();
  await page.getByRole("button", { name: "전체 저장" }).click();
  await expect(page.getByRole("alert")).toContainText("이동 또는 휴지통 처리를 선택");
  await page.locator(".okr-project-resolutions label").filter({ hasText: "모바일 사용성 개선" }).locator("select").selectOption("move:initiative-2");
  const saveRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/okr-files/cycle-1" && request.method() === "PUT");
  await page.getByRole("button", { name: "전체 저장" }).click();
  await page.getByRole("dialog", { name: "OKR 파일 변경사항 저장" }).getByRole("button", { name: "전체 변경 저장" }).click();
  const payload = (await saveRequest).postDataJSON() as { projectResolutions: Array<{ projectId: string; action: string; targetInitiativeRef: string }> };
  expect(payload.projectResolutions).toEqual([{ projectId: "project-1", action: "move", targetInitiativeRef: "initiative-2" }]);
});

test("Viewer는 OKR 파일 전체 편집을 열 수 없다", async ({ page }) => {
  await installApiMocks(page, { workspaceRole: "viewer" });
  await page.goto("/?view=okr");
  await expect(page.getByRole("button", { name: "파일 수정" })).toHaveCount(0);
  await expect(page.getByRole("article")).toBeVisible();
});

test("KR과 Project 데이터는 각 대상 진행률만 갱신한다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=okr");
  const objectiveSurface = page.locator(".okr-file-read-objective");
  const keyResultSurface = page.locator(".okr-file-read-kr").first();
  await expect(objectiveSurface).not.toContainText("50%");
  await expect(keyResultSurface.locator(".okr-tree-progress")).toHaveText("45%");
  await expect(page.locator(".okr-file-read-initiative")).toHaveCount(0);
  await expect(page.locator(".okr-file-read-surface")).not.toContainText("할 일");
  await page.getByRole("button", { name: /활성 사용자 20% 증가/ }).click();
  await expect(page.locator(".okr-file-read-initiative")).toHaveCount(2);
  await page.getByRole("button", { name: /핵심 흐름 개편/ }).click();
  await expect(page.getByText("모바일 사용성 개선", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /모바일 사용성 개선.*Task.*1/ }).click();
  const taskDisclosure = page.getByRole("button", { name: /오버레이 동작 점검/ });
  await expect(taskDisclosure).toBeVisible();
  expect(await taskDisclosure.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator(".okr-file-read-surface")).not.toContainText("40%");

  await page.goto("/?view=data");
  await expect(page.getByRole("heading", { name: "데이터" })).toBeVisible();
  const krCard = page.locator(".kr-data-card").filter({ hasText: "활성 사용자 20% 증가" });
  const projectCard = page.locator(".kr-data-card").filter({ hasText: "모바일 사용성 개선" });
  await expect(krCard).toContainText("아직 연결된 데이터가 없습니다.");
  await krCard.getByRole("button", { name: "이 KR에 API 연결" }).click();
  let panel = page.getByRole("dialog", { name: "API 연결" });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await krCard.getByRole("button", { name: "이 KR에 API 연결" }).click();
  panel = page.getByRole("dialog", { name: "API 연결" });
  await panel.getByLabel("데이터 소스 이름").fill("활성 사용자 API");
  await panel.getByLabel("API URL").fill("https://api.example.com/metrics/active-users");
  await panel.getByLabel("숫자 값 경로").fill("data.value");
  await panel.getByLabel("목표값").fill("1000");
  await panel.getByRole("button", { name: "연결 저장" }).click();
  await expect(krCard).toContainText("활성 사용자 API");
  await krCard.getByRole("button", { name: "지금 업데이트" }).click();
  await expect(krCard).toContainText("60%");
  await expect(projectCard).toContainText("0%");

  await projectCard.getByRole("button", { name: "이 Project에 API 연결" }).click();
  panel = page.getByRole("dialog", { name: "API 연결" });
  await panel.getByLabel("데이터 소스 이름").fill("Project 품질 API");
  await panel.getByLabel("API URL").fill("https://api.example.com/metrics/project-quality");
  await panel.getByLabel("목표값").fill("100");
  await panel.getByRole("button", { name: "연결 저장" }).click();
  await projectCard.getByRole("button", { name: "지금 업데이트" }).click();
  await expect(projectCard).toContainText("35%");
  await expect(krCard).toContainText("60%");

  await page.goto("/?view=work");
  await page.getByRole("button", { name: "모바일 사용성 개선", exact: true }).or(page.locator(".project-card-open").filter({ hasText: "모바일 사용성 개선" })).click();
  await expect(page.locator(".project-linked-data")).toContainText("Project 품질 API");
});

test("핵심 화면은 axe 자동 접근성 검사에서 치명적 위반이 없다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=work");
  const results = await new AxeBuilder({ page: page as never }).analyze();
  expect(results.violations.filter((violation) => violation.impact === "critical" || violation.id === "color-contrast")).toEqual([]);
});

test("요금제 화면은 무료 5명과 모바일 페이지 스크롤을 제공한다", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=billing");
  await expect(page.getByRole("heading", { name: "Free 플랜" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "플랜 비교" })).toBeVisible();
  await expect(page.getByText("활성 편집자 5명", { exact: true })).toBeVisible();
  await expect(page.getByText("안전한 사전 배포 상태")).toHaveCount(0);
  await expect(page.getByText("결제는 아직 활성화하지 않았습니다")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /국내 카드 등록/ })).toHaveCount(0);
  const layout = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  const results = await new AxeBuilder({ page: page as never }).include(".billing-page").analyze();
  expect(results.violations.filter((violation) => violation.impact === "critical" || violation.id === "color-contrast")).toEqual([]);
});

test("초대 링크에서 워크스페이스를 확인한 뒤 명시적으로 가입한다", async ({ page }) => {
  await installApiMocks(page);
  const token = "a".repeat(64);
  await page.goto(`/#invite=${token}`);
  const dialog = page.getByRole("dialog", { name: "워크스페이스 초대" });
  await expect(dialog).toContainText("초대받은 워크스페이스");
  await expect(dialog).toContainText("ow***@example.com");
  const acceptRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/invitations/accept");
  await dialog.getByRole("button", { name: "이 워크스페이스에 가입" }).click();
  expect((await acceptRequest).postDataJSON()).toEqual({ token });
});
