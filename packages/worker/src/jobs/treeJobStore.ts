import type { Operation } from "@next-cloud-flare/shared/contracts";
import { assertOpenPermit } from "../db/permits";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { Env } from "../env";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
  systemMutationStatements,
} from "../services/systemMutation";
import {
  assertOperationClaim,
  lookupOperation,
  type OperationClaim,
  type VisibleOperation,
} from "./operations";

export const ASYNC_TREE_MAX_NODES = 10_000;
export const ASYNC_TREE_CHUNK_NODES = 250;
export const TREE_JOB_DISPATCH_LEASE_MS = 30_000;
export const TREE_JOB_CLAIM_LEASE_MS = 30_000;

export type TreeJobKind = Extract<Operation, "node.trash" | "node.restore" | "node.purge">;
export type TreeJobPhase = "manifest" | "finalize" | "completed" | "failed";

export interface TreeJobCheckpoint {
  readonly phase: TreeJobPhase;
  readonly cursor: string | null;
}

export interface TreeJobGrant {
  readonly rootNodeId: string;
  readonly parentId: string;
  readonly trashOpId: string;
  readonly sourceTreeGeneration: number;
  readonly sourceRevision: number;
  readonly parentRevision: number;
  readonly lockTokenHashes: readonly string[];
}

export interface TreeJobRow {
  id: string;
  owner_id: string;
  credential_id: string;
  op_id: string;
  kind: TreeJobKind;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  epoch: number;
  grant_snapshot: string;
  checkpoint: string;
  node_count: number;
  blob_count: number;
  invocation_count: number;
  error_code: string | null;
  dispatch_state: "pending" | "dispatching" | "sent" | "completed" | "failed";
  dispatch_token: string | null;
  dispatch_expires_at: number | null;
  operation_state: "claimed" | "committed" | "failed";
  principal_kind: string;
  principal_id: string;
  credential_version: number | null;
  space_id: string;
  request_digest: string;
  operands_json: string;
  expected_steps: number;
}

export interface TreeJobMessage {
  readonly treeJobId: string;
}

export interface TreeJobSender {
  send(body: TreeJobMessage, options?: { contentType: "json" }): Promise<unknown>;
}

const clock = "strftime('%s','now')*1000";

export function treeJobId(operationId: string): string {
  if (!/^op_[a-f0-9]{64}$/.test(operationId)) throw new Error("invalid_tree_job");
  return `job_${operationId.slice(3)}`;
}

export function parseTreeJobCheckpoint(encoded: string): TreeJobCheckpoint {
  const value = JSON.parse(encoded) as { phase?: unknown; cursor?: unknown };
  if (
    !["manifest", "finalize", "completed", "failed"].includes(String(value.phase)) ||
    (value.cursor !== null && typeof value.cursor !== "string")
  )
    throw new Error("invalid_tree_job");
  return value as TreeJobCheckpoint;
}

export function parseTreeJobGrant(encoded: string): TreeJobGrant {
  const value = JSON.parse(encoded) as Partial<TreeJobGrant>;
  if (
    typeof value.rootNodeId !== "string" ||
    typeof value.parentId !== "string" ||
    typeof value.trashOpId !== "string" ||
    !Number.isSafeInteger(value.sourceTreeGeneration) ||
    (value.sourceTreeGeneration ?? 0) < 0 ||
    !Number.isSafeInteger(value.sourceRevision) ||
    (value.sourceRevision ?? 0) < 1 ||
    !Number.isSafeInteger(value.parentRevision) ||
    (value.parentRevision ?? 0) < 1 ||
    !Array.isArray(value.lockTokenHashes) ||
    value.lockTokenHashes.length > 16 ||
    !value.lockTokenHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("invalid_tree_job");
  return value as TreeJobGrant;
}

export async function treeJobRow(db: D1Database, id: string): Promise<TreeJobRow | null> {
  return primary(db)
    .prepare(`SELECT j.*,o.state AS operation_state,o.principal_kind,o.principal_id,
      o.credential_version,o.space_id,o.request_digest,o.operands_json,o.expected_steps
      FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id WHERE j.id=?`)
    .bind(id)
    .first<TreeJobRow>();
}

function exactJobAssertion(row: TreeJobRow): SqlStatement {
  return assertExists(
    `SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
    WHERE j.id=? AND j.owner_id=? AND j.credential_id=? AND j.op_id=? AND j.kind=?
      AND j.epoch=? AND j.grant_snapshot=? AND j.checkpoint=? AND j.node_count=?
      AND j.blob_count=? AND j.invocation_count=? AND j.state=? AND j.dispatch_state=?
      AND j.dispatch_token IS ? AND j.dispatch_expires_at IS ? AND o.state=?
      AND o.principal_kind=? AND o.principal_id=? AND o.credential_id=?
      AND o.credential_version IS ? AND o.space_id=? AND o.request_digest=?
      AND o.operands_json=? AND o.expected_steps=?`,
    [
      row.id,
      row.owner_id,
      row.credential_id,
      row.op_id,
      row.kind,
      row.epoch,
      row.grant_snapshot,
      row.checkpoint,
      row.node_count,
      row.blob_count,
      row.invocation_count,
      row.state,
      row.dispatch_state,
      row.dispatch_token,
      row.dispatch_expires_at,
      row.operation_state,
      row.principal_kind,
      row.principal_id,
      row.credential_id,
      row.credential_version,
      row.space_id,
      row.request_digest,
      row.operands_json,
      row.expected_steps,
    ],
  );
}

export function assertExactTreeJob(row: TreeJobRow): SqlStatement {
  return exactJobAssertion(row);
}

export async function startTreeJob(
  db: D1Database,
  claim: OperationClaim,
  ownerId: string,
  grant: TreeJobGrant,
  setup: readonly SqlStatement[] = [],
): Promise<VisibleOperation> {
  if (
    !["node.trash", "node.restore", "node.purge"].includes(claim.intent.kind) ||
    claim.steps !== 1 ||
    claim.intent.principal.kind !== "user" ||
    ownerId !== claim.intent.principal.user_id
  )
    throw new Error("invalid_tree_job");
  const id = treeJobId(claim.intent.id);
  const encodedGrant = JSON.stringify(grant);
  const checkpoint = JSON.stringify({ phase: "manifest", cursor: null });
  try {
    await atomicBatch(db, [
      assertOpenPermit(claim.permit),
      assertOperationClaim(claim),
      ...setup,
      {
        sql: `INSERT INTO bulk_jobs(
          id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,checkpoint,created_at,updated_at
        ) VALUES(?,?,?,?,?,'pending',?,?,?,${clock},${clock})`,
        values: [
          id,
          ownerId,
          claim.intent.principal.credential_id,
          claim.intent.id,
          claim.intent.kind,
          claim.permit.epoch,
          encodedGrant,
          checkpoint,
        ],
      },
      assertOneChange,
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
        values: [claim.intent.id, grant.rootNodeId],
      },
      assertOneChange,
      {
        sql: "UPDATE permits SET state='released' WHERE permit_id=? AND state='open'",
        values: [claim.permit.permit_id],
      },
      assertOneChange,
    ]);
  } catch (error) {
    const current = await treeJobRow(db, id);
    if (
      !current ||
      current.owner_id !== ownerId ||
      current.credential_id !== claim.intent.principal.credential_id ||
      current.op_id !== claim.intent.id ||
      current.kind !== claim.intent.kind ||
      current.epoch !== claim.permit.epoch ||
      current.grant_snapshot !== encodedGrant ||
      current.operands_json !== claim.intent.operands ||
      current.request_digest !== claim.intent.digest ||
      current.expected_steps !== 1 ||
      !(
        (["pending", "running"].includes(current.state) && current.operation_state === "claimed") ||
        (current.state === "completed" && current.operation_state === "committed") ||
        (current.state === "failed" && current.operation_state === "failed")
      )
    )
      throw error;
  }
  const visible = await lookupOperation(db, claim.intent.principal, claim.intent.id);
  if (!visible) throw new Error("authorization_denied");
  return visible;
}

interface DispatchRow {
  id: string;
  state: string;
  dispatch_state: string;
  dispatch_token: string | null;
  dispatch_expires_at: number | null;
  epoch: number;
  owner_id: string;
  space_id: string;
  operation_state: string;
}

async function dispatchRow(db: D1Database, id: string): Promise<DispatchRow | null> {
  return primary(db)
    .prepare(`SELECT j.id,j.state,j.dispatch_state,j.dispatch_token,j.dispatch_expires_at,
      j.epoch,j.owner_id,o.space_id,o.state AS operation_state
      FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
      WHERE j.id=? AND j.kind IN ('node.trash','node.restore','node.purge')`)
    .bind(id)
    .first<DispatchRow>();
}

function dispatchAssertion(row: DispatchRow, token: string): SqlStatement {
  return assertExists(
    `SELECT 1 FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
    JOIN control c ON c.singleton=1
    WHERE j.id=? AND j.dispatch_token=? AND j.dispatch_state='dispatching'
      AND j.dispatch_expires_at>${clock} AND j.epoch=? AND j.owner_id=?
      AND j.state IN ('pending','running') AND o.state='claimed' AND o.epoch=j.epoch
      AND o.space_id=? AND c.epoch=j.epoch AND c.maintenance=0`,
    [row.id, token, row.epoch, row.owner_id, row.space_id],
  );
}

export async function dispatchTreeJob(
  env: SystemMutationSource,
  queue: TreeJobSender,
  id: string,
  epoch: number,
  deadline = Date.now() + 25_000,
): Promise<"sent" | "terminal" | "busy" | "retry"> {
  if (!/^job_[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("invalid_tree_job");
  const current = await dispatchRow(env.DB, id);
  if (current?.state === "completed" || current?.state === "failed") return "terminal";
  if (
    !current ||
    current.epoch !== epoch ||
    current.operation_state !== "claimed" ||
    Date.now() >= deadline
  )
    return "busy";
  const token = crypto.randomUUID();
  try {
    const admission = await acquireSystemMutation(
      env,
      current.owner_id,
      "tree-job.dispatch-claim",
      deadline,
    );
    await commitSystemMutation(env.DB, admission, current.owner_id, [
      {
        sql: `UPDATE bulk_jobs SET dispatch_state='dispatching',dispatch_token=?,
          dispatch_expires_at=${clock}+?,updated_at=MAX(updated_at,${clock})
        WHERE id=? AND epoch=? AND state IN ('pending','running')
          AND (dispatch_state='pending' OR
            (dispatch_state IN ('dispatching','sent') AND dispatch_expires_at<=${clock}))
          AND NOT EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=bulk_jobs.id AND l.expires_at>${clock})
          AND EXISTS(SELECT 1 FROM control c WHERE c.singleton=1 AND c.epoch=? AND c.maintenance=0)
          AND EXISTS(SELECT 1 FROM operations o WHERE o.op_id=bulk_jobs.op_id
            AND o.state='claimed' AND o.epoch=bulk_jobs.epoch)`,
        values: [token, TREE_JOB_DISPATCH_LEASE_MS, id, epoch, epoch],
      },
      dispatchAssertion(current, token),
    ]);
  } catch {
    const existing = await dispatchRow(env.DB, id);
    if (existing?.state === "completed" || existing?.state === "failed") return "terminal";
    if (existing?.dispatch_token !== token) return "busy";
  }
  try {
    const send = await acquireSystemMutation(env, current.owner_id, "tree-job.send", deadline);
    await atomicBatch(
      env.DB,
      systemMutationStatements(send, current.owner_id, [dispatchAssertion(current, token)]),
    );
    if (Date.now() >= deadline) return "retry";
    await queue.send({ treeJobId: id }, { contentType: "json" });
    const sent = await acquireSystemMutation(env, current.owner_id, "tree-job.sent", deadline);
    await commitSystemMutation(env.DB, sent, current.owner_id, [
      dispatchAssertion(current, token),
      {
        sql: `UPDATE bulk_jobs SET dispatch_state='sent',updated_at=MAX(updated_at,${clock})
        WHERE id=? AND dispatch_state='dispatching' AND dispatch_token=?
          AND dispatch_expires_at>${clock}`,
        values: [id, token],
      },
      assertOneChange,
    ]);
  } catch {
    const existing = await dispatchRow(env.DB, id);
    if (existing?.state === "completed" || existing?.state === "failed") return "terminal";
    return existing?.dispatch_state === "sent" && existing.dispatch_token === token
      ? "sent"
      : "retry";
  }
  return "sent";
}

export async function dispatchPendingTreeJobs(
  env: SystemMutationSource,
  queue: TreeJobSender,
  epoch: number,
  limit = 25,
): Promise<{ inspected: number; sent: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid_tree_job");
  const candidates = await primary(env.DB)
    .prepare(`SELECT j.id FROM bulk_jobs j JOIN operations o ON o.op_id=j.op_id
      JOIN control c ON c.singleton=1
      WHERE j.kind IN ('node.trash','node.restore','node.purge')
        AND j.epoch=? AND c.epoch=j.epoch AND c.maintenance=0
        AND j.state IN ('pending','running') AND o.state='claimed' AND o.epoch=j.epoch
        AND (j.dispatch_state='pending' OR
          (j.dispatch_state IN ('dispatching','sent') AND j.dispatch_expires_at<=${clock}))
        AND NOT EXISTS(SELECT 1 FROM job_leases l WHERE l.job_id=j.id AND l.expires_at>${clock})
      ORDER BY j.updated_at,j.id LIMIT ?`)
    .bind(epoch, limit)
    .all<{ id: string }>();
  const deadline = Date.now() + 25_000;
  let inspected = 0;
  let sent = 0;
  for (const candidate of candidates.results) {
    if (Date.now() >= deadline) break;
    inspected++;
    if ((await dispatchTreeJob(env, queue, candidate.id, epoch, deadline)) === "sent") sent++;
  }
  return { inspected, sent };
}

export type TreeJobEnv = SystemMutationSource & Pick<Env, "CONTROL">;
