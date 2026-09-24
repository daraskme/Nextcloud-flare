import { assertExists, atomicBatch, type SqlStatement } from "./primary";

export const MUTATION_WAIT_MS = 5000;
export const MUTATION_QUEUE_LIMIT = 256;
export interface MutationRequest {
  permitId: string;
  spaceId: string;
  epoch: number;
  deadline: number;
}
export interface MutationAdmission {
  id: string;
  permit_id: string;
  space_id: string;
  epoch: number;
  expires_at: number;
}
export interface MutationReceipt extends Omit<MutationAdmission, "expires_at"> {
  expires_at: number | null;
  state: "waiting" | "active" | "closed";
}
const clock = "strftime('%s','now')*1000";
const columns = "id,permit_id,space_id,epoch,expires_at,state";

function cleanup(): SqlStatement[] {
  return [
    {
      sql: `UPDATE mutation_admissions SET state='closed' WHERE state IN ('waiting','active') AND (
        (state='waiting' AND wait_until<=${clock}) OR (state='active' AND expires_at<=${clock})
        OR NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=mutation_admissions.epoch))`,
    },
    {
      sql: `DELETE FROM mutation_admissions WHERE seq IN (SELECT seq FROM mutation_admissions
        WHERE state='closed' AND wait_until<=${clock} ORDER BY wait_until,seq LIMIT 256)`,
    },
  ];
}

function promote(): SqlStatement {
  return {
    sql: `WITH next AS MATERIALIZED (
      SELECT seq FROM mutation_admissions WHERE state='waiting' AND wait_until>${clock}
        AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=mutation_admissions.epoch)
      ORDER BY seq LIMIT (SELECT MAX(0,32-COUNT(*)) FROM mutation_admissions WHERE state='active')
    ) UPDATE mutation_admissions SET state='active',granted_at=${clock},expires_at=${clock}+30000
      WHERE seq IN (SELECT seq FROM next)`,
  };
}

/** A fresh attempt ID cannot revive an expired/released deterministic permit. */
export async function enqueueMutation(
  db: D1Database,
  request: MutationRequest,
): Promise<MutationReceipt> {
  if (
    !request ||
    typeof request.permitId !== "string" ||
    !request.permitId ||
    request.permitId.length > 128 ||
    typeof request.spaceId !== "string" ||
    !request.spaceId ||
    request.spaceId.length > 128 ||
    !Number.isSafeInteger(request.epoch) ||
    request.epoch < 1 ||
    !Number.isSafeInteger(request.deadline) ||
    request.deadline <= Date.now() ||
    request.deadline > Date.now() + MUTATION_WAIT_MS
  )
    throw new Error("mutation_unavailable");
  const { permitId, spaceId, epoch, deadline } = request;
  const identity = "permit_id=? AND space_id=? AND epoch=? AND state<>'closed'";
  const rows = await atomicBatch(db, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND maintenance=0 AND epoch=?", [epoch]),
    ...cleanup(),
    promote(),
    {
      sql: `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until)
      SELECT ?,?,?,?,${clock},MIN(?,${clock}+5000) WHERE NOT EXISTS(SELECT 1 FROM mutation_admissions WHERE permit_id=? AND state<>'closed')`,
      values: [crypto.randomUUID(), permitId, spaceId, epoch, deadline, permitId],
    },
    assertExists(`SELECT 1 FROM mutation_admissions WHERE ${identity}`, [permitId, spaceId, epoch]),
    promote(),
    {
      sql: `SELECT ${columns} FROM mutation_admissions WHERE ${identity}`,
      values: [permitId, spaceId, epoch],
    },
  ]);
  const receipt = rows.at(-1)?.results[0] as unknown as MutationReceipt | undefined;
  if (!receipt) throw new Error("mutation_unavailable");
  return receipt;
}

/** One bounded shared poll serves every live waiter; durable sequence defines FIFO after eviction. */
export async function advanceMutations(db: D1Database): Promise<MutationReceipt[]> {
  const rows = await atomicBatch(db, [
    ...cleanup(),
    promote(),
    {
      sql: `SELECT ${columns} FROM mutation_admissions WHERE state IN ('waiting','active') ORDER BY seq LIMIT 288`,
    },
  ]);
  return rows.at(-1)!.results as unknown as MutationReceipt[];
}

export function assertMutationAdmission(admission: MutationAdmission): SqlStatement {
  return assertExists(
    `SELECT 1 FROM mutation_admissions a JOIN control c ON c.singleton=1
    WHERE a.id=? AND a.permit_id=? AND a.space_id=? AND a.epoch=? AND a.expires_at=? AND a.state='active'
      AND a.expires_at>${clock} AND c.epoch=a.epoch AND c.maintenance=0`,
    [admission.id, admission.permit_id, admission.space_id, admission.epoch, admission.expires_at],
  );
}
