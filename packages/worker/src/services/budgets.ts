import type { Env } from "../env.js";

export async function hasOwnerBudgetCapacity(
  env: Env,
  ownerId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT cs.budget_id) count FROM content_sessions cs JOIN users u ON u.id=cs.user_id WHERE u.id=?1 AND cs.revoked_at IS NULL AND cs.expires_at>?2",
  )
    .bind(ownerId, now)
    .first<{ count: number }>();
  return (row?.count ?? 0) < 64;
}
