import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/worker/test/unit/**/*.test.ts", "packages/web/test/unit/**/*.test.ts"],
    environment: "node",
  },
});
