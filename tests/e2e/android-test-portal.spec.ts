import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { languages } from "../../lib/language";
import { THEMES } from "../../lib/themes";

const access = "A".repeat(43);

async function mockTesterWrites(page: Page) {
  await page.addInitScript((token) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const writes = JSON.parse(sessionStorage.getItem("android-test-mocked-writes") ?? "[]") as string[];
      if (url.pathname === "/api/android-test-signups" && method === "POST") {
        writes.push(url.href); sessionStorage.setItem("android-test-mocked-writes", JSON.stringify(writes));
        return new Response(JSON.stringify({ ok: true, access: token }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/api/android-test-signups/status") {
        if (method === "POST") {
          writes.push(url.href); sessionStorage.setItem("android-test-mocked-writes", JSON.stringify(writes));
          return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ portal: {
          email: "t*****@example.com", phoneLastFour: "5678", language: "ko", status: "applied",
          invitedAt: null, optedInAt: null, eligibleAt: null, rewardedAt: null, feedback: [],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  }, access);
  return () => page.evaluate(() => JSON.parse(sessionStorage.getItem("android-test-mocked-writes") ?? "[]") as string[]);
}

async function assertContained(page: Page) {
  const result = await page.locator(".android-test-page").evaluate((node) => {
    const interactive = [...node.querySelectorAll<HTMLElement>("a, button, input, select, textarea")];
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      clippedText: [...node.querySelectorAll<HTMLElement>("h1,h2,p,li,small,span,strong,b")].some((element) => !element.classList.contains("sr-only") && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible"),
      controls: interactive.every((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= -1 && box.right <= innerWidth + 1 && box.width >= 0 && box.height >= 0;
      }),
    };
  });
  expect(result).toEqual({ horizontalOverflow: false, clippedText: false, controls: true });
}

test("tester recruitment is readable in every supported language and has no unmocked writes", async ({ page }) => {
  const readWrites = await mockTesterWrites(page);
  await page.goto("/android-test?lang=ko");
  await expect(page.locator(".android-test-page")).toHaveAttribute("lang", "ko");
  for (const { id } of languages) {
    await page.locator(".android-test-language select").selectOption(id);
    await expect(page.locator(".android-test-page")).toHaveAttribute("lang", id);
    if (id !== "ko") await expect(page.locator(".android-test-layout")).not.toContainText(/[가-힣]/);
    await assertContained(page);
  }
  for (const { mode } of THEMES) {
    const colors = await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      const style = getComputedStyle(document.querySelector(".android-test-page")!);
      return { background: style.backgroundColor, foreground: style.color };
    }, mode);
    expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.foreground).not.toBe("rgba(0, 0, 0, 0)");
    await assertContained(page);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await assertContained(page);
  await expect(new AxeBuilder({ page }).include(".android-test-page").analyze()).resolves.toMatchObject({ violations: [] });
  expect(await readWrites()).toEqual([]);
});

test("application, private status, and feedback work through mocked writes without exposing contact data", async ({ page }) => {
  const readWrites = await mockTesterWrites(page);
  await page.goto("/android-test?lang=ko");
  await page.getByLabel("Google 계정 이메일").fill("tester@example.com");
  await page.getByLabel("쿠폰 수신 휴대전화 번호").fill("010-1234-5678");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Android 테스트 신청" }).click();
  await expect(page.getByRole("link", { name: "내 테스트 진행 상황 보기" })).toBeVisible();
  await page.getByRole("link", { name: "내 테스트 진행 상황 보기" }).click();
  await expect(page.getByRole("heading", { name: "내 Android 테스트" })).toBeVisible();
  await expect(page.locator(".android-test-identity")).toContainText("t*****@example.com");
  await expect(page.locator(".android-test-identity")).toContainText("***-****-5678");
  await page.getByLabel("피드백 보내기").fill("데일리 화면에서 완료한 일을 더 빨리 확인하고 싶습니다.");
  await page.getByRole("button", { name: "피드백 제출" }).click();
  await expect(page.getByRole("status")).toContainText("피드백을 저장했습니다");
  await assertContained(page);
  const writes = await readWrites();
  expect(writes).toHaveLength(2);
  expect(writes.every((url) => !url.includes("tester@example.com") && !url.includes("010"))).toBe(true);
});
