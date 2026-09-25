import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function restoreOperatorConfig(input, mode) {
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
    throw new Error("database_restore_operator_unconfigured");
  return {
    name: "ncf-database-restore-client",
    compatibility_date: "2026-08-15",
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    ...(mode === "remote" ? { account_id: input.accountId } : {}),
    services: [
      {
        binding: "RESTORE_CONTROL",
        service: input.service,
        entrypoint: "DatabaseRestoreOperator",
        props: { purpose: "database-restore-v1", environment: input.environment },
        remote: mode === "remote",
      },
    ],
  };
}

export const restoreErrorCode = (error) => {
  const message = error instanceof Error ? error.message : "";
  return /^(?:(?:database_restore|restore_source|backup|invalid_backup)_[a-z_]+|invalid_database_restore)$/.test(
    message,
  )
    ? message
    : "database_restore_operator_unavailable";
};

/** A timeout is an unknown outcome. Never retry, cancel, or reopen admission automatically. */
export function restoreControlCalls(binding, timeoutMs = 60000) {
  if (!binding || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error("database_restore_operator_unconfigured");
  return Object.fromEntries(
    ["prepare", "inspect", "verify", "attest", "cancel"].map((method) => [
      method,
      async (...args) => {
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(() => binding[method](...args)),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("database_restore_operator_timeout")),
                timeoutMs,
              );
            }),
          ]);
        } catch (error) {
          throw new Error(restoreErrorCode(error));
        } finally {
          clearTimeout(timer);
        }
      },
    ]),
  );
}

export async function restoreOperatorControl(path, mode, factory) {
  const bytes = await readFile(path);
  if (bytes.length > 4096) throw new Error("database_restore_operator_unconfigured");
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("database_restore_operator_unconfigured");
  }
  const config = restoreOperatorConfig(input, mode),
    directory = await mkdtemp(join(tmpdir(), "ncf-restore-control-"));
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
    const calls = restoreControlCalls(proxy.env.RESTORE_CONTROL);
    return {
      ...calls,
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
