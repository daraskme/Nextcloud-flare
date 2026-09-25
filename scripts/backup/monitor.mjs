import { randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MONITOR_FRESHNESS_MS = 24 * 60 * 60 * 1000;
export const MONITOR_RUN_MS = 6 * 60 * 60 * 1000;
const DELIVERY_LEASE_MS = 30000;
const timestamp = (n) => Number.isSafeInteger(n) && n >= 0;
const uuid = (s) =>
  typeof s === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);

/** Local operator observations only. This database never grants or releases a backup barrier. */
export async function openBackupMonitor(directory) {
  if (typeof directory !== "string" || !directory) throw new Error("backup_monitor_directory");
  const root = resolve(directory),
    path = join(root, "monitor.sqlite");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  await file.close();
  await chmod(path, 0o600);
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS backup_monitor_run(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        run_id TEXT NOT NULL,epoch INTEGER,started_at INTEGER NOT NULL,
        finished_at INTEGER,exit_code INTEGER,
        last_finished_at INTEGER,last_exit_code INTEGER,last_success_at INTEGER,
        CHECK((finished_at IS NULL)=(exit_code IS NULL)),
        CHECK(exit_code IN (0,1,2)),CHECK(last_exit_code IN (0,1,2))
      );
      CREATE TABLE IF NOT EXISTS backup_monitor_delivery(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),source TEXT NOT NULL,
        delivered_fingerprint TEXT,pending_id TEXT,pending_fingerprint TEXT,
        pending_body TEXT,lease_until INTEGER,pending_incident_id TEXT
      );
      CREATE TABLE IF NOT EXISTS backup_monitor_incident(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,body TEXT NOT NULL
      );`);
    return new BackupMonitor(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

class BackupMonitor {
  constructor(db) {
    this.db = db;
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  row() {
    return this.db.prepare("SELECT * FROM backup_monitor_run WHERE singleton=1").get();
  }
  begin(epoch, now = Date.now()) {
    if ((epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 1)) || !timestamp(now))
      throw new Error("backup_monitor_invalid_record");
    return this.transaction(() => {
      const before = this.row();
      if (before && before.finished_at === null) throw new Error("backup_monitor_run_active");
      if (before && now < before.finished_at) throw new Error("backup_monitor_clock_conflict");
      const id = randomUUID();
      this.db
        .prepare(`INSERT INTO backup_monitor_run(singleton,run_id,epoch,started_at)
        VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET run_id=excluded.run_id,
        epoch=excluded.epoch,started_at=excluded.started_at,finished_at=NULL,exit_code=NULL`)
        .run(id, epoch, now);
      return id;
    });
  }
  finish(id, exitCode, now = Date.now()) {
    if (!uuid(id) || ![0, 1, 2].includes(exitCode) || !timestamp(now))
      throw new Error("backup_monitor_invalid_record");
    return this.transaction(() => {
      const row = this.row();
      if (!row || row.run_id !== id) throw new Error("backup_monitor_run_changed");
      if (row.finished_at !== null) {
        if (row.exit_code !== exitCode) throw new Error("backup_monitor_run_changed");
        return; // An identical completion replay cannot refresh the last-success clock.
      }
      if (now < row.started_at) throw new Error("backup_monitor_clock_conflict");
      this.db
        .prepare(`UPDATE backup_monitor_run SET finished_at=?,exit_code=?,
        last_finished_at=?,last_exit_code=?,last_success_at=CASE WHEN ?=0 THEN ? ELSE last_success_at END
        WHERE singleton=1 AND run_id=? AND finished_at IS NULL`)
        .run(now, exitCode, now, exitCode, exitCode, now, id);
      if (exitCode !== 0) {
        // Preserve the first unacknowledged failure even if a retry finishes before the next watchdog tick.
        this.db
          .prepare("INSERT OR IGNORE INTO backup_monitor_incident VALUES(1,?,?)")
          .run(randomUUID(), JSON.stringify(this.inspect({ now })));
      }
    });
  }
  inspect({ now = Date.now(), maxRunMs = MONITOR_RUN_MS } = {}) {
    if (
      !timestamp(now) ||
      !Number.isSafeInteger(maxRunMs) ||
      maxRunMs < 1 ||
      maxRunMs > MONITOR_FRESHNESS_MS
    )
      throw new Error("backup_monitor_invalid_policy");
    const row = this.row(),
      issues = [];
    if (!row) issues.push("backup_monitor_uninitialized");
    else {
      if (
        [row.started_at, row.finished_at, row.last_success_at, row.last_finished_at].some(
          (t) => t !== null && t > now,
        )
      )
        issues.push("backup_monitor_clock_conflict");
      if (row.finished_at === null && now - row.started_at > maxRunMs)
        issues.push("backup_monitor_run_overdue");
      if (row.last_success_at === null) issues.push("backup_monitor_no_success");
      else if (now - row.last_success_at > MONITOR_FRESHNESS_MS)
        issues.push("backup_monitor_success_overdue");
      if (row.last_exit_code === 1) issues.push("backup_monitor_run_failed");
      if (row.last_exit_code === 2) issues.push("backup_monitor_run_unhealthy");
    }
    issues.sort();
    return {
      healthy: issues.length === 0,
      observedAt: now,
      issues,
      run: row
        ? {
            id: row.run_id,
            epoch: row.epoch,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            exitCode: row.exit_code,
            lastFinishedAt: row.last_finished_at,
            lastExitCode: row.last_exit_code,
            lastSuccessAt: row.last_success_at,
          }
        : null,
    };
  }
  async notify({ source, send, now = Date.now(), maxRunMs = MONITOR_RUN_MS }) {
    if (
      typeof source !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(source) ||
      typeof send !== "function"
    )
      throw new Error("backup_monitor_unconfigured");
    const plan = this.transaction(() => {
      const status = this.inspect({ now, maxRunMs });
      this.db
        .prepare("INSERT OR IGNORE INTO backup_monitor_delivery(singleton,source) VALUES(1,?)")
        .run(source);
      const delivery = this.db
        .prepare("SELECT * FROM backup_monitor_delivery WHERE singleton=1")
        .get();
      if (delivery.source !== source) throw new Error("backup_monitor_source_changed");
      // Retry the same durable event after unknown outcomes, even if health has since changed.
      if (delivery.pending_id) {
        if (delivery.lease_until > now && delivery.lease_until <= now + DELIVERY_LEASE_MS)
          return { status, waiting: true };
        this.db
          .prepare("UPDATE backup_monitor_delivery SET lease_until=? WHERE singleton=1")
          .run(now + DELIVERY_LEASE_MS);
        return { status, event: JSON.parse(delivery.pending_body) };
      }
      let incident = this.db
        .prepare("SELECT * FROM backup_monitor_incident WHERE singleton=1")
        .get();
      if (
        incident &&
        delivery.delivered_fingerprint === JSON.stringify(JSON.parse(incident.body).issues)
      ) {
        // A previous alert already covers this unchanged failure; keep the current observation below.
        this.db.prepare("DELETE FROM backup_monitor_incident WHERE id=?").run(incident.id);
        incident = undefined;
      }
      const observation = incident ? JSON.parse(incident.body) : status;
      const fingerprint = JSON.stringify(observation.issues);
      if (delivery.delivered_fingerprint === fingerprint) return { status };
      if (delivery.delivered_fingerprint === null && observation.healthy) {
        this.db
          .prepare("UPDATE backup_monitor_delivery SET delivered_fingerprint=? WHERE singleton=1")
          .run(fingerprint);
        return { status }; // A healthy installation is quiet until its first incident.
      }
      const event = {
        version: 1,
        id: randomUUID(),
        source,
        type: observation.healthy ? "backup.recovered" : "backup.alert",
        ...observation,
      };
      this.db
        .prepare(`UPDATE backup_monitor_delivery SET pending_id=?,pending_fingerprint=?,
        pending_body=?,lease_until=?,pending_incident_id=? WHERE singleton=1`)
        .run(
          event.id,
          fingerprint,
          JSON.stringify(event),
          now + DELIVERY_LEASE_MS,
          incident?.id ?? null,
        );
      return { status, event };
    });
    if (!plan.event) return { ...plan.status, notified: false, pending: plan.waiting === true };
    try {
      await send(plan.event);
    } catch {
      throw new Error("backup_monitor_delivery_failed");
    }
    // Commit acknowledgement only for this event. A late response cannot acknowledge a newer event.
    this.transaction(() => {
      this.db
        .prepare(`DELETE FROM backup_monitor_incident WHERE id=(
        SELECT pending_incident_id FROM backup_monitor_delivery WHERE singleton=1 AND pending_id=?)`)
        .run(plan.event.id);
      this.db
        .prepare(`UPDATE backup_monitor_delivery SET delivered_fingerprint=pending_fingerprint,
        pending_id=NULL,pending_fingerprint=NULL,pending_body=NULL,lease_until=NULL,pending_incident_id=NULL
        WHERE singleton=1 AND pending_id=?`)
        .run(plan.event.id);
    });
    return {
      ...plan.status,
      notified: true,
      notificationId: plan.event.id,
      pending: JSON.stringify(plan.event.issues) !== JSON.stringify(plan.status.issues),
    };
  }
}

/** Called by the maintain CLI; closing the handle never pretends an interrupted run completed. */
export async function beginBackupMonitoring(directory, epoch) {
  const monitor = await openBackupMonitor(directory);
  let id;
  try {
    id = monitor.begin(epoch);
  } catch (error) {
    monitor.close();
    throw error;
  }
  return {
    finish(exitCode) {
      try {
        monitor.finish(id, exitCode);
      } finally {
        monitor.close();
      }
    },
  };
}
