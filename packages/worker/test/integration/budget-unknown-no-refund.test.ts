import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("BudgetDO unknown transfer", () => {
  it("settles concurrency without refunding reserved consumption", async () => {
    const stub = env.BUDGETS.get(env.BUDGETS.idFromName("unknown-budget"));
    const first = await stub.fetch("https://budget.invalid/leases", {
      method: "POST",
      body: JSON.stringify({ maxBytes: 10, bytes: 8 }),
    });
    const body = await first.json<{ lease_id: string }>();
    await stub.fetch(`https://budget.invalid/leases/${body.lease_id}/settle`, { method: "POST" });
    const second = await stub.fetch("https://budget.invalid/leases", {
      method: "POST",
      body: JSON.stringify({ maxBytes: 10, bytes: 3 }),
    });
    expect(second.status).toBe(429);
    const status = await stub.fetch("https://budget.invalid/status");
    await expect(status.json()).resolves.toMatchObject({ consumedBytes: 8, active: 0 });
  });
});
