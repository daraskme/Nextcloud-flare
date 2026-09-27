import { backupsInputs, verifyBackupsWithChallenge } from "./backups.mjs";
import { blobsInputs, verifyBlobsWithChallenge } from "./blobs.mjs";
import { verifyRestoreD1Challenge } from "./target.mjs";

/** One fresh stop challenge for D1, BLOBS and BACKUPS; no permission to overwrite D1. */
export async function verifyRestoreBindings(options) {
  return (await verifyRestoreBindingsChallenge(options)).result;
}

/** Internal continuation retains the challenge; public output never includes its stop token. */
export async function verifyRestoreBindingsChallenge(options) {
  const { epoch, id, control, reader, store } = options;
  const { source: backupSource, target } = backupsInputs(reader, store),
    { source: blobSource } = blobsInputs(reader);
  if (JSON.stringify(backupSource) === JSON.stringify(blobSource))
    throw new Error("database_restore_backups_target_mismatch");
  await reader.assertUnchanged();
  const verified = await verifyRestoreD1Challenge({ epoch, id, control, reader });
  const blobs = await verifyBlobsWithChallenge({ ...options, ...verified });
  const backups = await verifyBackupsWithChallenge({ ...options, ...verified });
  const { challenge } = verified;
  const result = await control.verifyBindings(
    epoch,
    id,
    challenge,
    blobs.attemptId,
    backups.attemptId,
  );
  await reader.assertUnchanged();
  const summary = (proof) => ({
    source: proof.source,
    attemptId: proof.attemptId,
    verifiedAt: proof.verifiedAt,
    expiresAt: proof.expiresAt,
  });
  const expectedBlobs = summary(blobs),
    expectedBackups = summary(backups);
  const matches = (actual, expected) =>
    !!actual &&
    Object.keys(expected).every(
      (key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]),
    );
  if (
    !result ||
    result.id !== id ||
    result.epoch !== epoch ||
    result.state !== "bindings_verified" ||
    result.validator !== "restore-bindings-v1" ||
    result.challengeId !== challenge.challengeId ||
    result.revision !== challenge.revision ||
    JSON.stringify(result.target) !== JSON.stringify(target) ||
    !matches(result.blobs, expectedBlobs) ||
    !matches(result.backups, expectedBackups) ||
    !Number.isSafeInteger(result.verifiedAt) ||
    result.verifiedAt < Math.max(blobs.verifiedAt, backups.verifiedAt) ||
    result.expiresAt !== Math.min(blobs.expiresAt, backups.expiresAt) ||
    result.verifiedAt >= result.expiresAt
  )
    throw new Error("database_restore_invalid_bindings_proof");
  return {
    challenge,
    result: {
      id,
      epoch,
      target,
      state: result.state,
      validator: result.validator,
      challengeId: challenge.challengeId,
      revision: challenge.revision,
      blobs: expectedBlobs,
      backups: expectedBackups,
      verifiedAt: result.verifiedAt,
      expiresAt: result.expiresAt,
    },
  };
}
