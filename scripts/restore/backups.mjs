import {
  restoreBackupsChallenge,
  restoreBackupsTarget,
} from "../../packages/shared/src/restoreBackups.ts";
import { restoreD1Target } from "../../packages/shared/src/restoreTarget.ts";
import { verifyRestoreD1Challenge } from "./target.mjs";

export function backupsInputs(reader, store) {
  const source = restoreBackupsTarget(reader.backupsTarget),
    target = restoreD1Target(reader.target);
  const configured = restoreBackupsTarget({
    accountId: store.source?.account,
    bucket: store.source?.bucket,
    jurisdiction: store.source?.jurisdiction,
  });
  if (
    target.mode !== "remote" ||
    target.accountId !== source.accountId ||
    JSON.stringify(source) !== JSON.stringify(configured)
  )
    throw new Error("database_restore_backups_target_mismatch");
  return { source, target };
}

export async function verifyRestoreBackups(options) {
  const { epoch, id, control, reader, store } = options;
  backupsInputs(reader, store);
  await reader.assertUnchanged();
  const verified = await verifyRestoreD1Challenge({ epoch, id, control, reader });
  return verifyBackupsWithChallenge({ ...options, ...verified });
}

/** Also used by the combined verifier, which must retain one D1 challenge throughout. */
export async function verifyBackupsWithChallenge({
  epoch,
  id,
  control,
  reader,
  store,
  challenge,
  result: d1,
}) {
  const { source, target } = backupsInputs(reader, store);
  await reader.assertUnchanged();
  const probe = restoreBackupsChallenge(
    await control.challengeBackups(epoch, id, challenge, source),
    challenge,
    source,
  );
  const bytes = await store.readRestoreProbe();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 64)
    throw new Error("database_restore_backups_mismatch");
  const nonce = new TextDecoder().decode(bytes);
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("database_restore_backups_mismatch");
  await reader.assertUnchanged();
  const result = await control.attestBackups(epoch, id, challenge, probe.attemptId, nonce);
  await reader.assertUnchanged();
  if (
    !result ||
    result.id !== id ||
    result.epoch !== epoch ||
    result.state !== "backups_verified" ||
    result.validator !== "backups-binding-v1" ||
    result.challengeId !== challenge.challengeId ||
    result.revision !== challenge.revision ||
    result.attemptId !== probe.attemptId ||
    JSON.stringify(restoreD1Target(result.target)) !== JSON.stringify(target) ||
    JSON.stringify(restoreBackupsTarget(result.source)) !== JSON.stringify(source) ||
    !Number.isSafeInteger(result.verifiedAt) ||
    result.verifiedAt < Math.max(d1.verifiedAt, probe.issuedAt) ||
    result.verifiedAt >= probe.expiresAt ||
    result.expiresAt !== probe.expiresAt
  )
    throw new Error("database_restore_invalid_backups_proof");
  return {
    id,
    epoch,
    target,
    source,
    state: result.state,
    validator: result.validator,
    challengeId: result.challengeId,
    revision: result.revision,
    attemptId: result.attemptId,
    verifiedAt: result.verifiedAt,
    expiresAt: result.expiresAt,
  };
}
