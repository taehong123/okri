import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installApiMocks, json } from "./api-mocks";

const now = "2026-09-09T09:00:00.000Z";

async function fixture(page: Page, options: { connected?: boolean; viewer?: boolean } = {}) {
  await installApiMocks(page, { workspaceRole: options.viewer ? "viewer" : "owner" });
  const writes: Array<Record<string, unknown>> = [];
  let jobs: Array<Record<string, unknown>> = [];
  await page.route("**/api/local-agent/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/local-agent/devices") {
      if (request.method() === "DELETE") return json(route, { device: { id: "device-1", revokedAt: now } });
      return json(route, { devices: options.connected ? [{ id: "device-1", name: "개발 PC", platform: "win32-x64", lastSeenAt: now, revokedAt: null, online: true }] : [] });
    }
    if (url.pathname === "/api/local-agent/pairing" && request.method() === "POST") {
      writes.push({ action: "pair" });
      return json(route, { pairing: { id: "pairing-1", code: "ABCD-EFGH", expiresAt: "2026-09-09T09:10:00.000Z" } }, 201);
    }
    if (url.pathname === "/api/local-agent/pairing") return json(route, { pairing: { id: "pairing-1", status: "pending", deviceId: null, expiresAt: "2026-09-09T09:10:00.000Z" } });
    if (url.pathname === "/api/local-agent/jobs" && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      writes.push(payload);
      const job = { id: "job-1", deviceId: "device-1", targetKind: "task", targetId: "task-1", targetTitle: "오버레이 동작 점검", instruction: payload.instruction, status: "queued", progressText: null, resultText: null, errorText: null, createdAt: now, completedAt: null };
      jobs = [job];
      return json(route, { job }, 201);
    }
    if (url.pathname === "/api/local-agent/jobs") {
      jobs = jobs.map((job) => ({ ...job, status: "completed", resultText: "변경 파일 없음\n검증: 실행 계획 확인", completedAt: now }));
      return json(route, { jobs });
    }
    return json(route, {});
  });
  return writes;
}

test("Task offers an explicit one-time local runner setup without exposing a token", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  const writes = await fixture(page);
  await page.goto("/?view=inbox&task=task-1");
  const task = page.locator(".task-detail-panel");
  await task.getByRole("button", { name: "Codex에 맡기기" }).click();
  const dialog = page.locator(".local-agent-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("OKRI가 내 컴퓨터로 들어오지 않습니다.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "로컬 실행기 다운로드" })).toHaveAttribute("href", "/local-agent/okri-local-agent.mjs");
  await dialog.getByLabel("작업할 폴더").fill("C:\\work\\okri-client");
  await dialog.getByRole("button", { name: "연결 코드 만들기" }).click();
  await expect(dialog.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  const command = await dialog.locator("pre").textContent();
  expect(command).toContain("--code ABCD-EFGH");
  expect(command).toContain("C:\\work\\okri-client");
  expect(command).not.toContain("--token");
  expect(writes).toEqual([{ action: "pair" }]);
  expect((await new AxeBuilder({ page: page as never }).include(".local-agent-dialog").analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(task.getByRole("button", { name: "Codex에 맡기기" })).toBeFocused();
});

test("connected runner receives a Task and returns its result", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  const writes = await fixture(page, { connected: true });
  await page.goto("/?view=inbox&task=task-1");
  await page.getByRole("button", { name: "Codex에 맡기기" }).click();
  const dialog = page.locator(".local-agent-dialog");
  await expect(dialog.getByRole("combobox", { name: "실행할 컴퓨터" })).toContainText("개발 PC · 온라인");
  await dialog.getByLabel("할 일").fill("코드를 수정하지 말고 실행 계획만 작성해 주세요.");
  await dialog.getByRole("button", { name: "실행 요청" }).click();
  await expect.poll(() => writes.some((entry) => entry.targetId === "task-1" && entry.deviceId === "device-1")).toBe(true);
  await expect(dialog.getByText("변경 파일 없음", { exact: false })).toBeVisible();
  await expect(dialog.getByText("완료", { exact: true })).toBeVisible();
});

test("local runner dialog fits mobile and 200 percent text", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile-390");
  await fixture(page);
  await page.goto("/?view=inbox&task=task-1");
  await page.getByRole("button", { name: "Codex에 맡기기" }).click();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const dialog = page.locator(".local-agent-dialog");
  await expect(dialog).toBeVisible();
  const size = await dialog.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, right: element.getBoundingClientRect().right }));
  expect(size.scrollWidth - size.clientWidth).toBeLessThanOrEqual(1);
  expect(size.right).toBeLessThanOrEqual(391);
});

test("viewer cannot open local execution", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await fixture(page, { viewer: true });
  await page.goto("/?view=inbox&task=task-1");
  await expect(page.getByRole("button", { name: "Codex에 맡기기" })).toBeDisabled();
});
