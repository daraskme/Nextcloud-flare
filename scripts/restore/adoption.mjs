import { restoreAdoptionChallenge } from "../../packages/shared/src/restoreAdoption.ts";
import { restoreFreezeTargets } from "../../packages/shared/src/restoreFreeze.ts";
import {
  RESTORE_SNAPSHOT_CONTROL_QUERY,
  restoredAdoptionDigest,
} from "../../packages/worker/src/db/restoreSnapshot.ts";
import { restoreStatus } from "./verify.mjs";

/** Independently read the request's persistent D1 stop marker before publishing its DO epoch. */
export async function adoptRestoreEpoch({ epoch, id, control, reader }) {
  const targets = restoreFreezeTargets({
    target: reader.target,
    blobs: reader.blobsTarget,
    backups: reader.backupsTarget,
  });
  await reader.assertUnchanged();
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state === "epoch_adopted") return selected;
  if (
    !["snapshot_verified", "adoption_pending", "adoption_written"].includes(selected.state) ||
    typeof reader.snapshotQuery !== "function"
  )
    throw new Error("database_restore_adoption_unavailable");
  const c = restoreAdoptionChallenge(await control.beginAdoption(epoch, id, targets));
  if (
    c.id !== id ||
    c.epoch !== epoch ||
    c.newEpoch !== selected.newEpoch ||
    JSON.stringify(c.targets) !== JSON.stringify(targets)
  )
    throw new Error("database_restore_adoption_conflict");
  const started = Date.now();
  const current = async () => {
    const clock = () => {
      if (Date.now() < started || Date.now() >= started + 30000)
        throw new Error("database_restore_adoption_timeout");
    };
    clock();
    await reader.assertUnchanged();
    clock();
  };
  await current();
  const rows = await reader.snapshotQuery(RESTORE_SNAPSHOT_CONTROL_QUERY);
  await current();
  if ((await restoredAdoptionDigest(rows, c.kdfNotBefore)) !== c.controlSha256)
    throw new Error("database_restore_adoption_mirror_conflict");
  await current();
  const status = restoreStatus(await control.attestAdoption(epoch, id, c), epoch, id);
  if (
    status.state !== "epoch_adopted" ||
    status.newEpoch !== c.newEpoch ||
    status.createdAt !== selected.createdAt ||
    JSON.stringify(status.source) !== JSON.stringify(selected.source) ||
    JSON.stringify(status.restoreResult) !== JSON.stringify(selected.restoreResult)
  )
    throw new Error("database_restore_invalid_status");
  return status;
}
