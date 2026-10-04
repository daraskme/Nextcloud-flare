import { execFile } from "node:child_process";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateLedger, writeFaultConfig } from "./fault-config.mjs";

const executeFile = promisify(execFile);
const wrangler = fileURLToPath(
  new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const prepareImport = fileURLToPath(new URL("./prepare-d1-trigger-import.mjs", import.meta.url));
const accountPattern = /^[a-f0-9]{32}$/;

export async function readLedger(path) {
  const parent = await lstat(dirname(resolve(path)));
  if (!parent.isDirectory() || (process.platform !== "win32" && (parent.mode & 0o077) !== 0))
    throw new Error("fault_ledger_permissions");
  const stat = await lstat(path);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new Error("fault_ledger_permissions");
  return validateLedger(JSON.parse(await readFile(path, "utf8")));
}

async function saveLedger(path, ledger) {
  validateLedger(ledger);
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

export function cloudflareClient(env) {
  if (!accountPattern.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") || !env.CLOUDFLARE_API_TOKEN)
    throw new Error("fault_credentials_unavailable");
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  return async (path, method = "GET", body) => {
    let response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("fault_cloudflare_unavailable");
    }
    if (response.status === 204) return null;
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`fault_cloudflare_http_${response.status}`);
    }
    if (!response.ok || data?.success !== true) {
      const firstCode = data?.errors?.[0]?.code;
      const code =
        Number.isSafeInteger(firstCode) && firstCode >= 0 && firstCode <= 999999
          ? `_code_${firstCode}`
          : "";
      const message = String(data?.errors?.[0]?.message ?? "").toLowerCase();
      const reason = [
        ["durable", "durable object"],
        ["migration", "migration"],
        ["namespace", "namespace"],
        ["reference", "referenc"],
        ["permission", "permission"],
        ["binding", "binding"],
        ["auth", "authoriz"],
        ["scope", "scope"],
        ["worker", "worker"],
        ["resource", "resource"],
        ["script", "script"],
        ["delete", "delet"],
      ]
        .filter(([, pattern]) => message.includes(pattern))
        .map(([label]) => label)
        .join("_");
      // Keep the API text private; only these fixed categories can reach CLI output.
      const detail = message.includes("protected")
        ? "_protected"
        : message.includes("active")
          ? "_active"
          : message.includes("class")
            ? "_class"
            : message.includes("in use")
              ? "_in_use"
              : "";
      const permitted = new Set([
        "cannot",
        "can",
        "not",
        "delete",
        "worker",
        "workers",
        "because",
        "of",
        "durable",
        "object",
        "objects",
        "deployment",
        "deployments",
        "active",
        "attached",
        "queue",
        "consumer",
        "consumers",
        "schedule",
        "trigger",
        "triggers",
        "script",
        "scripts",
        "permission",
        "permissions",
        "allowed",
        "account",
        "requires",
        "force",
        "class",
        "classes",
        "namespace",
        "namespaces",
        "is",
        "in",
        "use",
        "by",
        "another",
        "referenced",
        "you",
        "are",
        "authorized",
        "request",
        "this",
        "resource",
        "has",
        "a",
        "the",
        "to",
        "from",
        "with",
        "must",
        "first",
        "remove",
      ]);
      const words = (message.match(/[a-z]+/g) ?? [])
        .filter((word) => permitted.has(word))
        .slice(0, 25)
        .join("_");
      throw new Error(
        `fault_cloudflare_http_${response.status}${code}${reason ? `_${reason}` : ""}${detail}${words ? `_${words}` : ""}`,
      );
    }
    return data.result;
  };
}

async function wranglerCall(args) {
  try {
    await executeFile(process.execPath, [wrangler, ...args], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
      },
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // Wrangler output can include account and resource details; callers see a fixed code.
    throw new Error("fault_wrangler_failed");
  }
}

async function migrationNames(call, uuid) {
  const table = await call(`/d1/database/${uuid}/query`, "POST", {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
  });
  if (!table?.[0]?.results?.length) return [];
  const result = await call(`/d1/database/${uuid}/query`, "POST", {
    sql: "SELECT name FROM d1_migrations ORDER BY id",
  });
  const rows = result?.[0]?.results;
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.name !== "string"))
    throw new Error("fault_migration_state_unknown");
  return rows.map((row) => row.name);
}

export function migrationImportPlan(local, applied) {
  if (
    !Array.isArray(local) ||
    local.length < 3 ||
    local[0] !== "0001_foundation.sql" ||
    local[1] !== "0002_content_media.sql" ||
    local[2] !== "0003_invariant_guards.sql" ||
    local.some(
      (name, index) =>
        !/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || (index > 0 && name <= local[index - 1]),
    ) ||
    !Array.isArray(applied) ||
    applied.some((name, index) => name !== local[index]) ||
    applied.length > local.length ||
    applied.length === 1
  )
    throw new Error("fault_migration_state_conflict");
  // An empty database first needs Wrangler's foundation import. No trigger-safe
  // suffix can be planned until its applied prefix has been re-read.
  if (applied.length === 0) return [];
  const ranges = [];
  let cursor = applied.length;
  while (cursor < local.length) {
    if (cursor < 2) throw new Error("fault_migration_state_conflict");
    // 0003 installs trigger bodies and is imported separately after Wrangler's first two.
    const end = cursor === 2 ? 2 : Math.min(cursor + 46, local.length - 1);
    ranges.push({ first: local[cursor], last: local[end], before: cursor, after: end + 1 });
    cursor = end + 1;
  }
  return ranges;
}

async function importRange(configPath, databaseName, first, last, expectedBefore, expectedAfter) {
  let manifest;
  try {
    const output = await executeFile(process.execPath, [prepareImport, first, last], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    manifest = JSON.parse(output.stdout);
  } catch {
    throw new Error("fault_migration_prepare_failed");
  }
  if (
    manifest?.first !== first ||
    manifest?.last !== last ||
    manifest?.precedingMigrations !== expectedBefore ||
    manifest?.expectedTotalMigrations !== expectedAfter ||
    typeof manifest.path !== "string" ||
    !/^\/tmp\/ncf-d1-trigger-import-[^/]+\/[0-9]{4}-[0-9]{4}\.sql$/.test(manifest.path)
  )
    throw new Error("fault_migration_prepare_invalid");
  try {
    await wranglerCall([
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--config",
      configPath,
      "--file",
      manifest.path,
      "--yes",
    ]);
  } finally {
    await rm(dirname(manifest.path), { recursive: true, force: true });
  }
}

async function applyFaultMigrations(call, ledger, configPath) {
  const uuid = ledger.created.find((entry) => entry.kind === "d1")?.uuid;
  if (!uuid) throw new Error("fault_d1_not_created");
  const local = (await readdir(new URL("../../packages/worker/migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  let names = await migrationNames(call, uuid);
  migrationImportPlan(local, names);
  if (names.length === 0) {
    // Wrangler /query applies the first two files but may split trigger bodies in 0003.
    try {
      await wranglerCall([
        "d1",
        "migrations",
        "apply",
        ledger.names.d1,
        "--remote",
        "--config",
        configPath,
      ]);
    } catch {
      // Reconcile exact migration records before taking the documented /import path.
    }
    names = await migrationNames(call, uuid);
  }
  for (const range of migrationImportPlan(local, names)) {
    await importRange(
      configPath,
      ledger.names.d1,
      range.first,
      range.last,
      range.before,
      range.after,
    );
    names = await migrationNames(call, uuid);
    if (names.length !== range.after) throw new Error("fault_migration_state_conflict");
    migrationImportPlan(local, names);
  }
  if (names.length !== local.length) throw new Error("fault_migration_state_conflict");
}

/** Resources are created one at a time and recorded immediately before any dependent step. */
export async function provisionFaultResources(ledgerPath, env = process.env) {
  const call = cloudflareClient(env);
  const ledger = await readLedger(ledgerPath);
  if (ledger.created.some((entry) => entry.kind === "worker"))
    return { stage: "already_deployed", created: ledger.created.length };
  const steps = [
    { kind: "d1", path: "/d1/database", body: { name: ledger.names.d1 } },
    { kind: "blobs", path: "/r2/buckets", body: { name: ledger.names.blobs } },
    { kind: "backups", path: "/r2/buckets", body: { name: ledger.names.backups } },
    { kind: "dlq", path: "/queues", body: { queue_name: ledger.names.dlq } },
    { kind: "queue", path: "/queues", body: { queue_name: ledger.names.queue } },
  ];
  for (const step of steps) {
    if (ledger.created.some((entry) => entry.kind === step.kind)) continue;
    const result = await call(step.path, "POST", step.body);
    const record = {
      kind: step.kind,
      name: ledger.names[step.kind],
      ...(step.kind === "d1" ? { uuid: result?.uuid } : {}),
      ...(step.kind === "dlq" || step.kind === "queue" ? { queueId: result?.queue_id } : {}),
    };
    if (step.kind === "d1" && !/^[0-9a-f-]{36}$/.test(record.uuid ?? ""))
      throw new Error("fault_d1_create_unknown");
    ledger.created.push(record);
    await saveLedger(ledgerPath, ledger);
  }
  const configPath = await writeFaultConfig(ledgerPath, env.CLOUDFLARE_ACCOUNT_ID, false);
  await applyFaultMigrations(call, ledger, configPath);
  await wranglerCall(["deploy", "--config", configPath]);
  ledger.created.push({ kind: "worker", name: ledger.names.worker });
  await saveLedger(ledgerPath, ledger);
  return { stage: "deployed_unarmed", created: ledger.created.length };
}

export async function armFaultWorker(ledgerPath, env = process.env) {
  const ledger = await readLedger(ledgerPath);
  if (!ledger.created.some((entry) => entry.kind === "worker"))
    throw new Error("fault_worker_not_deployed");
  cloudflareClient(env);
  const configPath = await writeFaultConfig(ledgerPath, env.CLOUDFLARE_ACCOUNT_ID, true);
  await wranglerCall(["deploy", "--config", configPath]);
  return { stage: "armed" };
}

export async function inspectFaultRun(ledgerPath, env = process.env) {
  const ledger = await readLedger(ledgerPath);
  const call = cloudflareClient(env);
  const d1 = ledger.created.find((entry) => entry.kind === "d1");
  if (!d1) return { stage: "unprovisioned" };
  const result = await call(`/d1/database/${d1.uuid}/query`, "POST", {
    sql: `SELECT (SELECT COUNT(*) FROM outbox WHERE state='completed') AS completed,
      (SELECT COUNT(*) FROM outbox WHERE state='failed') AS failed,
      (SELECT COUNT(*) FROM outbox_dead_letters WHERE status='failed') AS dead_letters,
      (SELECT epoch FROM control WHERE singleton=1) AS epoch`,
  });
  const row = result?.[0]?.results?.[0];
  if (
    !row ||
    !["completed", "failed", "dead_letters", "epoch"].every((key) => Number.isInteger(row[key]))
  )
    throw new Error("fault_inspection_unknown");
  return { stage: "observed", ...row };
}

/** A single private Queue message starts the already-deployed fixed run. Unknown delivery is never retried. */
export async function enqueueFaultAction(ledgerPath, action, env = process.env) {
  if (!["bootstrap", "resume", "probe"].includes(action)) throw new Error("fault_invalid_action");
  const ledger = await readLedger(ledgerPath);
  const call = cloudflareClient(env);
  if (!ledger.created.some((entry) => entry.kind === "worker"))
    throw new Error("fault_worker_not_deployed");
  const queue = ledger.created.find((entry) => entry.kind === "queue");
  const d1 = ledger.created.find((entry) => entry.kind === "d1");
  if (!queue?.queueId || !d1?.uuid || ledger[`${action}Intent`])
    throw new Error("fault_action_conflict");
  const remoteQueue = await call(`/queues/${queue.queueId}`);
  if (remoteQueue?.queue_name !== ledger.names.queue)
    throw new Error("fault_queue_identity_conflict");
  const result = await inspectFaultRun(ledgerPath, env);
  if (
    (action === "bootstrap" &&
      (result.epoch !== 1 ||
        result.completed !== 0 ||
        result.failed !== 0 ||
        result.dead_letters !== 0)) ||
    (action === "resume" &&
      (result.epoch !== 2 ||
        result.completed !== 0 ||
        result.failed !== 0 ||
        result.dead_letters !== 0)) ||
    (action === "probe" &&
      (result.epoch !== 2 ||
        result.completed !== 1 ||
        result.failed !== 1 ||
        result.dead_letters !== 1))
  )
    throw new Error("fault_action_precondition_failed");
  if (action === "resume") {
    const counts = await call(`/d1/database/${d1.uuid}/query`, "POST", {
      sql: "SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM nodes) AS nodes,(SELECT COUNT(*) FROM operations) AS operations,(SELECT COUNT(*) FROM outbox) AS outbox,(SELECT maintenance FROM control WHERE singleton=1) AS maintenance",
    });
    const row = counts?.[0]?.results?.[0];
    if (
      row?.users !== 1 ||
      row.nodes !== 1 ||
      row.operations !== 0 ||
      row.outbox !== 0 ||
      row.maintenance !== 0
    )
      throw new Error("fault_action_precondition_failed");
  }
  // Persist intent before POST: a timeout must not permit a blind second message.
  ledger[`${action}Intent`] = { state: "unknown", at: new Date().toISOString() };
  await saveLedger(ledgerPath, ledger);
  await call(`/queues/${queue.queueId}/messages`, "POST", {
    body:
      action === "bootstrap"
        ? { faultBootstrap: ledger.id }
        : action === "resume"
          ? { faultResume: ledger.id }
          : { controlProbe: ledger.id },
    content_type: "json",
  });
  ledger[`${action}Intent`].state = "accepted";
  await saveLedger(ledgerPath, ledger);
  return { stage: `${action}_accepted` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [action, ledgerPath, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      !ledgerPath ||
      !["--provision", "--arm", "--inspect", "--bootstrap", "--resume", "--probe"].includes(action)
    )
      throw new Error("fault_invalid_action");
    const result =
      action === "--provision"
        ? await provisionFaultResources(ledgerPath)
        : action === "--arm"
          ? await armFaultWorker(ledgerPath)
          : action === "--inspect"
            ? await inspectFaultRun(ledgerPath)
            : await enqueueFaultAction(ledgerPath, action.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^fault_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "fault_unknown_failure";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
