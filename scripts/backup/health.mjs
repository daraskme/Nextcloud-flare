import {
  BACKUP_FRESHNESS_MS,
  BACKUP_INVENTORY_PAGE_SIZE,
  BACKUP_MAX_AGE_MS,
  BACKUP_MIN_GENERATIONS,
} from "../../packages/shared/src/backupRetention.ts";
import { generationId, manifestKey } from "./objectStore.mjs";
import { operatorIdentity, verifyStoredBackup } from "./operator.mjs";

export const HEALTH_MAX_PAGES = 100;
export const HEALTH_MAX_VERIFICATIONS = 100;
const timestamp = (n) => Number.isSafeInteger(n) && n >= 0;
const sameSnapshot = (a, b) => a.at === b.at && a.token === b.token && a.phase === b.phase;
const cursorFor = (snapshot, after) => ({ ...snapshot, after });

function pageShape(page, epoch, snapshot, after, observedAt) {
  const s = page?.snapshot;
  if (
    page?.epoch !== epoch ||
    !s ||
    !timestamp(s.at) ||
    !timestamp(page.observedAt) ||
    page.observedAt < s.at ||
    page.observedAt < observedAt ||
    ![null, "preparing", "frozen", "releasing", "released"].includes(s.phase) ||
    (s.phase === null) !== (s.token === null) ||
    (s.token !== null &&
      (typeof s.token !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s.token))) ||
    (snapshot && !sameSnapshot(snapshot, s)) ||
    !Array.isArray(page.rows) ||
    page.rows.length > BACKUP_INVENTORY_PAGE_SIZE
  )
    throw new Error("backup_invalid_inventory");
  if (page.active !== null) {
    operatorIdentity(page.active?.epoch, page.active?.id);
    if (
      page.active.epoch !== epoch ||
      !["preparing", "frozen", "releasing"].includes(page.active.phase) ||
      page.active.phase !== s.phase ||
      !timestamp(page.active.createdAt) ||
      page.active.createdAt > page.observedAt
    )
      throw new Error("backup_invalid_inventory");
  } else if (s.phase !== null && s.phase !== "released")
    throw new Error("backup_invalid_inventory");
  let last = after;
  for (const row of page.rows) {
    operatorIdentity(row?.epoch, row?.id);
    if (
      (last !== null && row.id <= last) ||
      row.epoch > epoch ||
      !timestamp(row.createdAt) ||
      !["pending", "exporting", "completed", "failed"].includes(row.state)
    )
      throw new Error("backup_invalid_inventory");
    last = row.id;
  }
  if (page.next !== null) {
    if (
      !page.next ||
      page.rows.length !== BACKUP_INVENTORY_PAGE_SIZE ||
      page.next.after !== last ||
      !sameSnapshot(page.next, s)
    )
      throw new Error("backup_invalid_inventory");
    generationId(page.next.after);
  }
  return last;
}

function validReceipt(row) {
  return (
    timestamp(row.completedAt) &&
    timestamp(row.releasedAt) &&
    row.completedAt >= row.createdAt &&
    row.releasedAt >= row.createdAt &&
    row.manifestKey === manifestKey(row.id) &&
    typeof row.manifestSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(row.manifestSha256)
  );
}
function errorCode(error) {
  const message = error instanceof Error ? error.message : "";
  return /^backup_[a-z_]+$/.test(message) ? message : "backup_verification_failed";
}

/** Full stored SQL verification is mandatory. Injectable verifier is an internal test adapter. */
export async function inspectBackupHealth({
  epoch,
  control,
  store,
  progress = () => {},
  verify = verifyStoredBackup,
}) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_backup_request");
  let snapshot,
    cursor,
    after = null,
    observedAt = 0,
    active = null,
    complete = false;
  const rows = [];
  for (let pages = 0; pages < HEALTH_MAX_PAGES; pages++) {
    const page = await control.inventory(epoch, cursor);
    after = pageShape(page, epoch, snapshot, after, observedAt);
    snapshot ??= page.snapshot;
    observedAt = page.observedAt;
    active = page.active;
    rows.push(...page.rows);
    if (page.next === null) {
      complete = true;
      break;
    }
    cursor = page.next;
  }
  // Newest first makes limited or interrupted verification useful without claiming full coverage.
  const completed = rows
    .filter((row) => row.state === "completed")
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let attempts = 0;
  const generations = [];
  for (const row of completed) {
    const item = { id: row.id, epoch: row.epoch, createdAt: row.createdAt, status: "expired" };
    generations.push(item);
    if (observedAt - row.createdAt > BACKUP_MAX_AGE_MS) continue;
    if (
      row.createdAt > observedAt ||
      !validReceipt(row) ||
      row.completedAt > observedAt ||
      row.releasedAt > observedAt
    ) {
      Object.assign(item, { status: "invalid", error: "backup_invalid_receipt" });
      continue;
    }
    if (attempts >= HEALTH_MAX_VERIFICATIONS) {
      item.status = "unchecked";
      complete = false;
      continue;
    }
    attempts++;
    try {
      const result = await verify({ ...row, store, progress });
      if (
        result?.id !== row.id ||
        result.epoch !== row.epoch ||
        result.createdAt !== row.createdAt ||
        result.manifestSha256 !== row.manifestSha256 ||
        !Number.isSafeInteger(result.bytes) ||
        result.bytes < 1
      )
        throw new Error("backup_invalid_verification");
      Object.assign(item, { status: "eligible", bytes: result.bytes });
    } catch (error) {
      Object.assign(item, { status: "invalid", error: errorCode(error) });
    }
    progress({ stage: "health_verified", id: row.id, status: item.status, attempts });
  }
  // Check epoch/backup ownership and server time again AFTER all downloads. A runner clock
  // never decides eligibility, and a generation can expire during verification.
  const final = await control.inventory(epoch, cursorFor(snapshot, after));
  pageShape(final, epoch, snapshot, after, observedAt);
  if (complete && (final.rows.length !== 0 || final.next !== null))
    throw new Error("backup_inventory_changed");
  observedAt = final.observedAt;
  active = final.active;
  for (const item of generations) {
    item.ageMs = observedAt - item.createdAt;
    if (item.ageMs > BACKUP_MAX_AGE_MS) item.status = "expired";
  }
  const eligible = generations.filter((row) => row.status === "eligible");
  const latestCreatedAt = eligible[0]?.createdAt ?? null;
  const alerts = [];
  if (!complete) alerts.push("backup_health_incomplete");
  if (generations.some((row) => row.status === "invalid")) alerts.push("backup_generation_invalid");
  if (eligible.length < BACKUP_MIN_GENERATIONS) alerts.push("backup_generations_insufficient");
  if (latestCreatedAt === null || observedAt - latestCreatedAt > BACKUP_FRESHNESS_MS)
    alerts.push("backup_daily_missing");
  return {
    healthy: alerts.length === 0,
    epoch,
    observedAt,
    startedAt: snapshot.at,
    complete,
    eligible: eligible.length,
    missing: Math.max(0, BACKUP_MIN_GENERATIONS - eligible.length),
    latestCreatedAt,
    active,
    policy: {
      maximumAgeMs: BACKUP_MAX_AGE_MS,
      minimumGenerations: BACKUP_MIN_GENERATIONS,
      freshnessMs: BACKUP_FRESHNESS_MS,
    },
    scanned: rows.length,
    verified: attempts,
    alerts,
    generations,
    scope:
      "Logical SQL generations verified against immutable D1 receipts and stored R2 bytes; source BLOBS availability, independent replication and live restore are separate.",
  };
}
