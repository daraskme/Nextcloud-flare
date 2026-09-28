import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wranglerSource } from "../backup/wrangler.mjs";

let directory, config;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "backup-wrangler-"));
  config = join(directory, "wrangler.json");
  await writeFile(config, "{}");
});
afterEach(() => rm(directory, { recursive: true, force: true }));
it.each([
  [{ code: 1 }, "code=1 signal=none"],
  [{ code: "ENOENT" }, "code=ENOENT signal=none"],
  [
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    "code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER signal=none",
  ],
  [{ code: null, signal: "SIGKILL" }, "code=unknown signal=SIGKILL"],
  [{ code: "private-query", signal: "private-url" }, "code=unknown signal=none"],
])("reports bounded process metadata without leaking payloads (%j)", async (metadata, expected) => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ stdout: '[{"success":true,"results":[]}]' })
    .mockRejectedValueOnce(
      Object.assign(new Error("private-message"), metadata, {
        stdout: "private-data",
        stderr: "private-signed-url",
        cmd: "private-command",
      }),
    );
  const source = await wranglerSource({ config, database: "DB", mode: "local" }, execute);
  expect(await source.query("SELECT 1")).toEqual([]);
  await expect(source.query("SELECT 'private-data'")).rejects.toMatchObject({
    message: `backup_wrangler_failed: command=2 ${expected}`,
  });
  expect(execute).toHaveBeenCalledTimes(2);
});
it("stops before another command when config changes and never retries the previous command", async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: '[{"success":true,"results":[]}]' });
  const source = await wranglerSource({ config, database: "DB", mode: "local" }, execute);
  await source.query("SELECT 1");
  await writeFile(config, '{"name":"changed"}');
  await expect(source.query("SELECT 2")).rejects.toThrow("backup_config_changed");
  expect(execute).toHaveBeenCalledTimes(1);
});
