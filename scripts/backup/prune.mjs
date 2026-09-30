import { operatorIdentity } from "./operator.mjs";

export const PRUNE_MAX_STEPS = 100;

/** Explicit single-generation pruning; the Worker rechecks age and receipt for every deletion. */
export async function pruneBackup({ epoch, id, control, progress = () => {} }) {
  operatorIdentity(epoch, id);
  let identity, result;
  for (let step = 1; step <= PRUNE_MAX_STEPS; step++) {
    result = await control.prune(epoch, id);
    if (
      result?.id !== id ||
      result.epoch !== epoch ||
      !Number.isSafeInteger(result.generationEpoch) ||
      result.generationEpoch < 1 ||
      result.generationEpoch > epoch ||
      !Number.isSafeInteger(result.createdAt) ||
      result.createdAt < 0 ||
      typeof result.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.manifestSha256) ||
      !["pending", "absent"].includes(result.state) ||
      !Number.isSafeInteger(result.deletedObjects) ||
      result.deletedObjects < 0 ||
      result.deletedObjects > 21
    )
      throw new Error("backup_invalid_prune_result");
    const found = JSON.stringify([result.generationEpoch, result.createdAt, result.manifestSha256]);
    if (identity && identity !== found) throw new Error("backup_generation_conflict");
    identity = found;
    progress({ stage: "backup_prune", ...result, step });
    if (result.state === "absent") return { ...result, complete: true, steps: step };
  }
  return { ...result, complete: false, steps: PRUNE_MAX_STEPS };
}
