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
const client = {
  id: "client-1",
  externalCustomerId: null,
  name: "한결상사",
  phone: "010-1234-5678",
  email: "hello@example.com",
  sourceType: "api",
  sourceName: "Example CRM",
  sourceUrl: "https://crm.example.com/customers/client-1",
  sourceUpdatedAt: ticket.updatedAt,
  products: [{ id: "product-1", clientId: "client-1", externalProductId: null, name: "OKRI Business", source: "manual", createdAt: ticket.createdAt, updatedAt: ticket.updatedAt }],
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
};
const clientLink = { ticketId: ticket.id, clientId: client.id, productIds: [client.products[0].id], client };

test.beforeEach(async ({ page }) => {
  await installApiMocks(page);
  await page.route(/\/api\/bootstrap(?:\?|$)/, (route) => json(route, { ...bootstrap, items: [...bootstrap.items, ticket, ticketTask] }));
  await page.route(/\/api\/clients(?:\?|$)/, (route) => json(route, { clients: [client] }));
  await page.route(/\/api\/ticket-client-links(?:\?|$)/, (route) => json(route, { links: [clientLink] }));
});

test("Ticket 목록과 상세는 연결 Task를 같은 흐름에서 관리한다", async ({ page }) => {
  let createdPayload: Record<string, unknown> | null = null;
  let clientLinkPayload: Record<string, unknown> | null = null;
  await page.route(/\/api\/items(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createdPayload = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { item: { ...ticketTask, id: "ticket-task-new", title: createdPayload.title, assignments: [] } }, 201);
  });
  await page.route(/\/api\/ticket-client-links(?:\?|$)/, async (route) => {
    if (route.request().method() !== "PUT") return json(route, { links: [clientLink] });
    clientLinkPayload = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { link: { ...clientLink, productIds: [] } });
  });
  await page.goto("/?view=tickets");
  await expect(page.getByRole("heading", { name: "Ticket", exact: true })).toBeVisible();
  const row = page.getByRole("button", { name: /로그인 오류 문의/ });
  await expect(row).toContainText("접수");
  await expect(row).toContainText("0/1");
  await expect(page.getByText("한결상사", { exact: true })).toBeVisible();
  await expect(page.getByText("010-1234-5678", { exact: true })).toBeVisible();
  await expect(page.getByText("OKRI Business", { exact: true })).toBeVisible();
  await row.click();
  const detail = page.getByRole("dialog", { name: /로그인 오류 문의 Ticket 상세/ });
  await expect(detail.getByRole("combobox", { name: "고객" })).toHaveValue(client.id);
  await expect(detail.getByRole("checkbox", { name: /OKRI Business/ })).toBeChecked();
  await detail.getByRole("checkbox", { name: /OKRI Business/ }).uncheck();
  await detail.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => clientLinkPayload).not.toBeNull();
  expect(clientLinkPayload).toMatchObject({ ticketId: ticket.id, clientId: client.id, productIds: [] });
  await expect(detail.getByText("세션 만료 로그 확인", { exact: true })).toBeVisible();
  await detail.getByLabel("새 Task 제목").fill("재현 시나리오 작성");
  await detail.getByRole("button", { name: "추가", exact: true }).click();
  await expect.poll(() => createdPayload).not.toBeNull();
  expect(createdPayload).toMatchObject({ kind: "task", parentId: ticket.id, cycleId: null, title: "재현 시나리오 작성" });
  await expect(detail.getByText("재현 시나리오 작성", { exact: true })).toBeVisible();
});

test("클라이언트 관리에서 연락처와 반복 제품 행을 추가한다", async ({ page }) => {
  let createdPayload: Record<string, unknown> | null = null;
  await page.route(/\/api\/clients(?:\?|$)/, async (route) => {
    if (route.request().method() !== "POST") return json(route, { clients: [client] });
    createdPayload = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { client: { ...client, id: "client-new", ...createdPayload } }, 201);
  });
  await page.goto("/?view=tickets");
  await page.getByRole("tab", { name: "클라이언트 관리" }).click();
  await expect(page.getByText("한결상사", { exact: true })).toBeVisible();
  await expect(page.getByText("API · Example CRM", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "수동 등록" }).click();
  await expect(page.getByText("한결상사", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await page.getByRole("button", { name: "클라이언트 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "클라이언트 추가" });
  await dialog.getByLabel("고객명").fill("새 고객");
  await dialog.getByLabel("전화번호").fill("02-123-4567");
  await dialog.getByLabel("이메일").fill("new@example.com");
  await dialog.getByRole("button", { name: "제품 추가" }).click();
  await dialog.getByLabel("제품명 1").fill("Enterprise");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => createdPayload).not.toBeNull();
  expect(createdPayload).toMatchObject({ name: "새 고객", phone: "02-123-4567", email: "new@example.com", products: [{ name: "Enterprise" }] });
});

test("Ticket 화면은 모바일에서 가로로 깨지지 않고 접근 가능하다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=tickets");
  await expect(page.getByRole("button", { name: /로그인 오류 문의/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByText("한결상사", { exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page: page as never }).include(".ticket-area").analyze();
  expect(results.violations).toEqual([]);
});
