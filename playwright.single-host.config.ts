import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/single-host.spec.ts",
  outputDir: "test-results/single-host",
  use: { ...base.use, baseURL: "https://app.ncf.test:8880" },
  webServer: {
    command: "node scripts/browser-server.mjs --single-host",
    url: "https://127.0.0.1:8880/__test__/ready",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
