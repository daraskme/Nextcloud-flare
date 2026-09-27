import {
  restoreBookmarkObservation,
  restoreBookmarkTimestamp,
} from "../../packages/shared/src/restoreBookmark.ts";
import { restoreD1Target } from "../../packages/shared/src/restoreTarget.ts";
import { verifyRestoreD1Challenge } from "./target.mjs";
import { restoreIdentity, restoreStatus } from "./verify.mjs";

/** Re-query the pinned remote DB on every invocation, including uncertain prior attestations. */
export async function verifyRestoreBookmark({ epoch, id, control, reader, timestamp }) {
  restoreIdentity(epoch, id);
  const target = restoreD1Target(reader.target);
  if (target.mode !== "remote") throw new Error("database_restore_bookmark_unavailable");
  restoreBookmarkTimestamp(timestamp, Date.now());
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "preparing") throw new Error("database_restore_not_preparing");
  if (selected.source.kind !== "time_travel")
    throw new Error("database_restore_bookmark_unavailable");
  const { challenge, result: d1 } = await verifyRestoreD1Challenge({ epoch, id, control, reader });
  restoreBookmarkTimestamp(timestamp, challenge.issuedAt);
  const observation = restoreBookmarkObservation(
    await reader.readBookmark(timestamp),
    selected.source.bookmark,
    challenge.issuedAt,
  );
  if (observation.timestamp !== timestamp) throw new Error("database_restore_bookmark_mismatch");
  const saved = await control.attestBookmark(epoch, id, challenge, observation);
  if (
    !saved ||
    saved.id !== id ||
    saved.epoch !== epoch ||
    saved.state !== "bookmark_verified" ||
    saved.validator !== "time-travel-bookmark-v1" ||
    saved.bookmark !== observation.bookmark ||
    saved.timestamp !== timestamp ||
    saved.challengeId !== challenge.challengeId ||
    saved.revision !== challenge.revision ||
    JSON.stringify(restoreD1Target(saved.target)) !== JSON.stringify(target) ||
    !Number.isSafeInteger(saved.verifiedAt) ||
    saved.verifiedAt < d1.verifiedAt ||
    saved.verifiedAt >= challenge.expiresAt ||
    saved.expiresAt !== challenge.expiresAt
  )
    throw new Error("database_restore_invalid_bookmark_proof");
  return {
    id,
    epoch,
    target,
    ...observation,
    state: saved.state,
    validator: saved.validator,
    challengeId: saved.challengeId,
    revision: saved.revision,
    verifiedAt: saved.verifiedAt,
    expiresAt: saved.expiresAt,
  };
}
