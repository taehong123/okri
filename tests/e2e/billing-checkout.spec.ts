import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { bootstrap, installApiMocks, json } from "./api-mocks";

function billingFixture() {
  return {
    plan: "free", planLabel: "Free", seatPriceWon: 0, monthlyPriceWon: 0, billableEditors: 3,
    status: "free", nextPlan: null, trialEndsAt: null, currentPeriodEndsAt: null,
    nextBillingAt: null, cancelAtPeriodEnd: false, graceEndsAt: null,
    usage: { projects: { used: 4, limit: 30, remaining: 26, resetsAt: "2099-10-01T00:00:00Z" },
      editors: { used: 3, limit: 5, remaining: 2, enforced: false, graceEndsAt: null },
      ai: { usedPercent: 24, remainingPercent: 76, resetsAt: "2099-10-01T00:00:00Z" },
      storage: { usedBytes: 26_214_400, limitBytes: 104_857_600, remainingBytes: 78_643_200 } },
    editorMembers: [], paymentMethod: null, transactions: [], canManage: true, enforcementEnabled: false, checkoutAvailable: true,
    providers: { payple: false, paypal: [{ plan: "team", currency: "USD", value: "9.00" }, { plan: "business", currency: "USD", value: "39.00" }] },
    paypal: null, paypalTransactions: [],
  };
}

async function installBilling(page: Page, language = "ko", status = billingFixture()) {
  await installApiMocks(page, { preserveStorage: true });
  await page.route("**/api/bootstrap?**", (route) => json(route, { ...bootstrap,
    user: { ...bootstrap.user, preferences: { language, resolvedLanguage: language, revision: 1 } } }));
  await page.route("**/api/billing/status", (route) => json(route, status));
}

test("pricing table shows per-editor prices and the current workspace total", async ({ page }, info) => {
  await installBilling(page, "ko", { ...billingFixture(), providers: { payple: true, paypal: [] } });
  await page.goto("/?view=billing");
  const pricing = page.locator(".billing-plans-section");
  await expect(pricing.getByText("추천 플랜", { exact: true })).toBeVisible();
  await expect(pricing).toContainText("2,900원");
  await expect(pricing).toContainText("2,900원 × 3명 = 8,700원/월");
  await expect(pricing).toContainText("4,900원 × 3명 = 14,700원/월");
  await expect(pricing).toContainText("ChatGPT·Claude와 제한 없이 사용");
  await expect(pricing).toContainText("이미지 저장 공간 100MB");
  await expect(page.locator(".billing-usage-section")).toContainText("25MB / 100MB");
  await pricing.getByRole("button", { name: "Business 플랜 선택", exact: true }).click();
  await expect(pricing.locator(".billing-plan-card.selected")).toContainText("Business");
  await expect(page.locator(".billing-checkout-summary")).toContainText("4,900원 × 3명 = 14,700원/월");
  await pricing.screenshot({ path: info.outputPath("pricing-desktop.png") });
});

test("Payple sends the displayed quote and closing the mocked SDK never registers a card", async ({ page }) => {
  await installBilling(page, "ko", { ...billingFixture(), providers: { payple: true, paypal: [] } });
  let quote: unknown;
  let registrationCalls = 0;
  await page.route("**/api/billing/payple/session", async route => {
    quote = route.request().postDataJSON();
    await json(route, { sessionToken: "mock-session", clientKey: "mock-public-key",
      authUrl: "https://democpay.payple.kr/js/v1/payment.js", returnUrl: "/api/billing/payple/result" }, 201);
  });
  await page.route("https://democpay.payple.kr/js/v1/payment.js", route => route.fulfill({
    contentType: "application/javascript",
    body: 'window.PaypleCpayAuthCheck = options => options.callbackFunction({ PCD_PAY_RST: "close" });',
  }));
  await page.route("**/api/billing/payple/result", async route => { registrationCalls++; await json(route, {}, 400); });
  await page.goto("/?view=billing");
  const checkout = page.locator(".billing-checkout");
  const pay = checkout.getByRole("button", { name: "국내 카드 등록하고 30일 체험", exact: true });
  await expect(pay).toBeDisabled();
  await checkout.getByRole("checkbox").check();
  await pay.click();
  await expect(pay).toBeEnabled();
  expect(quote).toEqual({ plan: "team", contractAccepted: true, seats: 3, priceWon: 8700 });
  expect(registrationCalls).toBe(0);
});

test("PayPal checkout requires explicit consent, sends the displayed price and preserves state on failure", async ({ page }) => {
  await installBilling(page);
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/billing/paypal/checkout", async (route) => {
    body = route.request().postDataJSON();
    await json(route, { code: "billing_price_changed" }, 409);
  });
  await page.goto("/?view=billing");
  const panel = page.locator(".billing-paypal-section");
  const pay = panel.getByRole("button", { name: "PayPal로 결제", exact: true });
  await expect(pay).toBeDisabled();
  await expect(panel).toContainText("USD 9.00");
  await panel.getByRole("checkbox").check();
  await expect(pay).toBeEnabled();
  await pay.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("요금이 변경되었습니다. 화면을 새로고침한 뒤 확인해 주세요.", { exact: true })).toBeVisible();
  expect(body).toEqual({ plan: "team", currency: "USD", value: "9.00", seats: 3, contractAccepted: true });
  await expect(panel.getByRole("checkbox")).toBeChecked();
  await expect(pay).toBeEnabled();
  await expect(page.locator(".billing-page")).not.toContainText("운영 보안값");
});

test("Payple checkout navigates only to the configured merchant bridge", async ({ page }) => {
  await installBilling(page, "en", { ...billingFixture(), providers: { payple: true, paypal: [] } });
  const token = "11111111-1111-4111-8111-111111111111";
  await page.route("**/api/billing/payple/session", route => json(route, {
    sessionToken: token, bridgeUrl: `https://mamuree.com/api/public/payple/okri/bridge#${token}`,
  }, 201));
  await page.route("https://mamuree.com/api/public/payple/okri/bridge?**", route => route.fulfill({
    contentType: "text/html", body: "<h1>Mock card registration</h1>",
  }));
  await page.goto("/?view=billing");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator(".billing-checkout input[type=checkbox]").check();
  await page.locator(".billing-checkout > button").click();
  await expect(page.getByRole("heading", { name: "Mock card registration" })).toBeVisible();
  const url = new URL(page.url());
  expect(url.origin).toBe("https://mamuree.com");
  expect(url.hash).toBe("#" + token);
  expect(url.searchParams.get("lang")).toBe("en-US");
});

test("checkout failure remains readable in all themes and at enlarged mobile text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(180_000);
  await installBilling(page, "ko", { ...billingFixture(), providers: { payple: true, paypal: [] } });
  await page.route("**/api/billing/payple/session", route => json(route, { error: "unknown diagnostic" }, 403));
  for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.goto("/?view=billing");
    await page.evaluate(value => localStorage.setItem("okri.theme", value), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      await page.locator(".billing-checkout input[type=checkbox]").check();
      await page.locator(".billing-checkout > button").click();
      const toast = page.locator(".toast-error");
      await expect(toast).toContainText("카드 등록을 시작하지 못했습니다.");
      const axe = await new AxeBuilder({ page: page as never }).include(".toast-error").analyze();
      expect(axe.violations.filter(v => v.id === "color-contrast" || v.impact === "critical"), `${theme} ${width}`).toEqual([]);
      const box = await toast.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await toast.screenshot({ path: info.outputPath(`error-${theme}-${width}.png`) });
      await toast.getByRole("button").focus();
      await page.keyboard.press("Enter");
      await expect(toast).toHaveCount(0);
    }
  }
});

test("a provider return verifies only the authenticated workspace and never trusts URL subscription IDs", async ({ page }) => {
  await installBilling(page);
  let calls = 0;
  await page.route("**/api/billing/paypal/sync", async (route) => { calls++; expect(route.request().postData()).toBe(null); await json(route, { entitled: false, pending: true }); });
  await page.goto("/?view=billing&paypal=return&subscription_id=I-ATTACKER");
  await expect(page.locator(".billing-payment-notice")).toContainText("결제 승인 결과를 확인 중");
  await expect(page.getByRole("heading", { name: "Free 플랜" })).toBeVisible();
  expect(calls).toBe(1);
  expect(page.url()).not.toContain("subscription_id");
});

test("only owners see payment controls", async ({ page }) => {
  await installBilling(page);
  await page.route("**/api/billing/status", (route) => json(route, { ...billingFixture(), canManage: false }));
  await page.goto("/?view=billing");
  await expect(page.getByRole("heading", { name: "Free 플랜" })).toBeVisible();
  await expect(page.locator(".billing-paypal-section")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PayPal로 결제" })).toHaveCount(0);
});

test("billing layouts preserve five languages, six themes, actual fonts and larger text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(180_000);
  await installBilling(page);
  for (const language of ["ko", "en", "ja", "zh", "es"]) {
    await page.route("**/api/bootstrap?**", (route) => json(route, { ...bootstrap,
      user: { ...bootstrap.user, preferences: { language, resolvedLanguage: language, revision: 2 } } }));
    await page.goto("/?view=billing");
    await expect(page.locator(".billing-paypal-section")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", language === "zh" ? "zh-Hans" : language);
    if (language !== "ko") expect(await page.locator(".billing-page").innerText()).not.toMatch(/[가-힣]/);
    for (const width of [320, 390, 768, 1440, 3840]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${language} ${width}`).toBeLessThanOrEqual(1);
      const overflow = await page.locator(".billing-page button,.billing-page label,.billing-page h3,.billing-page h4,.billing-usage-grid header,.billing-usage-grid header b").evaluateAll((elements) => elements
        .filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
      expect(overflow, `${language} ${width}`).toEqual([]);
    }
  }
  for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.evaluate((value) => localStorage.setItem("okri.theme", value), theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".billing-paypal-section")).toBeVisible({ timeout: 30_000 });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), theme).toBeLessThanOrEqual(1);
    expect(await page.locator(".billing-usage-grid header,.billing-usage-grid header b").evaluateAll((elements) => elements
      .filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.textContent)), theme).toEqual([]);
    const axe = await new AxeBuilder({ page: page as never }).include(".billing-page").analyze();
    expect(axe.violations.filter((v) => v.id === "color-contrast" || v.impact === "critical"), theme).toEqual([]);
    await page.screenshot({ path: info.outputPath(`billing-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => document.documentElement.style.fontSize = "100%");
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".billing-plan-card h4" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  await cdp.detach();
});
