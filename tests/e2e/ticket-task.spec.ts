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
  await page.addInitScript(() => {
    const state = window as unknown as { copiedText: string };
    state.copiedText = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { state.copiedText = text; } } });
  });
  await installApiMocks(page);
  await page.route(/\/api\/bootstrap(?:\?|$)/, (route) => json(route, { ...bootstrap, items: [...bootstrap.items, ticket, ticketTask] }));
  await page.route(/\/api\/clients(?:\?|$)/, (route) => json(route, { clients: [client] }));
  await page.route(/\/api\/ticket-client-links(?:\?|$)/, (route) => json(route, { links: [clientLink] }));
});

for (const theme of ["white", "dark"]) {
test(`Ticket 상태는 처리 대기로 생성하고 기존 접수와 구별해 수정한다 · ${theme}`, async ({ page }, info) => {
  let created: Record<string, unknown> | null = null;
  const patches: Array<Record<string, unknown>> = [];
  let saved = { ...ticket, id: "ticket-ready", status: "todo" };
  await page.route(/\/api\/items(?:\?|$)/, async (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(patch);
      saved = { ...saved, ...patch };
      return json(route, { item: saved });
    }
    if (route.request().method() !== "POST") return route.fallback();
    created = route.request().postDataJSON();
    saved = { ...saved, ...created };
    return json(route, { item: saved }, 201);
  });
  await page.addInitScript((mode) => localStorage.setItem("okri.theme", mode), theme);
  await page.goto("/?view=tickets");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.getByRole("button", { name: "Ticket 추가", exact: true }).click();
  const form = page.getByRole("dialog", { name: "새 항목", exact: true });
  const status = form.getByRole("combobox", { name: "상태", exact: true });
  await expect(status).toHaveValue("todo");
  await expect(status.locator("option")).toHaveText(["접수", "검토 중", "처리 대기", "처리 중", "종료"]);
  expect(created).toBeNull();
  await status.focus();
  await status.press("Home");
  await expect(status).toHaveValue("backlog");
  await status.selectOption("todo");
  const title = "처리하기로 결정했지만 아직 시작하지 않은 고객 요청 확인";
  await form.getByRole("textbox", { name: "이름", exact: true }).fill(title);
  await form.getByRole("button", { name: "만들기", exact: true }).click();
  await expect.poll(() => created).toMatchObject({ kind: "ticket", status: "todo", title });
  const row = page.getByRole("button", { name: new RegExp(title) });
  await expect(row).toContainText("처리 대기");
  await expect(page.getByRole("button", { name: /로그인 오류 문의/ })).toContainText("접수");
  await row.click();
  const detail = page.getByRole("dialog", { name: new RegExp(`${title} Ticket 상세`) });
  await detail.getByRole("button", { name: "변경", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "속성 편집", exact: true });
  const editStatus = editor.getByRole("combobox", { name: "상태", exact: true });
  await expect(editStatus).toHaveValue("todo");
  await editStatus.selectOption("backlog");
  await expect.poll(() => patches.at(-1)).toMatchObject({ status: "backlog" });
  await editStatus.selectOption("todo");
  await expect.poll(() => patches.at(-1)).toMatchObject({ status: "todo" });
  await expect(editStatus).toHaveValue("todo");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await editStatus.scrollIntoViewIfNeeded();
  await expect(editStatus).toBeVisible();
  await expect(editStatus).toBeInViewport();
  // Verify the changed editor rather than the scrollable workspace behind it.
  expect(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const bounds = await editStatus.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".document-properties-editor label > span" });
  const rendered = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(rendered.fonts.length).toBeGreaterThan(0);
  for (const font of rendered.fonts) {
    expect(font.isCustomFont).toBe(true);
    expect(font.familyName).toContain("Pretendard");
  }
  await cdp.detach();
  const contrast = await new AxeBuilder({ page: page as never }).include(".document-properties-editor").withRules(["color-contrast"]).analyze();
  expect(contrast.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("ticket-ready-status.png") });
});
}

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

test("외부 연동 가이드는 목적별 키를 한 번만 표시하고 복사·개별 폐기한다", async ({ page }) => {
  const clientSecret = "okri_client_test_secret";
  const mcpSecret = "okri_mcp_test_secret";
  let clientKeys: Array<Record<string, unknown>> = [];
  let mcpKeys: Array<Record<string, unknown>> = [];
  const now = "2026-09-22T07:00:00.000Z";
  await page.route(/\/api\/integration-tokens\/clients(?:\?|$)/, async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const connection = { id: "client-key-1", name: "고객 동기화", tokenPrefix: "okri_client...", createdAt: now, lastUsedAt: null };
      clientKeys = [connection];
      return json(route, { token: clientSecret, connection }, 201);
    }
    if (method === "DELETE") { clientKeys = []; return json(route, { revoked: 1, ids: ["client-key-1"] }); }
    return json(route, { keys: clientKeys });
  });
  await page.route(/\/api\/integration-tokens\/personal-mcp(?:\?|$)/, async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const payload = route.request().postDataJSON() as { access: "read" | "read_write" };
      const connection = { id: "mcp-key-1", name: "개인 MCP", tokenPrefix: "okri_mcp...", createdAt: now, lastUsedAt: null, access: payload.access };
      mcpKeys = [connection];
      return json(route, { token: mcpSecret, connection, access: payload.access }, 201);
    }
    if (method === "DELETE") { mcpKeys = []; return json(route, { revoked: 1, ids: ["mcp-key-1"] }); }
    return json(route, { keys: mcpKeys });
  });
  await page.route(/\/api\/integration-tokens(?:\?|$)/, (route) => json(route, { prompt: "OAuth로 OKRI MCP를 연결해 주세요." }, 201));

  await page.goto("/?view=tickets");
  await page.getByRole("tab", { name: "클라이언트 관리" }).click();
  await page.getByRole("button", { name: "외부 연동" }).click();
  let dialog = page.getByRole("dialog", { name: "외부 연동" });
  await expect(dialog.getByRole("tab", { name: "고객 API" })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "고객 API 키 생성" }).click();
  await expect(dialog.getByText(clientSecret, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "API 키 복사" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toBe(clientSecret);
  await dialog.getByRole("button", { name: "curl 전체 복사" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toContain(`Authorization: Bearer ${clientSecret}`);
  await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
  await dialog.getByRole("button", { name: "연결 문구 복사" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toContain("OAuth로 OKRI MCP");
  await dialog.getByText("OAuth 미지원 도구용 개인 MCP 키", { exact: true }).click();
  await dialog.getByRole("button", { name: "개인 MCP 키 생성" }).click();
  await expect(dialog.getByText(mcpSecret, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "연결 설정 복사" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toContain(`Authorization: Bearer ${mcpSecret}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedText: string }).copiedText)).toContain("워크스페이스: 테스트 워크스페이스");

  await dialog.getByRole("tab", { name: "고객 API" }).click();
  await dialog.getByRole("button", { name: "고객 동기화 키 폐기" }).click();
  const confirm = page.getByRole("dialog", { name: "연동 키 폐기" });
  await confirm.getByRole("button", { name: "키 폐기", exact: true }).click();
  await expect(dialog.getByText(clientSecret, { exact: true })).toBeHidden();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "외부 연동" }).click();
  dialog = page.getByRole("dialog", { name: "외부 연동" });
  await expect(dialog.getByText(clientSecret, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(mcpSecret, { exact: true })).toHaveCount(0);
});

test("외부 연동 가이드는 320px와 200% 텍스트에서 내부로 스크롤된다", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route(/\/api\/integration-tokens\/clients(?:\?|$)/, (route) => json(route, { keys: [] }));
  await page.route(/\/api\/integration-tokens\/personal-mcp(?:\?|$)/, (route) => json(route, { keys: [] }));
  await page.goto("/?view=tickets");
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.getByRole("tab", { name: "클라이언트 관리" }).click();
  await page.getByRole("button", { name: "외부 연동" }).click();
  const dialog = page.getByRole("dialog", { name: "외부 연동" });
  await expect(dialog.getByText("/api/integrations/clients/upsert", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const result = await new AxeBuilder({ page: page as never }).include(".client-integration-guide").analyze();
  expect(result.violations).toEqual([]);
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
