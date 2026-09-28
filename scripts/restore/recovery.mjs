import { restoreDomainKind } from "../../packages/shared/src/restoreDomain.ts";
import { restoreStatus } from "./verify.mjs";

const released = ["recovery_ready", "service_resumed", "gc_resumed"];
export function sameRecoveryStatus(value, selected) {
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

function liveNativeStatus(value, limit, capacity) {
  if (
    !value ||
    ![value.checked, value.reconciled, value.pending, value.unknown].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    ) ||
    value.checked > limit ||
    value.reconciled > value.checked ||
    value.pending > capacity ||
    value.unknown > value.pending
  )
    throw new Error("database_restore_invalid_native_repair");
  return {
    checked: value.checked,
    reconciled: value.reconciled,
    pending: value.pending,
    unknown: value.unknown,
  };
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
      status = sameRecoveryStatus(raw, selected),
      audit = auditStatus(raw.audit, selected.newEpoch);
    if (status.state !== "epoch_adopted") throw new Error("database_restore_recovery_conflict");
    result = { ...status, audit };
    progress({ stage: "recovery_audit", audit });
    if (audit.completed) break;
  }
  return result;
}

/** A complete scan may still contain unknown work; it never opens admission. */
export async function repairRestoredNative({
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
    const raw = await control.repairNative(epoch, id, pageSize),
      status = sameRecoveryStatus(raw, selected),
      r = raw.repair;
    if (
      status.state !== "epoch_adopted" ||
      !r ||
      !["kdf", "r2", "complete"].includes(r.stage) ||
      typeof r.afterId !== "string" ||
      r.afterId.length > 36 ||
      ![r.checked, r.reconciled, r.unknown].every((v) => Number.isSafeInteger(v) && v >= 0) ||
      r.checked !== r.reconciled + r.unknown ||
      r.completed !== (r.stage === "complete") ||
      ![r.databasePending?.kdf, r.databasePending?.r2, r.databasePending?.images].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      )
    )
      throw new Error("database_restore_invalid_native_repair");
    const repair = {
      stage: r.stage,
      afterId: r.afterId,
      checked: r.checked,
      reconciled: r.reconciled,
      unknown: r.unknown,
      completed: r.completed,
      live: {
        kdf: liveNativeStatus(r.live?.kdf, pageSize, 20),
        r2: liveNativeStatus(r.live?.r2, pageSize, 32),
        images: liveNativeStatus(r.live?.images, pageSize, 8),
      },
      databasePending: {
        kdf: r.databasePending.kdf,
        r2: r.databasePending.r2,
        images: r.databasePending.images,
      },
    };
    repair.pending =
      !repair.completed ||
      repair.unknown > 0 ||
      repair.live.kdf.pending > 0 ||
      repair.live.r2.pending > 0 ||
      repair.live.images.pending > 0 ||
      repair.databasePending.kdf > 0 ||
      repair.databasePending.r2 > 0 ||
      repair.databasePending.images > 0;
    result = { ...status, repair };
    progress({ stage: "native_repair", repair });
    if (repair.completed) break;
  }
  return result;
}

export async function rebuildRestoredFts({ epoch, id, control }) {
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_unavailable");
  const raw = await control.rebuildRecoveryFts(epoch, id),
    status = sameRecoveryStatus(raw, selected);
  if (status.state !== "epoch_adopted") throw new Error("database_restore_recovery_conflict");
  return { ...status, audit: auditStatus(raw.audit, selected.newEpoch) };
}

/** One explicit bounded domain pass, including native abort/delete. Never retry RPC. */
export async function repairRestoredDomain({ epoch, id, kind, limit = 20, control }) {
  restoreDomainKind(kind);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("database_restore_invalid_recovery_limit");
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "epoch_adopted") throw new Error("database_restore_recovery_unavailable");
  const raw = await control.repairDomain(epoch, id, kind, limit),
    status = sameRecoveryStatus(raw, selected),
    r = raw.repair;
  if (status.state !== "epoch_adopted" || !r || r.kind !== kind || typeof r.pending !== "boolean")
    throw new Error("database_restore_invalid_domain_repair");
  const repair = { kind, pending: r.pending };
  const count = (v) => Number.isSafeInteger(v) && v >= 0 && v <= limit;
  if (kind === "single" || kind === "multipart") {
    const c = r.cleanup;
    if (
      !c ||
      ![c.claimed, c.absent, c.queued, c.retried, r.held].every(count) ||
      c.claimed !== c.absent + c.queued + c.retried ||
      c.claimed + r.held > limit ||
      (kind === "single" && r.held !== 0) ||
      !Number.isSafeInteger(c.r2Calls) ||
      c.r2Calls < 0 ||
      c.r2Calls > c.claimed * (kind === "single" ? 1 : 2)
    )
      throw new Error("database_restore_invalid_domain_repair");
    repair.cleanup = {
      claimed: c.claimed,
      absent: c.absent,
      queued: c.queued,
      retried: c.retried,
      r2Calls: c.r2Calls,
    };
    repair.held = r.held;
  } else if (kind === "blob-gc" || kind === "orphan-gc") {
    const c = r.cleanup,
      changed = kind === "orphan-gc" ? c?.changed : 0;
    if (
      !c ||
      ![c.claimed, c.deleted, c.retried, changed].every(count) ||
      c.claimed !== c.deleted + c.retried + changed ||
      !Number.isSafeInteger(c.r2Calls) ||
      c.r2Calls < 0 ||
      c.r2Calls > c.claimed * (kind === "blob-gc" ? 2 : 3)
    )
      throw new Error("database_restore_invalid_domain_repair");
    repair.cleanup = {
      claimed: c.claimed,
      deleted: c.deleted,
      retried: c.retried,
      r2Calls: c.r2Calls,
      ...(kind === "orphan-gc" ? { changed } : {}),
    };
  } else if (kind === "orphan-inventory") {
    const i = r.inventory;
    if (
      !i ||
      ![i.claimed, i.advanced, i.completed].every((v) => typeof v === "boolean") ||
      ![i.examined, i.observed].every(count) ||
      i.observed > i.examined ||
      !Number.isSafeInteger(i.r2Calls) ||
      i.r2Calls < 0 ||
      i.r2Calls > i.examined + 1 ||
      (!i.claimed && (i.examined !== 0 || i.observed !== 0 || i.r2Calls !== 0 || i.advanced)) ||
      (i.advanced && i.r2Calls < 1) ||
      (i.completed && !i.advanced) ||
      r.pending !== !i.completed
    )
      throw new Error("database_restore_invalid_domain_repair");
    repair.inventory = {
      claimed: i.claimed,
      examined: i.examined,
      observed: i.observed,
      advanced: i.advanced,
      completed: i.completed,
      r2Calls: i.r2Calls,
    };
  } else {
    const key = kind === "reservations" ? "released" : "failed";
    if (!count(r[key])) throw new Error("database_restore_invalid_domain_repair");
    repair[key] = r[key];
  }
  return { ...status, repair };
}

/** Hold release uses the exact completed audit. Service opens first; GC has a separate command. */
export async function resumeRestored({ epoch, id, control, gc = false }) {
  const selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (!released.includes(selected.state) && selected.state !== "epoch_adopted")
    throw new Error("database_restore_recovery_unavailable");
  if (gc && !["service_resumed", "gc_resumed"].includes(selected.state))
    throw new Error("database_restore_recovery_not_resumed");
  if (!gc) {
    const status = sameRecoveryStatus(await control.releaseRecovery(epoch, id), selected);
    if (!released.includes(status.state)) throw new Error("database_restore_invalid_status");
  }
  const raw = await (gc ? control.resumeRecoveryGc(epoch, id) : control.resumeRecovery(epoch, id)),
    status = sameRecoveryStatus(raw, selected);
  if (!(gc ? ["gc_resumed"] : ["service_resumed", "gc_resumed"]).includes(status.state))
    throw new Error("database_restore_invalid_status");
  // A replay of a completed GC step reports the current policy, including a later explicit pause.
  return { ...status, control: controlStatus(raw.control, selected.newEpoch) };
}
