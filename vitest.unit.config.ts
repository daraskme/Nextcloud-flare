import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Windows CI 36085658959 exhausted 5s tests and 10s hooks while several
    // complete SQLite backup fixtures ran concurrently. Bound fixture I/O
    // contention and allow setup time; application deadlines remain unchanged.
    // Ubuntu CI 36460457472 also timed out a backup test under unrestricted concurrency.
    maxWorkers: 2,
    ...(process.platform === "win32" ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
    include: [
      "packages/worker/test/unit/**/*.test.ts",
      "packages/web/test/unit/**/*.test.ts",
      "scripts/test/**/*.test.mjs",
    ],
    environment: "node",
  },
});
