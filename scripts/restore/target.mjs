import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertRestoreD1Mirror,
  RESTORE_D1_QUERY,
  restoreD1Challenge,
  restoreD1Target,
} from "../../packages/shared/src/restoreTarget.ts";
import { restoreOperatorConfig } from "./control.mjs";
import { restoreIdentity, restoreStatus } from "./verify.mjs";

const execute = promisify(execFile),
  wrangler = fileURLToPath(new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url));

/** Resolve DB once, then query with a minimal pinned configuration and a fixed SELECT only. */
export async function restoreD1Reader(
  { config, environment, operatorConfig, mode },
  run = execute,
) {
  if (!["local", "remote"].includes(mode) || typeof config !== "string" || !config)
    throw new Error("database_restore_invalid_target");
  const path = await realpath(resolve(config)),
    bytes = await readFile(path),
    operatorBytes = await readFile(operatorConfig);
  if (operatorBytes.length > 4096) throw new Error("database_restore_operator_unconfigured");
  const operator = JSON.parse(operatorBytes.toString("utf8"));
  restoreOperatorConfig(operator, mode);
  const { unstable_readConfig } = await import("wrangler"),
    selected = unstable_readConfig({ config: path, ...(environment ? { env: environment } : {}) }),
    databases = selected.d1_databases?.filter((entry) => entry.binding === "DB");
  if (
    selected.configPath !== path ||
    selected.name !== operator.service ||
    selected.vars?.ENVIRONMENT !== operator.environment ||
    databases?.length !== 1 ||
    (mode === "remote" && selected.account_id !== operator.accountId)
  )
    throw new Error("database_restore_target_config_conflict");
  const target = restoreD1Target({
      mode,
      databaseId: databases[0].database_id,
      ...(mode === "remote" ? { accountId: selected.account_id } : {}),
    }),
    directory = await mkdtemp(join(tmpdir(), "ncf-restore-d1-"));
  try {
    const queryConfig = join(directory, "wrangler.json");
    await writeFile(
      queryConfig,
      JSON.stringify({
        name: "ncf-restore-d1-client",
        compatibility_date: "2026-08-15",
        send_metrics: false,
        ...(mode === "remote" ? { account_id: target.accountId } : {}),
        d1_databases: [
          { binding: "DB", database_name: "restore-target", database_id: target.databaseId },
        ],
      }),
      { flag: "wx", mode: 0o600 },
    );
    async function unchanged() {
      if (
        !(await readFile(path)).equals(bytes) ||
        !(await readFile(operatorConfig)).equals(operatorBytes)
      )
        throw new Error("database_restore_target_config_changed");
    }
    await unchanged();
    return {
      target,
      async readMirror() {
        await unchanged();
        let result;
        try {
          const output = await run(
            process.execPath,
            [
              wrangler,
              "d1",
              "execute",
              "DB",
              `--${mode}`,
              "--config",
              queryConfig,
              "--command",
              RESTORE_D1_QUERY,
              "--json",
              ...(mode === "local" ? ["--persist-to", join(dirname(path), ".wrangler/state")] : []),
            ],
            {
              cwd: directory,
              encoding: "utf8",
              timeout: 30000,
              maxBuffer: 1024 * 1024,
              env: {
                ...process.env,
                CI: "true",
                WRANGLER_SEND_METRICS: "false",
                ...(mode === "remote" ? { CLOUDFLARE_ACCOUNT_ID: target.accountId } : {}),
              },
            },
          );
          result = JSON.parse(output.stdout);
        } catch {
          throw new Error("database_restore_target_read_failed");
        }
        await unchanged();
        if (
          !Array.isArray(result) ||
          result.length !== 1 ||
          result[0]?.success !== true ||
          !Array.isArray(result[0].results)
        )
          throw new Error("database_restore_target_read_failed");
        return result[0].results;
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRestoreD1({ epoch, id, control, reader }) {
  restoreIdentity(epoch, id);
  const target = restoreD1Target(reader.target),
    selected = restoreStatus(await control.inspect(epoch, id), epoch, id);
  if (selected.state !== "preparing") throw new Error("database_restore_not_preparing");
  const challenge = restoreD1Challenge(
    await control.challengeD1(epoch, id, target),
    epoch,
    id,
    target,
  );
  assertRestoreD1Mirror(await reader.readMirror(), challenge);
  const result = await control.attestD1(epoch, id, challenge);
  if (
    !result ||
    result.id !== id ||
    result.epoch !== epoch ||
    result.state !== "d1_verified" ||
    result.validator !== "d1-mirror-v1" ||
    result.challengeId !== challenge.challengeId ||
    result.revision !== challenge.revision ||
    JSON.stringify(restoreD1Target(result.target)) !== JSON.stringify(target) ||
    !Number.isSafeInteger(result.verifiedAt) ||
    result.verifiedAt < challenge.issuedAt ||
    result.verifiedAt >= challenge.expiresAt ||
    result.expiresAt !== challenge.expiresAt
  )
    throw new Error("database_restore_invalid_target_proof");
  // Do not print the admission token, arbitrary provider fields or a cached proof.
  return {
    id,
    epoch,
    target,
    state: result.state,
    validator: result.validator,
    challengeId: result.challengeId,
    revision: result.revision,
    verifiedAt: result.verifiedAt,
    expiresAt: result.expiresAt,
  };
}
