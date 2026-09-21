import { assertExists, atomicBatch, primary, type SqlStatement } from "./primary";

export const PERMIT_LEASE_MS = 30_000;
export interface Permit {
  readonly permit_id: string;
  readonly space_id: string;
  readonly epoch: number;
  readonly expires_at: number;
}

function valid(id: string, epoch: number) {
  if (!id || id.length > 128 || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("invalid_permit");
}

export function assertOpenPermit(permit: Permit): SqlStatement {
  return assertExists(
    `SELECT 1 FROM permits p JOIN control c ON c.singleton=1
    WHERE p.permit_id=? AND p.space_id=? AND p.epoch=? AND p.expires_at=? AND p.state='open'
      AND p.expires_at>strftime('%s','now')*1000 AND c.epoch=p.epoch AND c.maintenance=0`,
    [permit.permit_id, permit.space_id, permit.epoch, permit.expires_at],
  );
}

function failClosedClaims(spaceId: string, code: string): SqlStatement {
  return {
    sql: `UPDATE operations SET state='failed',error_code=?,updated_at=MAX(updated_at,strftime('%s','now')*1000)
      WHERE space_id=? AND state='claimed' AND EXISTS(SELECT 1 FROM permits p WHERE p.permit_id=operations.permit_id AND p.state<>'open')`,
    values: [code, spaceId],
  };
}

async function readOpen(db: D1Database, permitId: string, spaceId: string, epoch: number) {
  return primary(db)
    .prepare(`SELECT p.permit_id,p.space_id,p.epoch,p.expires_at FROM permits p JOIN control c ON c.singleton=1
    WHERE p.permit_id=? AND p.space_id=? AND p.epoch=? AND p.state='open'
      AND p.expires_at>strftime('%s','now')*1000 AND c.epoch=p.epoch AND c.maintenance=0`)
    .bind(permitId, spaceId, epoch)
    .first<Permit>();
}

/** LockDO-only foundation primitive: current authorization/lock graph checks must precede this.
 * D1 linearizes expired-permit revocation, claim failure and the next grant as one batch.
 * requestId must be persisted by LockDO before dispatch so a lost response can reuse it.
 */
export async function grantPermit(
  db: D1Database,
  requestId: string,
  spaceId: string,
  epoch: number,
  leaseMs = PERMIT_LEASE_MS,
  guards: readonly SqlStatement[] = [],
): Promise<Permit> {
  valid(requestId, epoch);
  valid(spaceId, epoch);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > PERMIT_LEASE_MS)
    throw new Error("invalid_permit_lease");
  try {
    await atomicBatch(db, [
      assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
        epoch,
      ]),
      ...guards,
      {
        sql: "UPDATE permits SET state='revoked' WHERE space_id=? AND state='open' AND expires_at<=strftime('%s','now')*1000",
        values: [spaceId],
      },
      failClosedClaims(spaceId, "permit_expired"),
      {
        sql: `INSERT INTO permits(permit_id,space_id,epoch,expires_at,state)
          SELECT ?,?,?,strftime('%s','now')*1000+?,'open' WHERE NOT EXISTS(SELECT 1 FROM permits WHERE space_id=? AND state='open')
          ON CONFLICT(permit_id) DO NOTHING`,
        values: [requestId, spaceId, epoch, leaseMs, spaceId],
      },
      assertExists(
        `SELECT 1 FROM permits WHERE permit_id=? AND space_id=? AND epoch=? AND state='open'
        AND expires_at>strftime('%s','now')*1000`,
        [requestId, spaceId, epoch],
      ),
    ]);
  } catch (error) {
    // A response may be lost after commit. Only this exact durable intent can be returned.
    const permit = await readOpen(db, requestId, spaceId, epoch);
    if (permit) {
      if (guards.length) await atomicBatch(db, [...guards, assertOpenPermit(permit)]);
      return Object.freeze(permit);
    }
    throw error;
  }
  const permit = await readOpen(db, requestId, spaceId, epoch);
  if (!permit) throw new Error("permit_no_longer_open");
  return Object.freeze(permit);
}

/** Normal completion only. An unfinished operation must be explicitly revoked, not released. */
export async function releasePermit(db: D1Database, permit: Permit): Promise<void> {
  await atomicBatch(db, [
    assertExists(
      "SELECT 1 FROM permits WHERE permit_id=? AND space_id=? AND epoch=? AND expires_at=?",
      [permit.permit_id, permit.space_id, permit.epoch, permit.expires_at],
    ),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operations WHERE permit_id=? AND state='claimed')",
      [permit.permit_id],
    ),
    {
      sql: "UPDATE permits SET state='released' WHERE permit_id=? AND state='open'",
      values: [permit.permit_id],
    },
    assertExists("SELECT 1 FROM permits WHERE permit_id=? AND state IN ('released','revoked')", [
      permit.permit_id,
    ]),
  ]);
}

/** Used only by maintenance recovery after admission is closed. Terminal operations survive. */
export async function revokeSpacePermits(
  db: D1Database,
  spaceId: string,
  currentEpoch: number,
): Promise<void> {
  valid(spaceId, currentEpoch);
  await atomicBatch(db, [
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=1", [
      currentEpoch,
    ]),
    {
      sql: "UPDATE permits SET state='revoked' WHERE space_id=? AND state='open'",
      values: [spaceId],
    },
    failClosedClaims(spaceId, "permit_revoked"),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM permits WHERE space_id=? AND state='open') AND NOT EXISTS(SELECT 1 FROM operations WHERE space_id=? AND state='claimed')",
      [spaceId, spaceId],
    ),
  ]);
}
