import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareClient, readLedger } from "./fault-provision.mjs";

const require = createRequire(new URL("../../packages/worker/package.json", import.meta.url));
const { AwsClient } = require("aws4fetch");

export function allowedCleanupKeys(kind, id, keys) {
  const allowed =
    kind === "blobs"
      ? new Set([`fault/${id}/complete`, `fault/${id}/abort`])
      : kind === "backups"
        ? new Set(["sys/epoch/2.json"])
        : null;
  if (
    !allowed ||
    !Array.isArray(keys) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length > allowed.size ||
    new Set(keys).size !== keys.length
  )
    throw new Error("fault_cleanup_foreign_object");
  return keys;
}

async function save(path, ledger) {
  const temp = `${path}.cleanup.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

async function bucketClient(env, bucket) {
  const verify = await cloudflareClient(env)("/tokens/verify");
  if (!/^[a-f0-9]{32}$/.test(verify?.id ?? "")) throw new Error("fault_cleanup_token_invalid");
  const signer = new AwsClient({
    accessKeyId: verify.id,
    secretAccessKey: createHash("sha256").update(env.CLOUDFLARE_API_TOKEN).digest("hex"),
    region: "auto",
    service: "s3",
    retries: 0,
  });
  const endpoint = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/`;
  const request = async (method, suffix) => {
    let response;
    try {
      response = await fetch(
        await signer.sign(endpoint + suffix, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        }),
      );
    } catch {
      throw new Error("fault_cleanup_r2_unavailable");
    }
    if (response.redirected) throw new Error("fault_cleanup_r2_redirect");
    return response;
  };
  return {
    async list() {
      const response = await request("GET", "?list-type=2&max-keys=100");
      if (response.status !== 200) throw new Error("fault_cleanup_r2_list_failed");
      const text = await response.text();
      if (text.length > 64_000 || /<IsTruncated>true<\/IsTruncated>/.test(text))
        throw new Error("fault_cleanup_r2_list_unbounded");
      return [...text.matchAll(/<Key>([^<]{1,1024})<\/Key>/g)].map((match) => match[1]);
    },
    async delete(key) {
      const response = await request("DELETE", key);
      void response.body?.cancel().catch(() => {});
      if (![204, 404].includes(response.status)) throw new Error("fault_cleanup_r2_delete_failed");
    },
  };
}

/** Deletes only resources in the private ledger; any foreign bucket key stops cleanup. */
export async function cleanupFaultResources(ledgerPath, env = process.env) {
  const ledger = await readLedger(ledgerPath);
  const call = cloudflareClient(env);
  ledger.removed ??= [];
  const remove = async (kind, action) => {
    if (!ledger.created.some((entry) => entry.kind === kind) || ledger.removed.includes(kind))
      return;
    await action();
    ledger.removed.push(kind);
    await save(ledgerPath, ledger);
  };
  // Cloudflare refuses script deletion while it is a Queue consumer (10064).
  // Detach only consumers whose script and queue both match this UUID ledger.
  ledger.detached ??= [];
  for (const kind of ["queue", "dlq"]) {
    if (ledger.detached.includes(kind)) continue;
    const entry = ledger.created.find((item) => item.kind === kind);
    if (!entry) continue; // Partial provisioning is still safe to clean up.
    if (!/^[a-f0-9]{32}$/.test(entry?.queueId ?? ""))
      throw new Error("fault_cleanup_queue_id_invalid");
    const consumers = await call(`/queues/${entry.queueId}/consumers`);
    if (Array.isArray(consumers) && consumers.length === 0) {
      // An earlier successful DELETE may have lost its response before ledger persistence.
      ledger.detached.push(kind);
      await save(ledgerPath, ledger);
      continue;
    }
    if (
      !Array.isArray(consumers) ||
      consumers.length !== 1 ||
      (consumers[0]?.script_name ?? consumers[0]?.script) !== ledger.names.worker ||
      consumers[0]?.queue_name !== ledger.names[kind] ||
      !/^[a-f0-9]{32}$/.test(consumers[0]?.consumer_id ?? "")
    )
      throw new Error("fault_cleanup_consumer_identity_conflict");
    await call(`/queues/${entry.queueId}/consumers/${consumers[0].consumer_id}`, "DELETE");
    ledger.detached.push(kind);
    await save(ledgerPath, ledger);
  }
  // This UUID-owned script implements three isolated DO namespaces; force removes
  // those namespaces too. Attached Queue consumers were checked and detached above.
  await remove("worker", () =>
    call(`/workers/scripts/${ledger.names.worker}?force=true`, "DELETE"),
  );
  for (const kind of ["queue", "dlq"]) {
    await remove(kind, async () => {
      const id = ledger.created.find((entry) => entry.kind === kind)?.queueId;
      if (!/^[a-f0-9]{32}$/.test(id ?? "")) throw new Error("fault_cleanup_queue_id_invalid");
      const queue = await call(`/queues/${id}`);
      if (queue?.queue_name !== ledger.names[kind])
        throw new Error("fault_cleanup_queue_identity_conflict");
      await call(`/queues/${id}`, "DELETE");
    });
  }
  for (const kind of ["blobs", "backups"]) {
    await remove(kind, async () => {
      const bucket = await bucketClient(env, ledger.names[kind]);
      const keys = await bucket.list();
      for (const key of allowedCleanupKeys(kind, ledger.id, keys)) await bucket.delete(key);
      if ((await bucket.list()).length !== 0) throw new Error("fault_cleanup_bucket_nonempty");
      await call(`/r2/buckets/${ledger.names[kind]}`, "DELETE");
    });
  }
  await remove("d1", async () => {
    const entry = ledger.created.find((item) => item.kind === "d1");
    if (!/^[0-9a-f-]{36}$/.test(entry?.uuid ?? "")) throw new Error("fault_cleanup_d1_id_invalid");
    const database = await call(`/d1/database/${entry.uuid}`);
    if (database?.name !== ledger.names.d1) throw new Error("fault_cleanup_d1_identity_conflict");
    await call(`/d1/database/${entry.uuid}`, "DELETE");
  });
  return { removed: ledger.removed.length, total: ledger.created.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--cleanup-owned")
      throw new Error("fault_invalid_action");
    const result = await cleanupFaultResources(process.argv[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^fault_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "fault_cleanup_unknown_failure";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
