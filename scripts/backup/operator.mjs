import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureGeneration, verifyGeneration } from "./generation.mjs";
import { generationId, manifestKey } from "./objectStore.mjs";
import { publishGeneration } from "./publication.mjs";

export function operatorIdentity(epoch, id) {
  generationId(id);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
}
function completed(receipt, epoch, id) {
  if (
    receipt?.id !== id ||
    receipt.epoch !== epoch ||
    receipt.state !== "completed" ||
    receipt.manifestKey !== manifestKey(id) ||
    typeof receipt.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.manifestSha256) ||
    !Number.isSafeInteger(receipt.completedAt) ||
    !Number.isSafeInteger(receipt.releasedAt) ||
    receipt.completedAt < 0 ||
    receipt.releasedAt < 0
  )
    throw new Error("backup_invalid_receipt");
  return {
    id,
    epoch,
    state: "completed",
    objectKey: receipt.manifestKey,
    manifestSha256: receipt.manifestSha256,
  };
}

/** Explicit generation identity makes uncertain starts/finishes resumable. Never auto-cancel. */
export async function runBackup({
  directory,
  id,
  epoch,
  control,
  source,
  store,
  progress = () => {},
}) {
  operatorIdentity(epoch, id);
  const root = resolve(directory),
    artifact = join(root, id),
    receipt = await control.receipt(epoch, id);
  if (receipt !== null) {
    if (receipt?.id !== id || receipt.epoch !== epoch) throw new Error("backup_invalid_receipt");
    if (receipt.state === "completed") {
      const confirmed = completed(receipt, epoch, id);
      // D1 may have committed while ControlDO still retains its completion intent.
      // Finish that reconciliation before reporting that the operator run succeeded.
      const result = await control.complete(epoch, id, confirmed.manifestSha256);
      if (
        result?.id !== id ||
        result.epoch !== epoch ||
        result.state !== "completed" ||
        result.manifestSha256 !== confirmed.manifestSha256 ||
        !Number.isSafeInteger(result.partsTotal) ||
        result.partsTotal < 1 ||
        result.partsVerified !== result.partsTotal
      )
        throw new Error("backup_invalid_completion");
      return confirmed;
    }
    if (receipt.state === "failed") throw new Error("backup_generation_failed");
    if (receipt.releasedAt !== null) throw new Error("backup_generation_released");
    if (!["pending", "exporting"].includes(receipt.state))
      throw new Error("backup_invalid_receipt");
  }
  let exists = false;
  try {
    exists = (await lstat(artifact)).isDirectory();
    if (!exists) throw new Error("backup_destination_exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (exists) {
    // A prior run can have a durable completion intent. Do not call begin again in that phase.
    if (receipt === null) throw new Error("backup_generation_unrecognized");
    const manifest = await verifyGeneration(artifact);
    if (manifest.generation.id !== id || manifest.generation.epoch !== epoch)
      throw new Error("backup_generation_conflict");
  } else {
    const barrier = await control.begin(epoch, id);
    if (barrier?.id !== id || barrier.epoch !== epoch || barrier.state !== "frozen")
      throw new Error("backup_not_frozen");
    progress({ stage: "source_frozen", id, epoch });
    await captureGeneration({
      directory: root,
      id,
      epoch,
      source,
      progress: (stage) => progress({ stage }),
    });
  }
  const publication = await publishGeneration({ directory: artifact, store, progress });
  let verified = 0;
  for (let calls = 0; calls <= publication.parts; calls++) {
    const result = await control.complete(epoch, id, publication.sha256);
    if (
      result?.id !== id ||
      result.epoch !== epoch ||
      result.manifestSha256 !== publication.sha256 ||
      result.partsTotal !== publication.parts ||
      !Number.isSafeInteger(result.partsVerified) ||
      result.partsVerified > publication.parts
    )
      throw new Error("backup_invalid_completion");
    if (result.state === "completed" && result.partsVerified === publication.parts) {
      const confirmed = completed(await control.receipt(epoch, id), epoch, id);
      if (confirmed.manifestSha256 !== publication.sha256)
        throw new Error("backup_invalid_receipt");
      return { ...confirmed, bytes: publication.manifest.data.bytes };
    }
    if (result.state !== "verifying" || result.partsVerified <= verified)
      throw new Error("backup_verification_stalled");
    verified = result.partsVerified;
    progress({ stage: "completion_verified", parts: verified, total: publication.parts });
  }
  throw new Error("backup_verification_stalled");
}
