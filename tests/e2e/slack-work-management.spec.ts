import { expect, test } from "@playwright/test";
import { installApiMocks } from "./api-mocks";

test("업무 생성 관리 봇은 생성 중심 흐름과 비공개 처리 정책을 표시한다", async ({ page }, info) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  await page.goto("/?settings=workspace&tab=integrations&bot=work");
  const dialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
  const rows = dialog.locator(".bot-accordion-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.locator(".bot-accordion-copy > b")).toHaveText(["데일리 봇", "관리 봇", "업무 생성 관리 봇", "Task 변동 알림 봇"]);
  await expect(rows.nth(2).getByText(/요청자에게만 표시/)).toBeVisible();
  for (const command of ["!업무생성", "@OKRI 만들 일 입력", "!도움말", "!내업무", "!프로젝트생성", "!프로젝트조회", "!프로젝트수정", "!프로젝트상태", "!테스크생성", "!테스크조회", "!테스크수정", "!테스크완료", "!테스크재열기"]) {
    await expect(rows.nth(2).getByText(command, { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("slack-work-management.png"), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("과거 Task 상태 규칙은 보존하지만 비활성 상태로만 표시한다", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  await page.route("**/api/slack/automations", (route) => route.fulfill({ json: {
    automations: [{ id: "legacy", name: "과거 막힘 규칙", triggerType: "task_status_changed", triggerStatus: "blocked", channelId: "C123", messageTemplate: "기존 문구", messageTemplateKind: "custom", supported: false, active: false, lastTriggeredAt: null, lastDeliveryStatus: "never", lastError: "", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }],
    deliveries: [], messageLanguage: "ko",
  } }));
  await page.goto("/?settings=workspace&tab=integrations&bot=automation");
  const rule = page.locator(".slack-automation-list article", { hasText: "과거 막힘 규칙" });
  await expect(rule).toContainText("현재 Task 상태 모델에서는 사용할 수 없음");
  await expect(rule.getByRole("button", { name: "테스트" })).toBeDisabled();
  await expect(rule.getByRole("button", { name: "활성화" })).toBeDisabled();
  await expect(rule.getByRole("button", { name: "수정" })).toBeEnabled();
});

test("기존 Slack 연결은 새 채널 메시지 권한이 없으면 재연결을 안내한다", async ({ page }) => {
  await installApiMocks(page, { slackState: "reauthorization_required", teamWorkspace: true });
  await page.goto("/?settings=workspace&tab=integrations&bot=work");
  await expect(page.getByRole("button", { name: /^업무 생성 관리 봇/ })).toContainText("권한 업데이트 필요");
  await expect(page.getByText("Slack 권한 업데이트가 필요합니다", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "권한 업데이트", exact: true })).toBeVisible();
});
