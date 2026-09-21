import type { Env } from "../env.js";

export async function releaseExpiredOutboxClaims(env: Env, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE outbox SET state='pending',dispatch_token=NULL,dispatch_expires_at=NULL,updated_at=?1 WHERE state IN ('dispatching','sent') AND dispatch_expires_at<=?1",
  )
    .bind(now)
    .run();
  return result.meta.changes;
}
