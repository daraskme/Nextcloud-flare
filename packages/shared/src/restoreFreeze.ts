import { type RestoreBackupsTarget, restoreBackupsTarget } from "./restoreBackups.ts";
import { type RestoreBlobsTarget, restoreBlobsTarget } from "./restoreBlobs.ts";
import { type RestoreD1Target, restoreD1Target } from "./restoreTarget.ts";

export interface RestoreFreezeTargets {
  target: RestoreD1Target;
  blobs: RestoreBlobsTarget;
  backups: RestoreBackupsTarget;
}
export function restoreFreezeTargets(input: RestoreFreezeTargets): RestoreFreezeTargets {
  const target = restoreD1Target(input?.target),
    blobs = restoreBlobsTarget(input?.blobs),
    backups = restoreBackupsTarget(input?.backups);
  if (
    target.mode !== "remote" ||
    target.accountId !== blobs.accountId ||
    target.accountId !== backups.accountId ||
    JSON.stringify(blobs) === JSON.stringify(backups)
  )
    throw new Error("database_restore_freeze_target_mismatch");
  return { target, blobs, backups };
}
