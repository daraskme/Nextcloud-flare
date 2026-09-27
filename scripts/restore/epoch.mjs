import { restoreFreezeTargets } from "../../packages/shared/src/restoreFreeze.ts";
import { restoreStatus } from "./verify.mjs";

/** Worker-owned history PUT only. Never executes D1 import, cancellation or adoption. */
export async function reserveRestoreEpoch({ epoch, id, control, reader }) {
  const targets = restoreFreezeTargets({
    target: reader.target,
    blobs: reader.blobsTarget,
    backups: reader.backupsTarget,
  });
  await reader.assertUnchanged();
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (!["frozen", "epoch_reserving", "epoch_reserved"].includes(selected.state))
    throw new Error("database_restore_epoch_not_frozen");
  await reader.assertUnchanged();
  const saved = await control.reserveEpoch(epoch, id, targets);
  await reader.assertUnchanged();
  const status = restoreStatus(saved, epoch, id);
  if (
    status.state !== "epoch_reserved" ||
    JSON.stringify(status.source) !== JSON.stringify(selected.source) ||
    status.createdAt !== selected.createdAt ||
    (selected.newEpoch !== undefined && selected.newEpoch !== status.newEpoch) ||
    saved.validator !== "restore-epoch-v1" ||
    JSON.stringify(restoreFreezeTargets(saved.targets)) !== JSON.stringify(targets) ||
    !Number.isSafeInteger(saved.reservedAt) ||
    saved.reservedAt < status.createdAt ||
    (status.source.kind === "logical" && status.newEpoch <= status.source.epoch)
  )
    throw new Error("database_restore_invalid_epoch_proof");
  return { ...status, targets, validator: saved.validator, reservedAt: saved.reservedAt };
}
