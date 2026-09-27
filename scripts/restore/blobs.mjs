import { restoreBlobsTarget } from "../../packages/shared/src/restoreBlobs.ts";
import { restoreD1Target } from "../../packages/shared/src/restoreTarget.ts";
import { verifyRestoreD1Challenge } from "./target.mjs";

/** The Worker rotates and reads its own fresh probe through server-configured S3 credentials. */
export async function verifyRestoreBlobs({ epoch, id, control, reader }) {
  const source = restoreBlobsTarget(reader.blobsTarget),
    target = restoreD1Target(reader.target);
  if (target.mode !== "remote" || target.accountId !== source.accountId)
    throw new Error("database_restore_blobs_target_mismatch");
  await reader.assertUnchanged();
  const { challenge, result: d1 } = await verifyRestoreD1Challenge({ epoch, id, control, reader });
  await reader.assertUnchanged();
  const result = await control.verifyBlobs(epoch, id, challenge, source);
  await reader.assertUnchanged();
  if (
    !result ||
    result.id !== id ||
    result.epoch !== epoch ||
    result.state !== "blobs_verified" ||
    result.validator !== "r2-binding-v1" ||
    result.challengeId !== challenge.challengeId ||
    result.revision !== challenge.revision ||
    typeof result.attemptId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.attemptId) ||
    JSON.stringify(restoreD1Target(result.target)) !== JSON.stringify(target) ||
    JSON.stringify(restoreBlobsTarget(result.source)) !== JSON.stringify(source) ||
    !Number.isSafeInteger(result.verifiedAt) ||
    result.verifiedAt < d1.verifiedAt ||
    result.verifiedAt >= challenge.expiresAt ||
    result.expiresAt !== challenge.expiresAt
  )
    throw new Error("database_restore_invalid_blobs_proof");
  return {
    id,
    epoch,
    target,
    source,
    state: result.state,
    validator: result.validator,
    challengeId: result.challengeId,
    attemptId: result.attemptId,
    revision: result.revision,
    verifiedAt: result.verifiedAt,
    expiresAt: result.expiresAt,
  };
}
