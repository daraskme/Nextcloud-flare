import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const chrome = "/run/current-system/sw/bin/google-chrome";
export default defineConfig({
  testDir: "./packages/web/test/browser",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      ...(existsSync(chrome) ? { executablePath: chrome } : {}),
      args: [
        "--host-resolver-rules=MAP app.ncf.test 127.0.0.1, MAP content.ncf.test 127.0.0.1",
        "--no-proxy-server",
      ],
    },
  },
  webServer: {
    command: "node scripts/browser-server.mjs",
    url: "https://127.0.0.1:8879/__test__/ready",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
