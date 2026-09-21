import type { Env } from "../env.js";

export async function hasOwnerBudgetCapacity(
  env: Env,
  ownerId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT budget_id) count FROM (SELECT cs.budget_id FROM content_sessions cs WHERE cs.user_id=?1 AND cs.revoked_at IS NULL AND cs.expires_at>?2 UNION SELECT ss.budget_id FROM share_sessions ss JOIN shares s ON s.id=ss.share_id WHERE s.owner_id=?1 AND ss.budget_id IS NOT NULL AND ss.revoked_at IS NULL AND ss.expires_at>?2)",
  )
    .bind(ownerId, now)
    .first<{ count: number }>();
  return (row?.count ?? 0) < 64;
}

export interface BudgetLease {
  id: string;
  settle: () => Promise<void>;
}

export async function acquireBudget(
  env: Env,
  budgetId: string,
  maxBytes: number,
  bytes: number,
): Promise<BudgetLease> {
  const stub = env.BUDGETS.get(env.BUDGETS.idFromName(budgetId));
  const response = await stub.fetch("https://budget.internal/leases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxBytes, bytes }),
  });
  if (!response.ok) throw new Error("budget_exceeded");
  const body: { lease_id: string } = await response.json();
  let settled = false;
  return {
    id: body.lease_id,
    settle: async () => {
      if (settled) return;
      settled = true;
      await stub.fetch(`https://budget.internal/leases/${body.lease_id}/settle`, {
        method: "POST",
      });
    },
  };
}

export async function attachBudgetLease(response: Response, lease: BudgetLease): Promise<Response> {
  if (response.body === null) {
    await lease.settle();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await lease.settle();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        await lease.settle().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await lease.settle().catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
