declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare module "cloudflare:workers" {
  export const env: import("../src/env.js").Env & {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  };
}
