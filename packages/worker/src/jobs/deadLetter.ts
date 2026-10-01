import { assertOneChange, primary } from "../db/primary";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { treeJobRow } from "./treeJobStore";
import { failTreeJob } from "./treeJobWorker";

export interface DeadLetterDelivery {
  readonly id: string;
  readonly attempts: number;
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

export interface DeadLetterBatch {
  readonly messages: readonly DeadLetterDelivery[];
}

interface DeadLetterRow {
  outbox_id: string;
  op_id: string;
  kind: string;
  payload_ref: string;
  state: string;
  epoch: number;
  dispatch_token: string | null;
  dispatch_expires_at: number | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  space_id: string;
  owner_id: string;
  operation_kind: string;
  operation_state: string;
  operation_epoch: number;
  operands_json: string;
  result_json: string;
}

function outboxId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "outboxId") return null;
  const id = (body as { outboxId?: unknown }).outboxId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function treeJobId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "treeJobId") return null;
  const id = (body as { treeJobId?: unknown }).treeJobId;
  return typeof id === "string" && /^job_[a-f0-9]{64}$/.test(id) ? id : null;
}

function validDelivery(delivery: DeadLetterDelivery): boolean {
  return (
    typeof delivery.id === "string" &&
    delivery.id.length >= 1 &&
    delivery.id.length <= 128 &&
    Number.isInteger(delivery.attempts) &&
    delivery.attempts >= 1 &&
    delivery.attempts <= 1_000_000
  );
}

async function terminalProof(
  db: D1Database,
  outboxId: string,
  messageId: string,
): Promise<boolean> {
  const proof = await primary(db)
    .prepare(`SELECT 1 FROM outbox_dead_letters d JOIN outbox b ON b.outbox_id=d.outbox_id
      WHERE d.outbox_id=? AND d.queue_message_id=? AND d.epoch=b.epoch
        AND ((d.status='failed' AND b.state='failed') OR d.status='requeued')`)
    .bind(outboxId, messageId)
    .first<number>();
  return proof !== null;
}

async function observeDuplicate(
  db: D1Database,
  outboxId: string,
  messageId: string,
  attempts: number,
): Promise<boolean> {
  if (!(await terminalProof(db, outboxId, messageId))) return false;
  await primary(db)
    .prepare(`UPDATE outbox_dead_letters
      SET observed_attempts=MAX(observed_attempts,?),
        last_observed_at=MAX(last_observed_at,strftime('%s','now')*1000)
      WHERE outbox_id=? AND queue_message_id=?`)
    .bind(attempts, outboxId, messageId)
    .run();
  return terminalProof(db, outboxId, messageId);
}

async function deadLetterRow(db: D1Database, id: string): Promise<DeadLetterRow | null> {
  return primary(db)
    .prepare(`SELECT b.outbox_id,b.op_id,b.kind,b.payload_ref,b.state,b.epoch,
      b.dispatch_token,b.dispatch_expires_at,b.claim_token,b.claim_expires_at,
      o.space_id,s.owner_id,o.kind AS operation_kind,o.state AS operation_state,
      o.epoch AS operation_epoch,o.operands_json,o.result_json
      FROM outbox b JOIN operations o ON o.op_id=b.op_id JOIN spaces s ON s.id=o.space_id
      WHERE b.outbox_id=?`)
    .bind(id)
    .first<DeadLetterRow>();
}

function knownProvenance(row: DeadLetterRow): boolean {
  return (
    row.operation_state === "committed" &&
    row.operation_epoch === row.epoch &&
    ((row.kind === "node.created" &&
      [
        "node.create",
        "node.copy",
        "dav.mkcol",
        "dav.lock",
        "dav.put",
        "dav.copy",
        "upload.complete",
      ].includes(row.operation_kind)) ||
      (row.kind === "node.updated" &&
        ["dav.put", "upload.complete"].includes(row.operation_kind)) ||
      (row.kind === "node.trashed" && ["node.trash", "dav.delete"].includes(row.operation_kind)) ||
      (row.kind === "node.restored" && row.operation_kind === "node.restore") ||
      (row.kind === "node.purged" && row.operation_kind === "node.purge") ||
      (row.kind === "node.renamed" &&
        ["node.rename", "node.move", "dav.move"].includes(row.operation_kind)))
  );
}

function eligibleLease(row: DeadLetterRow, now: number): boolean {
  const dispatchEligible =
    row.state === "pending"
      ? row.dispatch_token === null && row.dispatch_expires_at === null
      : (row.state === "dispatching" || row.state === "sent") &&
        row.dispatch_token !== null &&
        row.dispatch_expires_at !== null &&
        row.dispatch_expires_at <= now;
  const claimExpired =
    (row.claim_token === null && row.claim_expires_at === null) ||
    (row.claim_token !== null && row.claim_expires_at !== null && row.claim_expires_at <= now);
  return dispatchEligible && claimExpired;
}

async function terminalizeDeadLetter(
  env: SystemMutationSource,
  delivery: DeadLetterDelivery,
  deadline: number,
): Promise<boolean> {
  const { DB: db } = env;
  const id = outboxId(delivery.body);
  if (!id || !validDelivery(delivery) || Date.now() >= deadline) return false;
  if (await observeDuplicate(db, id, delivery.id, delivery.attempts)) return true;
  const row = await deadLetterRow(db, id);
  if (!row || !knownProvenance(row) || !eligibleLease(row, Date.now())) return false;
  const admission = await acquireSystemMutation(env, row.owner_id, "outbox.dead-letter", deadline);
  if (admission.maintenance !== 0 || admission.space_id !== row.space_id || Date.now() >= deadline)
    return false;
  const clock = "strftime('%s','now')*1000";
  try {
    await commitSystemMutation(db, admission, row.owner_id, [
      {
        sql: `UPDATE outbox SET state='failed',dispatch_token=NULL,dispatch_expires_at=NULL,
          claim_token=NULL,claim_expires_at=NULL,updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND op_id=? AND kind=? AND payload_ref=? AND epoch=? AND state=?
            AND dispatch_token IS ? AND dispatch_expires_at IS ?
            AND claim_token IS ? AND claim_expires_at IS ?
            AND EXISTS(SELECT 1 FROM control c WHERE c.singleton=1
              AND c.epoch=outbox.epoch AND c.maintenance=0)
            AND (
              (state='pending' AND dispatch_token IS NULL AND dispatch_expires_at IS NULL) OR
              (state IN ('dispatching','sent') AND dispatch_token IS NOT NULL
                AND dispatch_expires_at IS NOT NULL AND dispatch_expires_at<=${clock})
            )
            AND (
              (claim_token IS NULL AND claim_expires_at IS NULL) OR
              (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
                AND claim_expires_at<=${clock})
            )
            AND EXISTS(SELECT 1 FROM operations o WHERE o.op_id=outbox.op_id
              AND o.space_id=? AND o.state='committed' AND o.epoch=outbox.epoch
              AND o.kind=? AND o.operands_json=? AND o.result_json=?
              AND ((outbox.kind='node.created' AND o.kind IN ('node.create','node.copy','dav.mkcol','dav.lock','dav.put','dav.copy','upload.complete')) OR
                (outbox.kind='node.updated' AND o.kind IN ('dav.put','upload.complete')) OR
                (outbox.kind='node.trashed' AND o.kind IN ('node.trash','dav.delete')) OR
                (outbox.kind='node.restored' AND o.kind='node.restore') OR
                (outbox.kind='node.purged' AND o.kind='node.purge') OR
                (outbox.kind='node.renamed' AND o.kind IN ('node.rename','node.move','dav.move')))
              AND EXISTS(SELECT 1 FROM operation_steps s WHERE s.op_id=o.op_id
                AND s.kind='node' AND s.affected_id=outbox.payload_ref))`,
        values: [
          row.outbox_id,
          row.op_id,
          row.kind,
          row.payload_ref,
          row.epoch,
          row.state,
          row.dispatch_token,
          row.dispatch_expires_at,
          row.claim_token,
          row.claim_expires_at,
          row.space_id,
          row.operation_kind,
          row.operands_json,
          row.result_json,
        ],
      },
      assertOneChange,
      {
        sql: `INSERT INTO outbox_dead_letters(
          outbox_id,queue_message_id,observed_attempts,first_observed_at,last_observed_at,status,epoch
        ) VALUES(?,?,?,${clock},${clock},'failed',?)`,
        values: [row.outbox_id, delivery.id, delivery.attempts, row.epoch],
      },
    ]);
  } catch {
    return observeDuplicate(db, id, delivery.id, delivery.attempts);
  }
  return terminalProof(db, id, delivery.id);
}

export async function handleDeadLetterBatch(
  env: SystemMutationSource,
  batch: DeadLetterBatch,
): Promise<{ acked: number; retried: number }> {
  let acked = 0;
  let retried = 0;
  const deadline = Date.now() + 25_000;
  for (const message of batch.messages) {
    try {
      const jobId = treeJobId(message.body);
      if (jobId && validDelivery(message)) {
        const row = await treeJobRow(env.DB, jobId);
        if (
          !row ||
          row.state === "completed" ||
          row.state === "failed" ||
          (await failTreeJob(env, row, "queue_exhausted", deadline)) === "failed"
        ) {
          message.ack();
          acked++;
          continue;
        }
      }
      if (await terminalizeDeadLetter(env, message, deadline)) {
        message.ack();
        acked++;
        continue;
      }
    } catch {
      // Admission, D1, or terminal-proof uncertainty retains the Queue delivery.
    }
    message.retry();
    retried++;
  }
  return { acked, retried };
}
