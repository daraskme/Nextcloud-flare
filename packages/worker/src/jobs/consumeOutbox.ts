import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertOneChange, atomicBatch, primary } from "../db/primary";

export const OUTBOX_CLAIM_LEASE_MS = 30_000;
export type ConsumeResult = "completed" | "retry";

interface EventRow {
  state: string;
  kind: string;
  payload_ref: string;
  epoch: number;
  op_id: string;
  op_kind: string;
  op_state: string;
  principal_kind: string;
  principal_id: string;
  credential_id: string | null;
  credential_version: number | null;
  space_id: string;
  operands_json: string;
}

async function eventRow(db: D1Database, id: string): Promise<EventRow | null> {
  return primary(db)
    .prepare(`SELECT b.state,b.kind,b.payload_ref,b.epoch,o.op_id,o.kind AS op_kind,
      o.state AS op_state,o.principal_kind,o.principal_id,o.credential_id,
      o.credential_version,o.space_id,o.operands_json FROM outbox b JOIN operations o ON o.op_id=b.op_id
      WHERE b.outbox_id=?`)
    .bind(id)
    .first<EventRow>();
}

function savedPrincipal(row: EventRow): Principal | null {
  if (!row.credential_id) return null;
  if (row.principal_kind === "user" || row.principal_kind === "app_password") {
    return {
      kind: row.principal_kind,
      user_id: row.principal_id,
      credential_id: row.credential_id,
      epoch: row.epoch,
    };
  }
  if (row.principal_kind === "link_share" && row.credential_version !== null) {
    return {
      kind: "link_share",
      share_id: row.principal_id,
      share_version: row.credential_version,
      credential_id: row.credential_id,
      epoch: row.epoch,
    };
  }
  return null;
}

/** Complete the current node.created event only after a fenced D1 claim and current authorization. */
export async function consumeOutbox(db: D1Database, outboxId: string): Promise<ConsumeResult> {
  if (!outboxId || outboxId.length > 128) return "retry";
  const row = await eventRow(db, outboxId);
  if (row?.state === "completed") return "completed";
  if (
    !row ||
    row.kind !== "node.created" ||
    row.op_kind !== "node.create" ||
    row.op_state !== "committed" ||
    !["dispatching", "sent"].includes(row.state)
  )
    return "retry";
  const principal = savedPrincipal(row);
  if (!principal) return "retry";
  let parentId: string;
  try {
    const operands = JSON.parse(row.operands_json) as { parentId?: unknown };
    if (typeof operands.parentId !== "string") return "retry";
    parentId = operands.parentId;
  } catch {
    return "retry";
  }
  let authorized: Awaited<ReturnType<typeof authorizeNode>>;
  try {
    authorized = await authorizeNode(db, principal, {
      operation: "node.create",
      parentId,
      spaceId: row.space_id,
    });
  } catch {
    return "retry";
  }
  const token = crypto.randomUUID();
  const clock = "strftime('%s','now')*1000";
  try {
    await atomicBatch(db, [
      authorizationAssertion(authorized),
      {
        sql: `UPDATE outbox SET claim_token=?,claim_expires_at=${clock}+?,updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND epoch=? AND state IN ('dispatching','sent')
            AND (claim_token IS NULL OR claim_expires_at<=${clock})
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
            AND EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.op_id=o.op_id
              WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch
                AND o.kind='node.create' AND s.step_no=1 AND s.kind='node'
                AND s.affected_id=outbox.payload_ref)`,
        values: [token, OUTBOX_CLAIM_LEASE_MS, outboxId, row.epoch, row.epoch],
      },
      assertOneChange,
    ]);
    await atomicBatch(db, [
      authorizationAssertion(authorized),
      {
        sql: `UPDATE outbox SET state='completed',updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND claim_token=? AND claim_expires_at>${clock}
            AND epoch=? AND state IN ('dispatching','sent')
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
            AND EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.op_id=o.op_id
              WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch
                AND o.kind='node.create' AND s.step_no=1 AND s.kind='node'
                AND s.affected_id=outbox.payload_ref)`,
        values: [outboxId, token, row.epoch, row.epoch],
      },
      assertOneChange,
    ]);
    return "completed";
  } catch {
    // A lost D1 acknowledgement is safe to ack only when the terminal row is visible.
    return (await eventRow(db, outboxId))?.state === "completed" ? "completed" : "retry";
  }
}
