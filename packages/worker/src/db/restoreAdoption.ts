import { assertOneChange, type BindValue, type SqlStatement } from "./primary";

/** Exact control CAS, including historical columns. No schema changes or terminal rewrites. */
export function restoreAdoptionBatch(
  source: Record<string, unknown>,
  newEpoch: number,
  token: string,
  at: number,
): { statements: SqlStatement[]; expected: Record<string, unknown> } {
  const row = { ...source },
    statements: SqlStatement[] = [];
  const update = (changes: Record<string, BindValue>) => {
    const keys = Object.keys(row).sort(),
      changed = Object.keys(changes);
    if (keys.some((key) => !/^[a-z_][a-z_0-9]*$/.test(key)))
      throw new Error("database_restore_invalid_snapshot");
    statements.push({
      sql: `UPDATE control SET ${changed.map((k) => `"${k}"=?`).join(",")} WHERE ${keys.map((k) => `"${k}" IS ?`).join(" AND ")}`,
      values: [...changed.map((k) => changes[k]!), ...keys.map((k) => row[k] as BindValue)],
    });
    Object.assign(row, changes);
  };
  // While frozen, even _assert is guarded. The first assertion follows both exact thaws;
  // any failed CAS leaves the old freeze or a mismatching full-row assertion, rolling back all.
  if (row.restore_freeze_token != null) update({ restore_freeze_token: null });
  if (row.backup_frozen === 1) update({ backup_frozen: 0 });
  update({ backup_token: null });
  statements.push(assertOneChange);
  update({
    epoch: newEpoch,
    maintenance: 1,
    gc_paused: 1,
    gc_operator_paused: 1,
    gc_hold_token: null,
    gc_hold_operation: null,
    gc_hold_expires_at: null,
    admission_revision: 0,
    admission_token: token,
    kdf_not_before: Math.max(row.kdf_not_before as number, at + 65000),
    updated_at: Math.max(at, row.updated_at as number),
  });
  statements.push(
    assertOneChange,
    { sql: "UPDATE permits SET state='revoked' WHERE state='open'" },
    {
      sql: "UPDATE operations SET state='failed',error_code='stale_epoch',updated_at=MAX(updated_at,?) WHERE state='claimed'",
      values: [at],
    },
  );
  return { statements, expected: row };
}
