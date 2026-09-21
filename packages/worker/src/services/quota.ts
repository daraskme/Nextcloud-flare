import { assertExists, type SqlStatement } from "../db/primary";

export interface ReservationInput {
  readonly id: string;
  readonly ownerId: string;
  readonly bytes: number;
  readonly expiresAt: number;
  readonly epoch: number;
  readonly share?: { readonly id: string; readonly version: number };
  readonly operationId?: string;
}

/** Append to the caller's authenticated/fenced batch, never dispatch as a separate quota write. */
export function reservationStatements(input: ReservationInput): SqlStatement[] {
  if (
    !input.id ||
    !input.ownerId ||
    input.id.length > 128 ||
    input.ownerId.length > 128 ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    input.bytes > 536_870_912_000 ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch < 1
  )
    throw new Error("invalid_reservation");
  return [
    assertExists(
      "SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0 AND ?>strftime('%s','now')*1000",
      [input.epoch, input.expiresAt],
    ),
    ...(input.share
      ? [
          assertExists(
            `SELECT 1 FROM shares WHERE id=? AND version=? AND owner_id=? AND disabled_at IS NULL
      AND (expires_at IS NULL OR expires_at>strftime('%s','now')*1000)`,
            [input.share.id, input.share.version, input.ownerId],
          ),
        ]
      : []),
    {
      sql: `INSERT INTO reservations(id,owner_id,share_id,bytes,state,expires_at,epoch,op_id)
        VALUES(?,?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`,
      values: [
        input.id,
        input.ownerId,
        input.share?.id ?? null,
        input.bytes,
        input.expiresAt,
        input.epoch,
        input.operationId ?? null,
      ],
    },
    assertExists(
      `SELECT 1 FROM reservations WHERE id=? AND owner_id=? AND share_id IS ? AND bytes=?
      AND state='reserved' AND expires_at=? AND epoch=? AND op_id IS ?`,
      [
        input.id,
        input.ownerId,
        input.share?.id ?? null,
        input.bytes,
        input.expiresAt,
        input.epoch,
        input.operationId ?? null,
      ],
    ),
  ];
}

/** Consume before publishing the new logical reference in the same mutation batch. */
export function finishReservationStatements(
  id: string,
  ownerId: string,
  epoch: number,
  state: "consumed" | "released",
): SqlStatement[] {
  if (state !== "consumed" && state !== "released") throw new Error("invalid_reservation_state");
  return [
    assertExists(
      `SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND (?='released' OR maintenance=0)`,
      [epoch, state],
    ),
    assertExists(
      `SELECT 1 FROM reservations WHERE id=? AND owner_id=? AND epoch=? AND state IN ('reserved',?)
      AND (?='released' OR expires_at>strftime('%s','now')*1000)`,
      [id, ownerId, epoch, state, state],
    ),
    {
      sql: "UPDATE reservations SET state=? WHERE id=? AND owner_id=? AND epoch=? AND state='reserved'",
      values: [state, id, ownerId, epoch],
    },
    assertExists("SELECT 1 FROM reservations WHERE id=? AND owner_id=? AND epoch=? AND state=?", [
      id,
      ownerId,
      epoch,
      state,
    ]),
  ];
}

export function physicalQuota(quotaBytes: number): number {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0 || quotaBytes > 7_505_999_378_950_825)
    throw new Error("invalid_quota");
  return Number((BigInt(quotaBytes) * 6n) / 5n);
}
