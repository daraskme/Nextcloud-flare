import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const D1_ID = RUN_ID;
const root = fileURLToPath(new URL("../..", import.meta.url));

export function resourceNames(id) {
  if (!RUN_ID.test(id)) throw new Error("fault_invalid_run_id");
  const suffix = id.replaceAll("-", "").slice(0, 16);
  return Object.freeze({
    worker: `ncf-fault-${suffix}`,
    d1: `ncf-fault-${suffix}`,
    blobs: `ncf-fault-${suffix}-blobs`,
    backups: `ncf-fault-${suffix}-backups`,
    queue: `ncf-fault-${suffix}-jobs`,
    dlq: `ncf-fault-${suffix}-dlq`,
  });
}

export function validateLedger(ledger) {
  if (
    ledger?.version !== 1 ||
    !RUN_ID.test(ledger.id ?? "") ||
    JSON.stringify(ledger.names) !== JSON.stringify(resourceNames(ledger.id)) ||
    !Array.isArray(ledger.created) ||
    new Set(ledger.created.map((entry) => entry.kind)).size !== ledger.created.length ||
    ledger.created.some(
      (entry) =>
        !["d1", "blobs", "backups", "queue", "dlq", "worker"].includes(entry?.kind) ||
        entry.name !== ledger.names[entry.kind] ||
        (entry.kind === "d1" && !D1_ID.test(entry.uuid ?? "")),
    ) ||
    (ledger.removed !== undefined &&
      (!Array.isArray(ledger.removed) ||
        new Set(ledger.removed).size !== ledger.removed.length ||
        ledger.removed.some((kind) => !ledger.created.some((entry) => entry.kind === kind)))) ||
    (ledger.detached !== undefined &&
      (!Array.isArray(ledger.detached) ||
        new Set(ledger.detached).size !== ledger.detached.length ||
        ledger.detached.some((kind) => !["queue", "dlq"].includes(kind))))
  )
    throw new Error("fault_invalid_ledger");
  return ledger;
}

export function faultWorkerConfig({ ledger, accountId, armed = false }) {
  validateLedger(ledger);
  if (!ACCOUNT_ID.test(accountId ?? "") || typeof armed !== "boolean")
    throw new Error("fault_invalid_config");
  const d1 = ledger.created.find((entry) => entry.kind === "d1");
  if (!d1) throw new Error("fault_d1_not_created");
  const names = ledger.names;
  return {
    name: names.worker,
    main: resolve(root, "ops/staging/fault-worker.ts"),
    account_id: accountId,
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: names.d1,
        database_id: d1.uuid,
        migrations_dir: resolve(root, "packages/worker/migrations"),
      },
    ],
    r2_buckets: [
      { binding: "BLOBS", bucket_name: names.blobs },
      { binding: "BACKUPS", bucket_name: names.backups },
    ],
    durable_objects: {
      bindings: [
        { name: "CONTROL", class_name: "ControlDO" },
        { name: "LOCKS", class_name: "LockDO" },
        { name: "FAULT_STATE", class_name: "FaultStateDO" },
      ],
    },
    migrations: [
      { tag: "fault-v1-sqlite", new_sqlite_classes: ["ControlDO", "LockDO", "FaultStateDO"] },
    ],
    queues: {
      producers: [{ binding: "JOBS", queue: names.queue }],
      consumers: [
        {
          queue: names.queue,
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 2,
          dead_letter_queue: names.dlq,
          max_concurrency: 1,
        },
        {
          queue: names.dlq,
          max_batch_size: 1,
          max_batch_timeout: 1,
          max_retries: 3,
          max_concurrency: 1,
        },
      ],
    },
    triggers: { crons: ["* * * * *"] },
    vars: {
      ENVIRONMENT: "staging",
      EPOCH_FLOOR: "2",
      JOBS_QUEUE_NAME: names.queue,
      JOBS_DLQ_NAME: names.dlq,
      FAULT_RUN_ID: ledger.id,
      FAULT_ARMED: armed ? "true" : "false",
      // These are never used by public HTTP; fetch always returns 404.
      APP_ORIGIN: "https://fault.invalid",
      CONTENT_ORIGIN: "https://fault-content.invalid",
      PBKDF2_ITERATIONS: "100000",
    },
  };
}

export async function writeFaultConfig(ledgerPath, accountId, armed = false) {
  const ledger = validateLedger(JSON.parse(await readFile(ledgerPath, "utf8")));
  const config = faultWorkerConfig({ ledger, accountId, armed });
  const path = resolve(ledgerPath, "..", armed ? "wrangler-armed.json" : "wrangler.json");
  const encoded = `${JSON.stringify(config, null, 2)}\n`;
  try {
    await writeFile(path, encoded, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST" || (await readFile(path, "utf8")) !== encoded)
      throw new Error("fault_config_conflict");
  }
  return path;
}
