import { generationId } from "./objectStore.mjs";

export const SWEEP_MAX_STEPS = 100;
function validate(result, epoch, previous) {
  if (!result || result.epoch !== epoch) throw new Error("backup_invalid_sweep_result");
  generationId(result.round);
  if (result.after !== null) generationId(result.after);
  if (result.through !== null) generationId(result.through);
  if (
    !Number.isSafeInteger(result.startedAt) ||
    result.startedAt < 0 ||
    !["running", "completed"].includes(result.state) ||
    [result.scanned, result.absent, result.errors].some((n) => !Number.isSafeInteger(n) || n < 0) ||
    result.absent + result.errors > result.scanned ||
    (result.after !== null && (result.through === null || result.after > result.through)) ||
    (result.errors === 0) !== (result.lastError === null)
  )
    throw new Error("backup_invalid_sweep_result");
  if (result.lastError !== null) {
    generationId(result.lastError?.id);
    if (
      typeof result.lastError.code !== "string" ||
      !/^backup_[a-z_]+$/.test(result.lastError.code)
    )
      throw new Error("backup_invalid_sweep_result");
  }
  if (
    previous &&
    (result.round !== previous.round ||
      result.startedAt !== previous.startedAt ||
      result.through !== previous.through ||
      (result.after ?? "") < (previous.after ?? "") ||
      result.scanned < previous.scanned ||
      result.absent < previous.absent ||
      result.errors < previous.errors)
  )
    throw new Error("backup_sweep_changed");
  return result;
}

/** Resume the server-owned scan. A global step budget includes already-absent generations. */
export async function sweepBackups({ epoch, control, progress = () => {} }) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
  let result = validate(await control.sweep(epoch), epoch);
  let steps = 0;
  while (result.state !== "completed" && steps < SWEEP_MAX_STEPS) {
    result = validate(await control.sweep(epoch, result.round), epoch, result);
    steps++;
    progress({ stage: "backup_sweep", ...result, steps });
  }
  const complete = result.state === "completed";
  return { ...result, complete, healthy: complete && result.errors === 0, steps };
}
