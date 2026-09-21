import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        fileURLToPath(new URL("./migrations", import.meta.url)),
      );
      return {
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-03-01",
          compatibilityFlags: ["nodejs_compat"],
          isolatedStorage: true,
          d1Databases: ["DB"],
          r2Buckets: ["BLOBS", "BACKUPS"],
          kvNamespaces: ["CACHE"],
          durableObjects: {
            CONTROL: "ControlDO",
            LOCKS: "LockDO",
            UPLOADS: "UploadDO",
            BUDGETS: "BudgetDO",
          },
          bindings: {
            ENVIRONMENT: "test",
            APP_ORIGIN: "https://app.test.invalid",
            CONTENT_ORIGIN: "https://content.test.invalid",
            ACCESS_ISSUER: "https://access.test.invalid",
            ACCESS_USER_AUD: "test-user-aud",
            ACCESS_SERVICE_AUD: "test-service-aud",
            PBKDF2_ITERATIONS: "100000",
            OWNER_EMAILS: "owner@test.invalid",
            EPOCH_FLOOR: "1",
            CURSOR_KEY: "test-only-cursor-signing-key-000000000000",
            DEV_CSRF_KEY: "test-only-csrf-signing-key-00000000000000",
            CONTENT_SESSION_KEY: "test-only-content-signing-key-00000000000",
            APP_PASSWORD_PEPPER: "test-only-app-password-pepper-000000000000000",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  resolve: {
    alias: {
      "@ncf/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "test/spike/**/*.test.ts",
      "test/integration/**/*.test.ts",
      "test/schema/**/*.test.ts",
    ],
  },
});
