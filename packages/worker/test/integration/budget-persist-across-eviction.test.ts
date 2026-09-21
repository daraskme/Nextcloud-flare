import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("BudgetDO durable accounting", () => {
  it("preserves consumed counters across eviction", async () => {
    const stub = env.BUDGETS.get(env.BUDGETS.idFromName("persist-budget"));
    const lease = await stub.fetch("https://budget.invalid/leases", {
      method: "POST",
      body: JSON.stringify({ maxBytes: 10, bytes: 7 }),
    });
    expect(lease.status).toBe(200);
    await lease.json();
    await evictDurableObject(stub);
    const status = await stub.fetch("https://budget.invalid/status");
    await expect(status.json()).resolves.toMatchObject({
      consumedBytes: 7,
      requests: 1,
      active: 1,
    });
  });
});
