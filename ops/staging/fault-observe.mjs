import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "./fault-provision.mjs";

/** Read-only remote Durable Object RPC. Never publishes a route or changes the drill state. */
export async function observeFaultObjects(ledgerPath, accountId, factory) {
  const ledger = await readLedger(ledgerPath);
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) throw new Error("fault_credentials_unavailable");
  const directory = await mkdtemp(join(tmpdir(), "ncf-fault-observe-"));
  let proxy;
  let stage = "config";
  try {
    const configPath = join(directory, "wrangler.json");
    const config = {
      name: `${ledger.names.worker}-observer`,
      account_id: accountId,
      compatibility_date: "2026-08-15",
      workers_dev: false,
      preview_urls: false,
      durable_objects: {
        bindings: [
          {
            name: "FAULT_STATE",
            class_name: "FaultStateDO",
            script_name: ledger.names.worker,
          },
          {
            name: "CONTROL",
            class_name: "ControlDO",
            script_name: ledger.names.worker,
          },
        ],
      },
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
    stage = "proxy";
    const getProxy = factory ?? (await import("wrangler")).getPlatformProxy;
    proxy = await getProxy({ configPath, remoteBindings: true, persist: false, envFiles: [] });
    stage = "binding";
    const state = proxy.env.FAULT_STATE.get(proxy.env.FAULT_STATE.idFromName(ledger.id));
    stage = "snapshot";
    const snapshot = await state.snapshot(ledger.id);
    stage = "control";
    const control = proxy.env.CONTROL.get(proxy.env.CONTROL.idFromName("singleton"));
    let status = null;
    try {
      status = await control.status();
    } catch {
      // An uninitialized isolated ControlDO is expected before the first Cron.
    }
    return {
      stage: snapshot?.stage ?? null,
      healthyAcks: snapshot?.healthyAcks ?? 0,
      poisonRetries: snapshot?.poisonRetries ?? 0,
      deadLetters: snapshot?.deadLetters ?? 0,
      deadLetterAcks: snapshot?.deadLetterAcks ?? 0,
      control: status
        ? { epoch: status.epoch, maintenance: status.maintenance, gcPaused: status.gcPaused }
        : null,
    };
  } catch {
    throw new Error(`fault_observer_${stage}`);
  } finally {
    await proxy?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const watchdog = setTimeout(() => {
    process.stderr.write("fault_observer_timeout\n");
    process.exit(124);
  }, 45_000);
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--inspect")
      throw new Error("fault_invalid_action");
    const result = await observeFaultObjects(process.argv[3], process.env.CLOUDFLARE_ACCOUNT_ID);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^fault_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "fault_observer_unavailable";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}
