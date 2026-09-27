import { randomUUID } from "node:crypto";
import {
  validateBackupPublicationWrite,
  validateBackupPublicationWriteGrant,
} from "../../packages/shared/src/backupPublicationWrite.ts";
import { digest } from "./objectStore.mjs";

export async function checkPublicationWrites(control, generation) {
  if (
    !control ||
    ["checkPublicationWrites", "grantPublicationWrite", "finishPublicationWrite"].some(
      (method) => typeof control[method] !== "function",
    )
  )
    throw new Error("backup_write_tracking_required");
  const result = await control.checkPublicationWrites(generation.epoch, generation.id, generation);
  if (
    result?.id !== generation.id ||
    result.epoch !== generation.epoch ||
    result.state !== "settled"
  )
    throw new Error("backup_publication_write_unsettled");
}

/** Only the native store callback may attest completion. GET/readback never settles a PUT. */
export async function trackedPublicationPut(store, control, generation, key, bytes) {
  const request = {
    attemptId: randomUUID(),
    generation,
    key,
    bytes: bytes.length,
    sha256: digest(bytes),
  };
  validateBackupPublicationWrite(request);
  const grant = await control.grantPublicationWrite(generation.epoch, generation.id, request);
  validateBackupPublicationWriteGrant(grant);
  if (
    grant.attemptId !== request.attemptId ||
    grant.epoch !== generation.epoch ||
    grant.id !== generation.id
  )
    throw new Error("backup_publication_write_conflict");
  let observed = false,
    settled = false;
  try {
    const result = await store.put(key, bytes, async () => {
      if (observed) throw new Error("backup_publication_write_conflict");
      observed = true;
      const result = await control.finishPublicationWrite(generation.epoch, generation.id, grant);
      if (result?.state !== "ended") throw new Error("backup_publication_write_unsettled");
      settled = true;
    });
    if (!settled || typeof result !== "boolean") throw new Error("backup_store_write_unknown");
    return result;
  } catch {
    // A lost response can hide a still-running PUT even if the exact object is visible.
    throw new Error("backup_store_write_unknown");
  }
}
