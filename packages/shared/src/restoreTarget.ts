/** D1 identity only. R2 bindings and permission to overwrite require separate proofs. */
export type RestoreD1Target =
  | { mode: "local"; databaseId: string }
  | { mode: "remote"; databaseId: string; accountId: string };

export interface RestoreD1Challenge {
  id: string;
  epoch: number;
  target: RestoreD1Target;
  state: "d1_challenge";
  challengeId: string;
  revision: number;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export const RESTORE_D1_WINDOW_MS = 5 * 60 * 1000;
export const RESTORE_D1_QUERY = `SELECT epoch,maintenance,gc_paused,admission_revision,
  admission_token,backup_frozen,backup_token FROM control WHERE singleton=1`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function restoreD1Target(input: unknown): RestoreD1Target {
  if (
    !record(input) ||
    typeof input.databaseId !== "string" ||
    !uuid.test(input.databaseId) ||
    !["local", "remote"].includes(input.mode as string) ||
    Object.keys(input).some(
      (key) =>
        !["mode", "databaseId", ...(input.mode === "remote" ? ["accountId"] : [])].includes(key),
    )
  )
    throw new Error("database_restore_invalid_target");
  if (input.mode === "local") return { mode: "local", databaseId: input.databaseId };
  if (typeof input.accountId !== "string" || !/^[0-9a-f]{32}$/.test(input.accountId))
    throw new Error("database_restore_invalid_target");
  return { mode: "remote", databaseId: input.databaseId, accountId: input.accountId };
}

export function restoreD1Challenge(
  input: unknown,
  epoch: number,
  id: string,
  target: RestoreD1Target,
): RestoreD1Challenge {
  if (
    !record(input) ||
    input.id !== id ||
    input.epoch !== epoch ||
    input.state !== "d1_challenge" ||
    JSON.stringify(restoreD1Target(input.target)) !== JSON.stringify(restoreD1Target(target)) ||
    typeof input.challengeId !== "string" ||
    !uuid.test(input.challengeId) ||
    typeof input.token !== "string" ||
    !uuid.test(input.token) ||
    !integer(input.revision) ||
    !integer(input.issuedAt) ||
    !integer(input.expiresAt) ||
    input.expiresAt - input.issuedAt !== RESTORE_D1_WINDOW_MS
  )
    throw new Error("database_restore_invalid_challenge");
  return input as unknown as RestoreD1Challenge;
}

export function assertRestoreD1Mirror(rows: unknown, challenge: RestoreD1Challenge): void {
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
  if (
    !record(row) ||
    row.epoch !== challenge.epoch ||
    row.admission_revision !== challenge.revision ||
    row.admission_token !== challenge.token ||
    row.maintenance !== 1 ||
    row.gc_paused !== 1 ||
    row.backup_frozen !== 0 ||
    row.backup_token !== null
  )
    throw new Error("database_restore_target_mismatch");
}
