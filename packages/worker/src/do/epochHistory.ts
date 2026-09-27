export const EPOCH_PREFIX = "sys/epoch/";
export type EpochReason =
  | "bootstrap"
  | "storage_recovery"
  | "restore"
  | "credential_rotation"
  | "operator";
export interface EpochRecord {
  epoch: number;
  at: number;
  reason: EpochReason;
}

export function epochNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid_epoch");
  return value;
}

export function parseEpochFloor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid_epoch_floor");
  return epochNumber(Number(value));
}

/** A lost DO must prove a fresh lower bound; the wall clock is never an epoch. */
export async function recoverEpochFloor(
  bucket: R2Bucket,
  d1Epoch: number,
  operatorFloor?: number,
  assertCurrent: () => void = () => {},
): Promise<number> {
  epochNumber(d1Epoch);
  if (operatorFloor !== undefined) epochNumber(operatorFloor);
  let maximum = 0;
  let cursor: string | undefined;
  try {
    for (let page = 0; ; page++) {
      assertCurrent();
      if (page >= 100) throw new Error("epoch_history_scan_limit");
      const result = await bucket.list({
        prefix: EPOCH_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      assertCurrent();
      for (const object of result.objects) {
        const match = /^sys\/epoch\/([1-9][0-9]*)\.json$/.exec(object.key);
        if (!match) throw new Error("invalid_epoch_history_key");
        maximum = Math.max(maximum, epochNumber(Number(match[1])));
      }
      if (!result.truncated) break;
      if (!result.cursor || result.cursor === cursor)
        throw new Error("invalid_epoch_history_cursor");
      cursor = result.cursor;
    }
  } catch (error) {
    if (operatorFloor === undefined) throw error;
    // Explicit operator assertion is the only escape hatch for unavailable history.
  }
  assertCurrent();
  if (maximum === 0 && operatorFloor === undefined) throw new Error("epoch_floor_required");
  return epochNumber(Math.max(maximum + 1, d1Epoch + 1, operatorFloor ?? 1));
}
