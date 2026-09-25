import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BACKUP_INVENTORY_PAGE_SIZE,
  BACKUP_MAX_AGE_MS,
} from "../../packages/shared/src/backupRetention.ts";
import {
  HEALTH_MAX_PAGES,
  HEALTH_MAX_VERIFICATIONS,
  inspectBackupHealth,
} from "../backup/health.mjs";
import { manifestKey } from "../backup/objectStore.mjs";
import { publishGeneration } from "../backup/publication.mjs";
import { fixtureGeneration } from "./fixtures/backup.mjs";

const day = 86400000,
  now = Date.UTC(2026, 8, 25, 12);
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let rows, serverNow, control, verify;
function receipt(n, age = n * day) {
  const id = uuid(n);
  return {
    id,
    epoch: 1,
    state: "completed",
    createdAt: now - age,
    completedAt: now,
    releasedAt: now,
    manifestKey: manifestKey(id),
    manifestSha256: "a".repeat(64),
  };
}
function inventory() {
  return vi.fn(async (epoch, cursor) => {
    const snapshot = cursor
      ? { at: cursor.at, token: cursor.token, phase: cursor.phase }
      : { at: serverNow, token: null, phase: null };
    const found = rows
      .filter((r) => r.id > (cursor?.after ?? ""))
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = found.slice(0, BACKUP_INVENTORY_PAGE_SIZE);
    return {
      epoch,
      snapshot,
      observedAt: serverNow,
      active: null,
      rows: page,
      next: found.length > page.length ? { ...snapshot, after: page.at(-1).id } : null,
    };
  });
}
beforeEach(() => {
  rows = Array.from({ length: 5 }, (_, i) => receipt(i));
  serverNow = now;
  control = { inventory: inventory() };
  verify = vi.fn(async (row) => ({
    id: row.id,
    epoch: row.epoch,
    createdAt: row.createdAt,
    manifestSha256: row.manifestSha256,
    bytes: 100,
  }));
});
afterEach(() => vi.restoreAllMocks());
const inspect = () => inspectBackupHealth({ epoch: 2, control, store: {}, verify });

it("requires five distinct verified completed generations and ignores the runner clock", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now + 500 * day);
  const result = await inspect();
  expect(result).toMatchObject({
    healthy: true,
    complete: true,
    eligible: 5,
    missing: 0,
    observedAt: now,
    latestCreatedAt: now,
    alerts: [],
  });
  expect(verify).toHaveBeenCalledTimes(5);
  expect(control.inventory).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain("token");
});
it.each([BACKUP_MAX_AGE_MS - 1, BACKUP_MAX_AGE_MS, BACKUP_MAX_AGE_MS + 1])(
  "uses the maximum-age boundary %s ms",
  async (age) => {
    rows[4] = receipt(4, age);
    const result = await inspect();
    expect(result.eligible).toBe(age > BACKUP_MAX_AGE_MS ? 4 : 5);
    expect(result.healthy).toBe(age <= BACKUP_MAX_AGE_MS);
    expect(result.generations.find((r) => r.id === uuid(4)).status).toBe(
      age > BACKUP_MAX_AGE_MS ? "expired" : "eligible",
    );
  },
);
it("does not revive expired exports with recent completion times or the minimum-five rule", async () => {
  rows = Array.from({ length: 5 }, (_, i) => receipt(i, BACKUP_MAX_AGE_MS + 1));
  const result = await inspect();
  expect(result).toMatchObject({ healthy: false, eligible: 0, missing: 5 });
  expect(result.alerts).toEqual(["backup_generations_insufficient", "backup_daily_missing"]);
  expect(verify).not.toHaveBeenCalled();
});
it("expires an export using the final server time after its data verification", async () => {
  rows[4] = receipt(4, BACKUP_MAX_AGE_MS);
  const original = verify;
  verify = vi.fn(async (row) => {
    const result = await original(row);
    serverNow = now + 1;
    return result;
  });
  const result = await inspect();
  expect(result).toMatchObject({ observedAt: now + 1, eligible: 4, missing: 1, healthy: false });
});
it.each([day, day + 1])(
  "alerts on stale daily capture at %s ms even with five valid generations",
  async (age) => {
    rows = Array.from({ length: 5 }, (_, i) => receipt(i, age + i * day));
    const result = await inspect();
    expect(result.eligible).toBe(5);
    expect(result.alerts).toEqual(age > day ? ["backup_daily_missing"] : []);
  },
);
it("does not count pending, exporting or failed receipts", async () => {
  rows[0].state = "pending";
  rows[1].state = "exporting";
  rows[2].state = "failed";
  const result = await inspect();
  expect(result.eligible).toBe(2);
  expect(verify).toHaveBeenCalledTimes(2);
});
it.each(["manifest", "completion", "release", "future capture", "future completion"])(
  "refuses an invalid %s receipt without verifying it",
  async (kind) => {
    if (kind === "manifest") rows[0].manifestKey = manifestKey(uuid(9));
    if (kind === "completion") rows[0].completedAt = null;
    if (kind === "release") rows[0].releasedAt = now - 1;
    if (kind === "future capture") rows[0].createdAt = now + 1;
    if (kind === "future completion") rows[0].completedAt = now + 1;
    const result = await inspect();
    expect(result.eligible).toBe(4);
    expect(result.alerts).toContain("backup_generation_invalid");
    expect(verify).toHaveBeenCalledTimes(4);
  },
);
it("reports failed stored verification without leaking provider URLs, SQL or credentials", async () => {
  verify.mockRejectedValueOnce(
    new Error("https://signed.invalid/?secret=canary INSERT INTO users VALUES('private')"),
  );
  const result = await inspect();
  expect(result.eligible).toBe(4);
  expect(result.generations.find((r) => r.status === "invalid").error).toBe(
    "backup_verification_failed",
  );
  expect(JSON.stringify(result)).not.toMatch(/canary|signed\.invalid|INSERT|private/);
});
it("does not accept verification of a different generation", async () => {
  verify.mockResolvedValueOnce({ ...rows[0], id: uuid(99), bytes: 100 });
  expect((await inspect()).generations.find((r) => r.status === "invalid").error).toBe(
    "backup_invalid_verification",
  );
});
it("deduplicates by rejecting repeated catalogue identities before counting or downloading", async () => {
  rows[1].id = rows[0].id;
  await expect(inspect()).rejects.toThrow("backup_invalid_inventory");
  expect(verify).not.toHaveBeenCalled();
});
it.each(["epoch", "clock", "active", "next", "order"])(
  "rejects malformed %s inventory responses",
  async (kind) => {
    const page = await control.inventory(2);
    if (kind === "epoch") page.epoch = 3;
    if (kind === "clock") page.observedAt = page.snapshot.at - 1;
    if (kind === "active") page.active = { id: uuid(6), epoch: 2, phase: "frozen", createdAt: now };
    if (kind === "next") page.next = { ...page.snapshot, after: uuid(99) };
    if (kind === "order") page.rows.reverse();
    control.inventory.mockResolvedValueOnce(page);
    await expect(inspect()).rejects.toThrow("backup_invalid_inventory");
  },
);
it("requires a final unchanged authority after the R2 downloads", async () => {
  const original = verify;
  verify = vi.fn(async (row) => {
    const result = await original(row);
    control.inventory.mockRejectedValueOnce(new Error("backup_inventory_changed"));
    return result;
  });
  await expect(inspect()).rejects.toThrow("backup_inventory_changed");
});
it("detects an inventory that prematurely claims its last page", async () => {
  rows = Array.from({ length: 101 }, (_, i) => receipt(i, 0));
  const page = await control.inventory(2);
  page.next = null;
  control.inventory.mockResolvedValueOnce(page);
  await expect(inspect()).rejects.toThrow("backup_inventory_changed");
});
it("reports incomplete coverage instead of success when the verification budget is exhausted", async () => {
  rows = Array.from({ length: HEALTH_MAX_VERIFICATIONS + 1 }, (_, i) => receipt(i, 0));
  const result = await inspect();
  expect(result).toMatchObject({
    healthy: false,
    complete: false,
    eligible: HEALTH_MAX_VERIFICATIONS,
  });
  expect(result.alerts).toEqual(["backup_health_incomplete"]);
  expect(result.generations.filter((r) => r.status === "unchecked")).toHaveLength(1);
  expect(verify).toHaveBeenCalledTimes(HEALTH_MAX_VERIFICATIONS);
});
it("bounds catalogue traversal and marks an unfinished scan unhealthy", async () => {
  rows = Array.from({ length: HEALTH_MAX_PAGES * BACKUP_INVENTORY_PAGE_SIZE + 1 }, (_, i) => ({
    ...receipt(i, 0),
    state: "failed",
  }));
  const result = await inspect();
  expect(result).toMatchObject({ healthy: false, complete: false, scanned: 10000 });
  expect(result.alerts).toContain("backup_health_incomplete");
  expect(control.inventory).toHaveBeenCalledTimes(HEALTH_MAX_PAGES + 1);
  expect(verify).not.toHaveBeenCalled();
});

it("verifies five real stored SQL generations and excludes a corrupted part on the next inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "backup-health-"));
  const objects = new Map();
  const store = {
    get: async (key) => objects.get(key) ?? null,
    put: async (key, bytes) => {
      if (objects.has(key)) return false;
      objects.set(key, Buffer.from(bytes));
      return true;
    },
  };
  try {
    rows = [];
    for (let i = 0; i < 5; i++) {
      const artifact = await fixtureGeneration(join(root, String(i)));
      const publication = await publishGeneration({ directory: artifact.directory, store });
      const { id, epoch, createdAt } = artifact.manifest.generation;
      rows.push({
        id,
        epoch,
        state: "completed",
        createdAt,
        completedAt: createdAt,
        releasedAt: createdAt,
        manifestKey: manifestKey(id),
        manifestSha256: publication.sha256,
      });
    }
    serverNow = Date.now();
    control = { inventory: inventory() };
    const result = await inspectBackupHealth({ epoch: 2, control, store });
    expect(result).toMatchObject({ healthy: true, eligible: 5, missing: 0 });
    const part = [...objects.keys()].find((key) => key.includes("/parts/"));
    objects.set(part, Buffer.from("corrupt"));
    expect(await inspectBackupHealth({ epoch: 2, control, store })).toMatchObject({
      healthy: false,
      eligible: 4,
      missing: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
