import type { Env } from "../env.js";

export async function claimOutbox(
  env: Env,
  outboxId: string,
  token: string,
  epoch: number,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token=?1,dispatch_expires_at=?2,updated_at=?3 WHERE outbox_id=?4 AND state='pending' AND epoch=?5 AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=?5)",
  )
    .bind(token, now + 30_000, now, outboxId, epoch)
    .run();
  return result.meta.changes === 1;
}

export async function completeOutbox(
  env: Env,
  outboxId: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE outbox SET state='completed',dispatch_expires_at=NULL,updated_at=?1 WHERE outbox_id=?2 AND state IN ('dispatching','sent') AND dispatch_token=?3",
  )
    .bind(now, outboxId, token)
    .run();
  if (result.meta.changes === 1) {
    return true;
  }
  const existing = await env.DB.prepare(
    "SELECT state,dispatch_token FROM outbox WHERE outbox_id=?1",
  )
    .bind(outboxId)
    .first<{ state: string; dispatch_token: string | null }>();
  return existing?.state === "completed" && existing.dispatch_token === token;
}
