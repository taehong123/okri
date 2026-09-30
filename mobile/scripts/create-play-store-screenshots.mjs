import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { chromium } from "../../node_modules/@playwright/test/index.mjs";
import { createPreviewServer } from "./serve-preview.mjs";

const root = process.cwd();
const outputDir = path.join(root, "mobile", "release", "store-assets", "android", "phone");
const server = createPreviewServer({ port: 3199 });
await once(server, "listening");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3 });
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
  });

  await page.goto("http://127.0.0.1:3199/?lang=ko&theme=white");
  await page.getByText("가입 실패 원인 분류", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDir, "01-today.png") });

  await page.getByRole("tab", { name: "데일리", exact: true }).click();
  await page.getByText("운영 점검", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(outputDir, "02-daily.png") });

  await page.getByRole("tab", { name: "더보기", exact: true }).click();
  await page.getByRole("button", { name: "OKR", exact: true }).click();
  await page.getByText("고객이 제품의 가치를 빠르게 경험하게 한다", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDir, "03-okr.png") });

  await page.goto("http://127.0.0.1:3199/?lang=ko&theme=white");
  await page.getByText("가입 실패 원인 분류", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "더보기", exact: true }).click();
  await page.getByRole("button", { name: /간트/ }).click();
  await page.screenshot({ path: path.join(outputDir, "04-gantt.png") });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
}

console.log(outputDir);
