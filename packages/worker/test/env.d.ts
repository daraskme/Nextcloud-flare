import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
      TEST_BOOTSTRAP_RACE: D1Database;
      TEST_BOOTSTRAP_FAILURE: D1Database;
      TEST_BOOTSTRAP_LOGIN: D1Database;
      TEST_BOOTSTRAP_LOST: D1Database;
    }
  }
}
