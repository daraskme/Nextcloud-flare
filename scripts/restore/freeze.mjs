import { restoreFreezeTargets } from "../../packages/shared/src/restoreFreeze.ts";
import { backupsInputs } from "./backups.mjs";
import { verifyRestoreBindingsChallenge } from "./bindings.mjs";
import { blobsInputs } from "./blobs.mjs";
import { restoreStatus } from "./verify.mjs";

/** Freeze only D1 writes. Source validation, external I/O settlement and epoch reservation remain separate. */
export async function freezeRestoreDatabase(options) {
  const { epoch, id, control, reader, store } = options;
  const backups = backupsInputs(reader, store),
    blobs = blobsInputs(reader);
  const targets = restoreFreezeTargets({
    target: backups.target,
    blobs: blobs.source,
    backups: backups.source,
  });
  await reader.assertUnchanged();
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  let input;
  if (selected.state === "preparing") {
    const { challenge, result } = await verifyRestoreBindingsChallenge(options);
    input = {
      challenge,
      blobsAttempt: result.blobs.attemptId,
      backupsAttempt: result.backups.attemptId,
    };
  } else if (!["freezing", "frozen"].includes(selected.state))
    throw new Error("database_restore_freeze_conflict");
  await reader.assertUnchanged();
  const saved = await control.freeze(epoch, id, targets, input);
  await reader.assertUnchanged();
  const status = restoreStatus(saved, epoch, id);
  if (
    status.state !== "frozen" ||
    JSON.stringify(status.source) !== JSON.stringify(selected.source) ||
    saved.validator !== "d1-write-freeze-v1" ||
    JSON.stringify(restoreFreezeTargets(saved.targets)) !== JSON.stringify(targets) ||
    !Number.isSafeInteger(saved.startedAt) ||
    saved.startedAt < selected.createdAt ||
    !Number.isSafeInteger(saved.frozenAt) ||
    saved.frozenAt < saved.startedAt
  )
    throw new Error("database_restore_invalid_freeze_proof");
  return {
    ...status,
    targets,
    validator: saved.validator,
    startedAt: saved.startedAt,
    frozenAt: saved.frozenAt,
  };
}
