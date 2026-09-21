import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-13",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["BLOBS", "BACKUPS"],
        kvNamespaces: ["CACHE"],
        bindings: {
          ENVIRONMENT: "test",
          APP_ORIGIN: "https://app.test.invalid",
          CONTENT_ORIGIN: "https://content.test.invalid",
          ACCESS_ISSUER: "https://access.test.invalid",
          ACCESS_USER_AUD: "test-user-aud",
          ACCESS_SERVICE_AUD: "test-service-aud",
          PBKDF2_ITERATIONS: "100000",
          OWNER_EMAILS: "owner@test.invalid",
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@ncf/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/spike/**/*.test.ts", "test/integration/**/*.test.ts"],
  },
});
