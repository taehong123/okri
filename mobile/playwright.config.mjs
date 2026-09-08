import { defineConfig } from "../node_modules/@playwright/test/index.mjs";
export default defineConfig({
  testDir: "./tests", testMatch: "native.spec.mjs", workers: 1, retries: 0,
  timeout: 45000, outputDir: "./test-results",
  use: { baseURL: "http://127.0.0.1:3199", viewport: { width: 390, height: 844 }, trace: "retain-on-failure" },
  webServer: { command: "node scripts/serve-preview.mjs", url: "http://127.0.0.1:3199", reuseExistingServer: true, timeout: 10000 },
});
