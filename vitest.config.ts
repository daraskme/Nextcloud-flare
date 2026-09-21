import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations("./packages/worker/migrations") },
        d1Databases: [
          "TEST_BOOTSTRAP_RACE",
          "TEST_BOOTSTRAP_FAILURE",
          "TEST_BOOTSTRAP_LOGIN",
          "TEST_BOOTSTRAP_LOST",
        ],
      },
    })),
  ],
  test: {
    include: [
      "packages/worker/test/spike/**/*.test.ts",
      "packages/worker/test/integration/**/*.test.ts",
    ],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
