import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
  systemMutationStatements,
} from "../services/systemMutation";

export const OUTBOX_DISPATCH_LEASE_MS = 30_000;
export interface OutboxMessage {
  readonly outboxId: string;
}
export type OutboxSender = Pick<Queue<OutboxMessage>, "send">;
export type DispatchResult = "sent" | "completed" | "busy" | "retry";

interface DispatchRow {
  outbox_id: string;
  state: string;
  dispatch_token: string | null;
  space_id: string;
  owner_id: string;
}
async function row(db: D1Database, id: string): Promise<DispatchRow | null> {
  return primary(db)
    .prepare(`SELECT b.outbox_id,b.state,b.dispatch_token,o.space_id,s.owner_id FROM outbox b
      JOIN operations o ON o.op_id=b.op_id JOIN spaces s ON s.id=o.space_id WHERE b.outbox_id=?`)
    .bind(id)
    .first<DispatchRow>();
}

function dispatchAssertion(id: string, token: string, epoch: number, spaceId: string) {
  return assertExists(
    `SELECT 1 FROM outbox b JOIN operations o ON o.op_id=b.op_id JOIN control c ON c.singleton=1
    WHERE b.outbox_id=? AND b.dispatch_token=? AND b.state='dispatching' AND b.dispatch_expires_at>strftime('%s','now')*1000
      AND b.epoch=? AND c.epoch=b.epoch AND c.maintenance=0 AND o.state='committed' AND o.epoch=b.epoch AND o.space_id=?`,
    [id, token, epoch, spaceId],
  );
}

/** Queue payloads contain only a durable ID. Lost send acknowledgements retain a lease for retry. */
export async function dispatchOutbox(
  env: SystemMutationSource,
  queue: OutboxSender,
  outboxId: string,
  epoch: number,
): Promise<DispatchResult> {
  return dispatch(env, queue, outboxId, epoch, Date.now() + 25_000);
}

async function dispatch(
  env: SystemMutationSource,
  queue: OutboxSender,
  outboxId: string,
  epoch: number,
  deadline: number,
): Promise<DispatchResult> {
  const { DB: db } = env;
  if (!outboxId || outboxId.length > 128 || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("invalid_outbox_dispatch");
  const current = await row(db, outboxId);
  if (current?.state === "completed") return "completed";
  if (!current || current.state === "failed") return "busy";
  const token = crypto.randomUUID();
  try {
    const admission = await acquireSystemMutation(
      env,
      current.owner_id,
      "outbox.dispatch-claim",
      deadline,
    );
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await commitSystemMutation(db, admission, current.owner_id, [
      {
        sql: `UPDATE outbox SET state='dispatching',dispatch_token=?,dispatch_expires_at=strftime('%s','now')*1000+?,updated_at=MAX(updated_at,strftime('%s','now')*1000)
        WHERE outbox_id=? AND epoch=? AND (state='pending' OR (state IN ('dispatching','sent') AND dispatch_expires_at<=strftime('%s','now')*1000))
        AND (claim_expires_at IS NULL OR claim_expires_at<=strftime('%s','now')*1000)
        AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
        AND EXISTS(SELECT 1 FROM operations o WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch)`,
        values: [token, OUTBOX_DISPATCH_LEASE_MS, outboxId, epoch, epoch],
      },
      dispatchAssertion(outboxId, token, epoch, current.space_id),
    ]);
  } catch {
    // Check the exact persisted token after an ambiguous claim response.
    const existing = await row(db, outboxId);
    if (existing?.state === "completed") return "completed";
    if (existing?.dispatch_token !== token) return "busy";
  }
  try {
    // A claim response alone cannot authorize a send after maintenance/epoch changed.
    const send = await acquireSystemMutation(env, current.owner_id, "outbox.send", deadline);
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await atomicBatch(
      db,
      systemMutationStatements(send, current.owner_id, [
        dispatchAssertion(outboxId, token, epoch, current.space_id),
      ]),
    );
    // This invocation needs direct ACK. A later leased retry may resend the same durable ID.
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await queue.send({ outboxId }, { contentType: "json" });
    const sent = await acquireSystemMutation(env, current.owner_id, "outbox.sent");
    await commitSystemMutation(db, sent, current.owner_id, [
      dispatchAssertion(outboxId, token, epoch, current.space_id),
      {
        sql: `UPDATE outbox SET state='sent',updated_at=MAX(updated_at,strftime('%s','now')*1000)
        WHERE outbox_id=? AND state='dispatching' AND dispatch_token=? AND epoch=? AND dispatch_expires_at>strftime('%s','now')*1000
        AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)`,
        values: [outboxId, token, epoch, epoch],
      },
      assertOneChange,
    ]);
  } catch {
    const existing = await row(db, outboxId);
    if (existing?.state === "completed") return "completed";
    return existing?.state === "sent" && existing.dispatch_token === token ? "sent" : "retry";
  }
  return "sent";
}

/** Bounded Cron/repair entry point. A sent lease is retried until a consumer has persisted completion. */
export async function dispatchPendingOutbox(
  env: SystemMutationSource,
  queue: OutboxSender,
  epoch: number,
  limit = 50,
): Promise<{ inspected: number; sent: number }> {
  const { DB: db } = env;
  const deadline = Date.now() + 25_000;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("invalid_outbox_dispatch");
  const candidates = await primary(db)
    .prepare(`SELECT b.outbox_id FROM outbox b JOIN control c ON c.singleton=1 JOIN operations o ON o.op_id=b.op_id
    WHERE b.epoch=? AND c.epoch=b.epoch AND c.maintenance=0 AND o.state='committed' AND o.epoch=b.epoch
      AND (b.state='pending' OR (b.state IN ('dispatching','sent') AND b.dispatch_expires_at<=strftime('%s','now')*1000))
      AND (b.claim_expires_at IS NULL OR b.claim_expires_at<=strftime('%s','now')*1000)
    ORDER BY b.updated_at,b.outbox_id LIMIT ?`)
    .bind(epoch, limit)
    .all<{ outbox_id: string }>();
  let sent = 0,
    inspected = 0;
  for (const candidate of candidates.results) {
    if (Date.now() >= deadline) break;
    inspected++;
    if ((await dispatch(env, queue, candidate.outbox_id, epoch, deadline)) === "sent") sent++;
  }
  return { inspected, sent };
}
