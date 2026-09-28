import { test, expect } from "@playwright/test";

test("merchant bridge requires consent, shows the actual service and returns only after a mocked verified result", async ({ page }, info) => {
  const token = "11111111-1111-4111-8111-111111111111";
  let result: Record<string, unknown> | null = null;
  await page.route("**/api/public/payple/okri/session", route => route.fulfill({ json: {
    clientKey: "mock-public", authUrl: "https://democpay.payple.kr/js/v1/payment.js", plan: "team", priceWon: 2900, firstPaymentWon: 2900,
  } }));
  await page.route("https://ajax.googleapis.com/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("https://democpay.payple.kr/**", route => route.fulfill({ contentType: "application/javascript",
    body: 'window.PaypleCpayAuthCheck = options => options.callbackFunction({PCD_PAY_RST:"success",PCD_PAY_WORK:"AUTH",PCD_PAY_TYPE:"card",PCD_PAYER_ID:"mock-key"});',
  }));
  await page.route("**/api/public/payple/okri/result", async route => {
    result = route.request().postDataJSON();
    await route.fulfill({ json: { returnUrl: "https://okri.ai/?view=billing&payple=return#" + token } });
  });
  await page.route("https://okri.ai/?view=billing**", route => route.fulfill({ contentType: "text/html", body: "<h1>Mock OKRI return</h1>" }));
  await page.goto("/api/public/payple/okri/bridge?lang=ko&theme=dark#" + token);
  const register = page.getByRole("button", { name: "카드 등록하기", exact: true });
  await expect(page.getByText("OKRI 월 구독", { exact: true })).toBeVisible();
  await expect(page.locator("#today")).toContainText("2,900");
  await expect(register).toBeDisabled();
  expect(page.url()).not.toContain(token);
  await page.getByRole("checkbox").check();
  await expect(register).toBeEnabled();
  await page.screenshot({ path: info.outputPath("bridge-ready.png"), fullPage: true });
  await register.click();
  await expect(page.getByRole("heading", { name: "Mock OKRI return" })).toBeVisible();
  expect(result).toMatchObject({ sessionToken: token, accepted: true, firstPaymentWon: 2900, priceWon: 2900 });
});

test("bridge preserves localized labels, themes, narrow layout and text zoom", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await page.route("**/api/public/payple/okri/session", route => route.fulfill({ json: {
    clientKey: "mock-public", authUrl: "https://democpay.payple.kr/js/v1/payment.js", plan: "team", priceWon: 2900, firstPaymentWon: 0,
  } }));
  await page.route("https://ajax.googleapis.com/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("https://democpay.payple.kr/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  for (const lang of ["ko", "en", "ja", "zh", "es"]) {
    for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`/api/public/payple/okri/bridge?lang=${lang}&theme=${theme}`);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("#today")).toContainText("0");
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      if (lang !== "ko") expect(await page.locator("main").innerText()).not.toMatch(/[가-힣]/);
    }
  }
  await page.screenshot({ path: info.outputPath("bridge-mobile-text-zoom.png"), fullPage: true });
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "h1" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  await cdp.detach();
});
