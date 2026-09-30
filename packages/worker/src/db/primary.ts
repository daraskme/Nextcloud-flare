import { LIMITS } from "@next-cloud-flare/shared/limits";

export type BindValue = string | number | null | ArrayBuffer;
export interface SqlStatement {
  readonly sql: string;
  readonly values?: readonly BindValue[];
}

/** SQL is trusted application code; caller input is only ever passed as values. */
export function prepare(
  db: Pick<D1Database, "prepare">,
  statement: SqlStatement,
): D1PreparedStatement {
  if ((statement.values?.length ?? 0) > LIMITS.d1Bindings) {
    throw new RangeError("D1 statement exceeds 100 bindings");
  }
  if (new TextEncoder().encode(statement.sql).byteLength > LIMITS.d1SqlBytes) {
    throw new RangeError("D1 statement exceeds SQL byte budget");
  }
  return db.prepare(statement.sql).bind(...(statement.values ?? []));
}

export function primary(db: D1Database): D1Database {
  // Without the Sessions API every query uses primary. first-primary only pins
  // the first query, so a shared session is not an authority-read adapter.
  return db;
}

export async function atomicBatch(db: D1Database, statements: readonly SqlStatement[]) {
  if (statements.length === 0 || statements.length > LIMITS.d1Statements) {
    throw new RangeError("D1 batch exceeds statement budget");
  }
  const session = primary(db);
  // Compile and validate every statement before dispatching any SQL.
  return session.batch(statements.map((statement) => prepare(session, statement)));
}

export function assertExists(query: string, values: readonly BindValue[] = []): SqlStatement {
  return { sql: `INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (${query})`, values };
}

export const assertOneChange: SqlStatement = {
  sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes() <> 1",
};
