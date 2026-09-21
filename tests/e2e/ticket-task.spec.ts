import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks, json } from "./api-mocks";

const ticket = {
  ...bootstrap.items[3],
  id: "ticket-1",
  kind: "ticket",
  cycleId: null,
  parentId: null,
  title: "로그인 오류 문의",
  description: "고객이 간헐적으로 로그인 화면으로 돌아갑니다.",
  status: "backlog",
  progress: 0,
  assignments: [],
};
const ticketTask = {
  ...bootstrap.items[4],
  id: "ticket-task-1",
  cycleId: null,
  parentId: ticket.id,
  title: "세션 만료 로그 확인",
};

test.beforeEach(async ({ page }) => {
  await installApiMocks(page);
  await page.route(/\/api\/bootstrap(?:\?|$)/, (route) => json(route, { ...bootstrap, items: [...bootstrap.items, ticket, ticketTask] }));
});

test("Ticket 목록과 상세는 연결 Task를 같은 흐름에서 관리한다", async ({ page }) => {
  let createdPayload: Record<string, unknown> | null = null;
  await page.route(/\/api\/items(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createdPayload = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { item: { ...ticketTask, id: "ticket-task-new", title: createdPayload.title, assignments: [] } }, 201);
  });
  await page.goto("/?view=tickets");
  await expect(page.getByRole("heading", { name: "Ticket", exact: true })).toBeVisible();
  const row = page.getByRole("button", { name: /로그인 오류 문의/ });
  await expect(row).toContainText("접수");
  await expect(row).toContainText("0/1");
  await row.click();
  const detail = page.getByRole("dialog", { name: /로그인 오류 문의 Ticket 상세/ });
  await expect(detail.getByText("세션 만료 로그 확인", { exact: true })).toBeVisible();
  await detail.getByLabel("새 Task 제목").fill("재현 시나리오 작성");
  await detail.getByRole("button", { name: "추가", exact: true }).click();
  await expect.poll(() => createdPayload).not.toBeNull();
  expect(createdPayload).toMatchObject({ kind: "task", parentId: ticket.id, cycleId: null, title: "재현 시나리오 작성" });
  await expect(detail.getByText("재현 시나리오 작성", { exact: true })).toBeVisible();
});

test("Ticket 화면은 모바일에서 가로로 깨지지 않고 접근 가능하다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=tickets");
  await expect(page.getByRole("button", { name: /로그인 오류 문의/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const results = await new AxeBuilder({ page: page as never }).include(".ticket-workspace").analyze();
  expect(results.violations).toEqual([]);
});
