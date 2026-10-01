import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlCalls } from "../backup/control.mjs";

function inputConfig(input, mode) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["service", "environment", "accountId"].includes(key)) ||
    typeof input.service !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.service) ||
    !["development", "staging", "production"].includes(input.environment) ||
    !["local", "remote"].includes(mode) ||
    (mode === "remote" && !/^[a-f0-9]{32}$/.test(input.accountId ?? "")) ||
    (mode === "local" && input.accountId !== undefined)
  )
    throw new Error("ops_operator_unconfigured");
  return input;
}

export function opsOperatorConfig(input, mode) {
  const config = inputConfig(input, mode);
  return {
    name: "ncf-ops-health-client",
    compatibility_date: "2026-08-15",
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    ...(mode === "remote" ? { account_id: config.accountId } : {}),
    services: [
      {
        binding: "OPERATIONS_CONTROL",
        service: config.service,
        entrypoint: "OperationsOperator",
        props: { purpose: "operations-health-v1", environment: config.environment },
        remote: mode === "remote",
      },
      {
        binding: "BACKUP_CONTROL",
        service: config.service,
        entrypoint: "BackupOperator",
        props: { purpose: "logical-backup-v1", environment: config.environment },
        remote: mode === "remote",
      },
    ],
  };
}

export function operationsCalls(binding, timeoutMs = 60000) {
  if (!binding || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error("ops_operator_unconfigured");
  return {
    inspect: async (expectedEpoch) => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => binding.inspect(expectedEpoch)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("ops_operator_timeout")), timeoutMs);
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new Error(/^ops_[a-z_]+$/.test(message) ? message : "ops_operator_unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function opsControls(path, mode, factory) {
  const bytes = await readFile(path);
  if (bytes.length > 4096) throw new Error("ops_operator_unconfigured");
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("ops_operator_unconfigured");
  }
  const config = opsOperatorConfig(input, mode);
  const directory = await mkdtemp(join(tmpdir(), "ncf-ops-control-"));
  let proxy;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    const getProxy = factory ?? (await import("wrangler")).getPlatformProxy;
    proxy = await getProxy({
      configPath,
      remoteBindings: mode === "remote",
      persist: false,
      envFiles: [],
    });
    return {
      operations: operationsCalls(proxy.env.OPERATIONS_CONTROL),
      backup: controlCalls(proxy.env.BACKUP_CONTROL),
      dispose: async () => {
        try {
          await proxy.dispose();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await proxy?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
