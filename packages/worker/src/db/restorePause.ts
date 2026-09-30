import { assertExists, type SqlStatement } from "./primary";

/** Internal capability; never exposed in an HTTP response. */
export interface RestorePause {
  epoch: number;
  token: string;
  operationId: string;
  expiresAt: number;
}

export function restorePauseCondition(pause: RestorePause, alias = "c") {
  if (
    !/^op_[a-f0-9]{64}$/.test(pause.operationId) ||
    !/^[a-f0-9-]{36}$/.test(pause.token) ||
    !Number.isSafeInteger(pause.epoch) ||
    pause.epoch < 1 ||
    !Number.isSafeInteger(pause.expiresAt) ||
    pause.expiresAt < 1
  )
    throw new Error("invalid_restore_pause");
  return {
    sql: `${alias}.gc_hold_token=? AND ${alias}.gc_hold_operation=? AND ${alias}.gc_hold_expires_at=?
      AND ${alias}.gc_hold_expires_at>strftime('%s','now')*1000`,
    values: [pause.token, pause.operationId, pause.expiresAt],
  };
}

export function assertRestorePause(pause: RestorePause, operationId: string): SqlStatement {
  if (pause.operationId !== operationId) throw new Error("invalid_restore_pause");
  const proof = restorePauseCondition(pause);
  return assertExists(
    `SELECT 1 FROM control c WHERE c.singleton=1 AND c.epoch=?
    AND c.maintenance=0 AND c.gc_paused=1 AND ${proof.sql}`,
    [pause.epoch, ...proof.values],
  );
}
