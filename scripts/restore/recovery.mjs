import { restoreStatus } from "./verify.mjs";

const released = ["recovery_ready", "service_resumed", "gc_resumed"];
function sameStatus(value, selected) {
  const status = restoreStatus(value, selected.epoch, selected.id);
  if (
    status.newEpoch !== selected.newEpoch ||
    status.createdAt !== selected.createdAt ||
    JSON.stringify(status.source) !== JSON.stringify(selected.source) ||
    JSON.stringify(status.restoreResult) !== JSON.stringify(selected.restoreResult)
  )
    throw new Error("database_restore_invalid_status");
  return status;
}
function auditStatus(value, epoch) {
  if (
    !value ||
    value.epoch !== epoch ||
    ![
      "users",
      "blobs",
      "r2",
      "outbox",
      "shares",
      "credentials",
      "credential_sources",
      "fts",
      "fence",
      "complete",
    ].includes(value.stage) ||
    typeof value.afterId !== "string" ||
    value.afterId.length > 4096 ||
    !Number.isSafeInteger(value.pages) ||
    value.pages < 0 ||
    value.completed !== (value.stage === "complete")
  )
    throw new Error("database_restore_invalid_recovery_audit");
  return {
    epoch,
    stage: value.stage,
    afterId: value.afterId,
    pages: value.pages,
    completed: value.completed,
  };
}
function controlStatus(value, epoch) {
  if (
    !value ||
    value.epoch !== epoch ||
    typeof value.maintenance !== "boolean" ||
    typeof value.gcPaused !== "boolean"
  )
    throw new Error("database_restore_invalid_status");
  return { epoch, maintenance: value.maintenance, gcPaused: value.gcPaused };
}

/** Bounded durable pages. A new or invalidated audit first rebuilds the restored FTS index. */
export async function auditRestored({
  epoch,
  id,
  control,
  maxPages = 100,
  pageSize = 10,
  progress = () => {},
}) {
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 20
  )
    throw new Error("database_restore_invalid_recovery_limit");
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_unavailable");
  let result;
  for (let n = 0; n < maxPages; n++) {
    const raw = await control.auditRecovery(epoch, id, pageSize),
      status = sameStatus(raw, selected),
      audit = auditStatus(raw.audit, selected.newEpoch);
    if (status.state !== "epoch_adopted") throw new Error("database_restore_recovery_conflict");
    result = { ...status, audit };
    progress({ stage: "recovery_audit", audit });
    if (audit.completed) break;
  }
  return result;
}

export async function rebuildRestoredFts({ epoch, id, control }) {
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_unavailable");
  const raw = await control.rebuildRecoveryFts(epoch, id),
    status = sameStatus(raw, selected);
  if (status.state !== "epoch_adopted") throw new Error("database_restore_recovery_conflict");
  return { ...status, audit: auditStatus(raw.audit, selected.newEpoch) };
}

/** Hold release uses the exact completed audit. Service opens first; GC has a separate command. */
export async function resumeRestored({ epoch, id, control, gc = false }) {
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (!released.includes(selected.state) && selected.state !== "epoch_adopted")
    throw new Error("database_restore_recovery_unavailable");
  if (gc && !["service_resumed", "gc_resumed"].includes(selected.state))
    throw new Error("database_restore_recovery_not_resumed");
  if (!gc) {
    const status = sameStatus(await control.releaseRecovery(epoch, id), selected);
    if (!released.includes(status.state)) throw new Error("database_restore_invalid_status");
  }
  const raw = await (gc ? control.resumeRecoveryGc(epoch, id) : control.resumeRecovery(epoch, id)),
    status = sameStatus(raw, selected);
  if (!(gc ? ["gc_resumed"] : ["service_resumed", "gc_resumed"]).includes(status.state))
    throw new Error("database_restore_invalid_status");
  // A replay of a completed GC step reports the current policy, including a later explicit pause.
  return { ...status, control: controlStatus(raw.control, selected.newEpoch) };
}
