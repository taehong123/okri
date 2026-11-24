import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { aggregatePerformance, type MeasurementRule, type ProjectVersion } from "../../lib/kr-performance-model";
import { installApiMocks, json } from "./api-mocks";
import { installKrDataMocks } from "./kr-data-mocks";

test("Data saves effective-dated rules and OKR shows the same period and Project results", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(120_000);
  await installApiMocks(page);
  const mock = await installKrDataMocks(page, { long: true });
  const kr = mock.state().keyResult;
  const asOf = "2026-11-20", effectiveDate = "2026-11-17", recordedAt = "2026-11-20T03:00:00Z";
  const targetRule: MeasurementRule = { source: "projects", input: "events", aggregation: "sum", period: "monthly",
    start: null, end: null, unit: "시간", baseline: 0, target: 100, direction: "increase", timezone: "Asia/Seoul" };
  let revision = 0;
  const projects: ProjectVersion[] = [];
  const writes: Record<string, unknown>[] = [];
  const updatedRule = () => ({ effectiveDate, recordedAt, value: targetRule, revision: 1 });
  const performance = (params: URLSearchParams) => aggregatePerformance({
    rules: revision ? [updatedRule()] : [], projects, entries: [], samples: [], stops: [],
  }, { asOf, grain: (params.get("grain") as "day" | "week" | "month") || "day", includeEstimates: params.get("includeEstimates") !== "false" },
  new Date(recordedAt));
  await page.route("**/api/kr-performance**", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      revision++;
      if (body.kind === "project") projects.push({ effectiveDate, recordedAt, revision, projectId: body.subjectId,
        value: { ...body.value, title: mock.state().projects[0].title, unit: "시간",
          calendar: { timezone: "Asia/Seoul", holidays: [], version: 0 } } });
      return json(route, { revision });
    }
    if (params.get("view") === "changes") return json(route, { changes: writes.map((body, i) => ({
      kind: body.kind, revision: i + 1, effectiveDate, recordedAt, reason: body.reason, before: null, after: body.value,
      affected: { from: effectiveDate, through: null, periods: [] },
    })), nextRevision: null });
    return json(route, { keyResult: kr, revision, timezone: "Asia/Seoul", asOf,
      configuration: { rules: revision ? [updatedRule()] : [], projects }, performance: performance(params) });
  });
  await page.route("**/api/kr-data-sources**", route => {
    if (!revision) return route.fallback();
    if (new URL(route.request().url()).searchParams.has("keyResultId")) return json(route, { ...mock.state(), performanceConfigured: true });
    const p = performance(new URLSearchParams())!;
    return json(route, { metrics: [{ keyResultId: kr.id, performance: true, mode: "projects", unit: "시간",
      currentValue: p.current.value, progress: p.current.progress, targetValue: p.rule.value.target,
      trend: p.points, isEstimate: p.current.hasEstimates }] });
  });

  await page.goto("/?view=data");
  const card = page.locator(".kr-data-card").filter({ has: page.getByRole("heading", { name: kr.title, exact: true }) });
  await card.getByRole("button", { name: "KR 데이터 설정" }).click();
  await page.getByRole("dialog", { name: "KR 데이터 설정", exact: true }).getByRole("button", { name: "성과 측정 설정" }).click();
  const form = page.getByRole("dialog", { name: "성과 측정 설정", exact: true });
  await form.getByLabel("적용 시작일").fill(effectiveDate);
  await form.getByLabel("단위", { exact: true }).fill("시간");
  await form.getByLabel("변경 사유").fill("운영 시작일에 맞춤");
  await form.getByRole("button", { name: "설정 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했습니다.");
  expect(writes[0].value).toMatchObject({ period: "monthly", aggregation: "sum", unit: "시간", target: 100 });
  await form.getByRole("button", { name: "Project 기여 규칙" }).click();
  await form.getByLabel("회당 기여량").fill("2");
  await form.getByLabel("운영 시작일").fill(effectiveDate);
  await form.getByLabel("산정 근거").fill("매일 처리 건수 × 건당 절감 시간");
  await form.getByLabel("변경 사유").fill("운영량 추정");
  await form.getByRole("button", { name: "설정 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했습니다.");
  expect(writes[1]).toMatchObject({ expectedRevision: 1, value: { mode: "daily", amount: 2, operating: true, isEstimate: true } });
  await form.getByRole("button", { name: "변경 이력" }).click();
  await form.getByText("#2 · Project 기여 규칙 · 2026-11-17", { exact: true }).click();
  await expect(form.getByText("운영량 추정", { exact: true })).toBeVisible();

  await page.goto("/?view=okr");
  const row = page.locator("#okr-search-kr-1");
  await expect(row.locator(".kr-trend-summary")).toHaveText("");
  const disclosure = row.locator(":scope > .okr-tree-kr-row");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  const graph = row.getByRole("region", { name: "KR 성과 추이" });
  await expect(graph).toContainText("6시간");
  await expect(graph).toContainText("100시간");
  await graph.getByText("Project별 기여 합계").click();
  await expect(graph.getByRole("list")).toContainText("6시간");
  await graph.getByLabel("집계 단위").selectOption("month");
  await expect(graph.locator(".kr-history-point")).toHaveCount(1);
  await graph.getByLabel("추정 포함").uncheck();
  await expect(graph.locator(".kr-inline-values b")).toHaveText("0시간");

  for (const width of [320, 390, 1440, 3840]) {
    await page.setViewportSize({ width, height: 900 });
    for (const size of ["100%", "200%"]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
      const box = await graph.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
      expect(box.scroll, width + " / " + size).toBeLessThanOrEqual(box.width + 1);
    }
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  for (const theme of ["white", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const axe = await new AxeBuilder({ page: page as never }).include(".kr-performance-chart").withRules(["color-contrast"]).analyze();
    expect(axe.violations, theme).toEqual([]);
  }
  await page.evaluate(() => document.fonts.ready);
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const dom = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: dom.root.nodeId, selector: ".kr-performance-chart b" });
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  await session.detach();
});

test("hour display settings persist on reload and the next daily value uses the same labels", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await installApiMocks(page);
  const mock = await installKrDataMocks(page, { configured: true });
  const kr = mock.state().keyResult;
  const project = mock.state().projects[0];
  const first = "2026-11-22";
  let asOf = "2026-11-23";
  let displaySettings: import("../../lib/kr-metric-display-format").MetricDisplaySettings =
    { mode: "default", increment: null, revision: 0, updatedAt: null };
  const rule: MeasurementRule = { source: "projects", input: "events", aggregation: "sum", period: "monthly",
    start: null, end: null, unit: "시간", baseline: 0, target: 100, direction: "increase", timezone: "Asia/Seoul" };
  const ruleVersion = { value: rule, effectiveDate: first, recordedAt: first + "T12:00:00Z", revision: 1 };
  const aggregate = () => {
    const entries = (asOf === "2026-11-23" ? [25.838095] : [25.838095, 23.85]).map((value, index) => ({
      id: "credit-" + index, date: index === 0 ? first : "2026-11-23", value, basis: "Test",
      projectId: project.id, title: project.title, unit: "시간", input: "events" as const, source: "projects" as const,
      recordedAt: asOf + "T01:00:00Z", isEstimate: false,
    }));
    return aggregatePerformance({ rules: [ruleVersion], entries, projects: [], samples: [], stops: [] }, {
      asOf, grain: "day", includeEstimates: true,
    }, new Date(asOf + "T02:00:00Z"))!;
  };
  await page.route("**/api/kr-metric-display**", route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({ keyResultId: kr.id, expectedRevision: displaySettings.revision });
      displaySettings = { mode: body.mode, increment: body.increment, revision: displaySettings.revision + 1, updatedAt: asOf };
    }
    return json(route, { settings: displaySettings });
  });
  await page.route("**/api/kr-data-sources**", route => {
    const value = aggregate();
    const metric = { keyResultId: kr.id, performance: true, mode: "projects", currentValue: value.current.value,
      unit: "시간", targetValue: 100, progress: value.current.progress, trend: value.points, displaySettings };
    return json(route, new URL(route.request().url()).searchParams.has("keyResultId")
      ? { ...mock.state(), performanceConfigured: true, displaySettings }
      : { metrics: [metric] });
  });
  await page.route("**/api/kr-performance**", route => json(route, {
    keyResult: kr, revision: 1, timezone: "Asia/Seoul", asOf,
    configuration: { rules: [ruleVersion], projects: [] }, performance: aggregate(),
  }));
  await page.route("**/api/project-contributions**", route => {
    if (!new URL(route.request().url()).searchParams.has("projectId")) return route.fallback();
    return json(route, { projectId: project.id, projectStatus: project.status, keyResult: kr, apiConnected: false,
      contribution: null, metric: null, displaySettings, performance: {
        start: "2026-11-01", end: "2026-11-30", unit: "시간", value: aggregate().current.value, isEstimate: false, operating: true,
      },
    });
  });
  const row = page.locator("#okr-search-kr-1");
  const openGraph = async () => {
    const graph = row.getByRole("region", { name: "KR 성과 추이" });
    if (!(await graph.isVisible())) await row.locator(":scope > .okr-tree-kr-row").press("Enter");
    await expect(graph).toBeVisible();
    return graph;
  };
  await page.goto("/?view=okr");
  let graph = await openGraph();
  await expect(graph.locator(".kr-inline-values b")).toHaveText("약 26시간");

  asOf = "2026-11-24";
  await page.reload();
  graph = await openGraph();
  await expect(graph.locator(".kr-inline-values b")).toHaveText("약 49.5시간");
  await expect(graph.getByText("전체 누적")).toContainText("약 49.5시간");
  await expect(graph.locator(".kr-history-point title").last()).toHaveText(/약 49\.5시간/);
  await graph.getByText("Project별 기여 합계").click();
  await expect(graph.getByRole("list")).toContainText("약 49.5시간");
  await expect(graph).not.toContainText("49.688095");

  await page.goto("/?view=work&project=project-1");
  const projectDetail = page.getByRole("dialog", { name: /Project 상세/ });
  await expect(projectDetail.getByText("약 49.5시간", { exact: true })).toBeVisible();

  await page.goto("/?view=data");
  const card = page.locator(".kr-data-card").filter({ has: page.getByRole("heading", { name: kr.title, exact: true }) });
  await expect(card.locator(".kr-data-progress")).toContainText("약 49.5시간");
  await card.getByRole("button", { name: "KR 데이터 설정" }).click();
  const settings = page.getByRole("dialog", { name: "KR 데이터 설정", exact: true });
  await settings.getByText("숫자 표시 설정", { exact: true }).click();
  await settings.getByLabel("표시 방식").selectOption("increment");
  await settings.getByLabel("반올림 단위", { exact: true }).fill("2");
  await settings.getByRole("button", { name: "표시 설정 저장" }).click();
  await expect(settings.getByRole("status").filter({ hasText: "저장했습니다." })).toBeVisible();
  await page.reload();
  await expect(card.locator(".kr-data-progress")).toContainText("약 50시간");
  await page.goto("/?view=okr");
  graph = await openGraph();
  await expect(graph.locator(".kr-inline-values b")).toHaveText("약 50시간");
  expect(aggregate().current.value).toBeCloseTo(49.688095, 8);
});
