import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exportData } from "./export.mjs";

const execute = promisify(execFile);
const wrangler = new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url);
export async function wranglerSource(
  { config, database, mode, environment },
  executeCommand = execute,
) {
  if (!["local", "remote"].includes(mode) || !database || database.startsWith("-"))
    throw new Error("invalid_backup_source");
  const configPath = resolve(config),
    configBytes = await readFile(configPath);
  const common = ["--config", configPath, ...(environment ? ["--env", environment] : [])];
  let command = 0;
  async function run(args) {
    const ordinal = ++command;
    if (!(await readFile(configPath)).equals(configBytes)) throw new Error("backup_config_changed");
    try {
      const result = await executeCommand(
        process.execPath,
        [fileURLToPath(wrangler), ...args, ...common],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
        },
      );
      return result.stdout;
    } catch (error) {
      // Keep only bounded process metadata, never stderr, SQL, config paths or signed URLs.
      const code =
        Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255
          ? error.code
          : ["ENOENT", "EACCES", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(
                error?.code,
              )
            ? error.code
            : "unknown";
      const signal = ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(error?.signal)
        ? error.signal
        : "none";
      throw new Error(`backup_wrangler_failed: command=${ordinal} code=${code} signal=${signal}`);
    } // SQL data and signed download URLs must not reach logs.
  }
  const query = async (sql) => {
    const result = JSON.parse(
      await run(["d1", "execute", database, `--${mode}`, "--command", sql, "--json"]),
    );
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      !result[0].success ||
      !Array.isArray(result[0].results)
    )
      throw new Error("backup_invalid_query_response");
    return result[0].results;
  };
  return {
    query,
    export: (output, tableSpecs) => exportData(output, tableSpecs, query),
  };
}
