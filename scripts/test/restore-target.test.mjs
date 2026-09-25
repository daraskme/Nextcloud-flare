import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  RESTORE_D1_QUERY,
  RESTORE_D1_WINDOW_MS,
  restoreD1Target,
} from "../../packages/shared/src/restoreTarget.ts";
import { restoreD1Reader, verifyRestoreD1 } from "../restore/target.mjs";

let directory, id, target, c, control, reader;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "restore-d1-test-"));
  id = randomUUID();
  target = { mode: "local", databaseId: randomUUID() };
  const issuedAt = Date.now();
  c = {
    id,
    epoch: 2,
    target,
    state: "d1_challenge",
    challengeId: randomUUID(),
    revision: 12,
    token: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + RESTORE_D1_WINDOW_MS,
  };
  control = {
    inspect: vi.fn(async () => ({
      id,
      epoch: 2,
      source: { kind: "time_travel", bookmark: "opaque" },
      state: "preparing",
      createdAt: issuedAt,
    })),
    challengeD1: vi.fn(async () => structuredClone(c)),
    attestD1: vi.fn(async () => ({
      id,
      epoch: 2,
      target,
      state: "d1_verified",
      validator: "d1-mirror-v1",
      challengeId: c.challengeId,
      revision: c.revision,
      verifiedAt: issuedAt,
      expiresAt: c.expiresAt,
    })),
    cancel: vi.fn(),
  };
  reader = { target, readMirror: vi.fn(async () => [mirror()]) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function mirror() {
  return {
    epoch: 2,
    maintenance: 1,
    gc_paused: 1,
    admission_revision: c.revision,
    admission_token: c.token,
    backup_frozen: 0,
    backup_token: null,
  };
}
const verify = () => verifyRestoreD1({ epoch: 2, id, control, reader });

it("reads the fresh challenge independently before attesting and excludes the token from output", async () => {
  const result = await verify();
  expect(result.state).toBe("d1_verified");
  expect(result).not.toHaveProperty("token");
  expect(control.attestD1).toHaveBeenCalledWith(2, id, c);
  expect(control.challengeD1.mock.invocationCallOrder[0]).toBeLessThan(
    reader.readMirror.mock.invocationCallOrder[0],
  );
  expect(reader.readMirror.mock.invocationCallOrder[0]).toBeLessThan(
    control.attestD1.mock.invocationCallOrder[0],
  );
});

it.each([
  ["epoch", 1],
  ["maintenance", 0],
  ["gc_paused", 0],
  ["admission_revision", 11],
  ["admission_token", "old"],
  ["backup_frozen", 1],
  ["backup_token", "frozen"],
])("does not attest an independent D1 response with wrong %s", async (key, value) => {
  reader.readMirror.mockResolvedValue([{ ...mirror(), [key]: value }]);
  await expect(verify()).rejects.toThrow("database_restore_target_mismatch");
  expect(control.attestD1).not.toHaveBeenCalled();
  expect(control.cancel).not.toHaveBeenCalled();
});

it.each([[], [null], ["data"], [{}, {}], null])(
  "rejects missing or ambiguous control rows: %j",
  async (rows) => {
    reader.readMirror.mockResolvedValue(rows);
    await expect(verify()).rejects.toThrow("database_restore_target_mismatch");
    expect(control.attestD1).not.toHaveBeenCalled();
  },
);

it("does not renew admission after a cancelled request", async () => {
  const selected = await control.inspect();
  control.inspect.mockResolvedValue({ ...selected, state: "cancelled" });
  await expect(verify()).rejects.toThrow("database_restore_not_preparing");
  expect(control.challengeD1).not.toHaveBeenCalled();
  expect(reader.readMirror).not.toHaveBeenCalled();
});

it.each([
  { id: "wrong" },
  { epoch: 3 },
  { state: "verified" },
  { challengeId: "wrong" },
  { token: "wrong" },
  { revision: -1 },
  { issuedAt: -1 },
  { expiresAt: 1 },
  { target: { mode: "local", databaseId: randomUUID() } },
])("rejects an invalid challenge before reading the external DB: %j", async (override) => {
  control.challengeD1.mockResolvedValue({ ...c, ...override });
  await expect(verify()).rejects.toThrow("database_restore_invalid_challenge");
  expect(reader.readMirror).not.toHaveBeenCalled();
});

it("runs a new challenge and fresh read after a lost attestation acknowledgement", async () => {
  control.attestD1.mockRejectedValueOnce(new Error("lost_ack"));
  await expect(verify()).rejects.toThrow("lost_ack");
  c = { ...c, revision: c.revision + 1, token: randomUUID(), challengeId: randomUUID() };
  expect((await verify()).state).toBe("d1_verified");
  expect(reader.readMirror).toHaveBeenCalledTimes(2);
  expect(control.challengeD1).toHaveBeenCalledTimes(2);
  expect(control.cancel).not.toHaveBeenCalled();
});

it("rejects stale attestations and strips arbitrary provider fields on success", async () => {
  const result = await control.attestD1();
  control.attestD1.mockResolvedValueOnce({ ...result, verifiedAt: c.expiresAt });
  await expect(verify()).rejects.toThrow("database_restore_invalid_target_proof");
  control.attestD1.mockResolvedValue({ ...result, token: c.token, secret: "do-not-log" });
  expect(JSON.stringify(await verify())).not.toMatch(/do-not-log|token/);
});

it.each([
  { mode: "local", databaseId: "invalid" },
  { mode: "local", databaseId: randomUUID(), accountId: "a".repeat(32) },
  { mode: "remote", databaseId: randomUUID() },
  { mode: "remote", databaseId: randomUUID(), accountId: "invalid" },
  { mode: "local", databaseId: randomUUID(), unknown: true },
])("rejects an ambiguous target descriptor: %j", (input) => {
  expect(() => restoreD1Target(input)).toThrow("database_restore_invalid_target");
});

async function configuration(mode = "local", modify = () => {}) {
  const config = join(directory, "wrangler.json"),
    operatorConfig = join(directory, "operator.json"),
    accountId = "a".repeat(32),
    value = {
      name: "restore-test",
      compatibility_date: "2026-08-15",
      ...(mode === "remote" ? { account_id: accountId } : {}),
      vars: { ENVIRONMENT: "development" },
      d1_databases: [{ binding: "DB", database_id: target.databaseId, database_name: "actual" }],
    };
  modify(value);
  await writeFile(config, JSON.stringify(value));
  await writeFile(
    operatorConfig,
    JSON.stringify({
      service: "restore-test",
      environment: "development",
      ...(mode === "remote" ? { accountId } : {}),
    }),
  );
  return { config, operatorConfig, mode };
}

it.each(["local", "remote"])(
  "pins the %s DB in a temporary read-only query configuration",
  async (mode) => {
    const options = await configuration(mode),
      run = vi.fn(async () => ({
        stdout: JSON.stringify([{ success: true, results: [mirror()] }]),
      })),
      source = await restoreD1Reader(options, run);
    let temporary;
    try {
      expect(await source.readMirror()).toEqual([mirror()]);
      const [binary, args, settings] = run.mock.calls[0];
      expect(binary).toBe(process.execPath);
      expect(args.slice(1, 5)).toEqual(["d1", "execute", "DB", `--${mode}`]);
      expect(args[args.indexOf("--command") + 1]).toBe(RESTORE_D1_QUERY);
      temporary = args[args.indexOf("--config") + 1];
      const found = JSON.parse(await readFile(temporary, "utf8"));
      expect(found.d1_databases).toEqual([
        { binding: "DB", database_id: target.databaseId, database_name: "restore-target" },
      ]);
      expect(found).not.toHaveProperty("services");
      expect(settings).toMatchObject({ timeout: 30000, maxBuffer: 1024 * 1024 });
      if (mode === "local")
        expect(args[args.indexOf("--persist-to") + 1]).toBe(join(directory, ".wrangler/state"));
      else {
        expect(args).not.toContain("--persist-to");
        expect(found.account_id).toBe("a".repeat(32));
        expect(settings.env.CLOUDFLARE_ACCOUNT_ID).toBe(found.account_id);
      }
    } finally {
      await source.dispose();
    }
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["config", "operatorConfig"])(
  "rejects a changed %s before and after executing the query",
  async (key) => {
    const options = await configuration(),
      original = await readFile(options[key]);
    const run = vi.fn(async () => {
      await writeFile(options[key], "{}");
      return { stdout: JSON.stringify([{ success: true, results: [mirror()] }]) };
    });
    const source = await restoreD1Reader(options, run);
    try {
      await writeFile(options[key], "{}");
      await expect(source.readMirror()).rejects.toThrow("database_restore_target_config_changed");
      expect(run).not.toHaveBeenCalled();
      await writeFile(options[key], original);
      await expect(source.readMirror()).rejects.toThrow("database_restore_target_config_changed");
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await source.dispose();
    }
  },
);

it.each(["service", "environment", "account", "binding"])(
  "rejects a configuration with conflicting %s",
  async (field) => {
    const options = await configuration("remote", (value) => {
      if (field === "service") value.name = "another-worker";
      if (field === "environment") value.vars.ENVIRONMENT = "production";
      if (field === "account") value.account_id = "b".repeat(32);
      if (field === "binding") value.d1_databases[0].binding = "OTHER";
    });
    await expect(restoreD1Reader(options)).rejects.toThrow(
      "database_restore_target_config_conflict",
    );
  },
);

it("redacts child process errors and provider payloads", async () => {
  const options = await configuration(),
    run = vi.fn(async () => {
      throw new Error("https://token-secret.invalid/private-sql");
    }),
    source = await restoreD1Reader(options, run);
  try {
    await expect(source.readMirror()).rejects.toThrow(/^database_restore_target_read_failed$/);
    run.mockResolvedValue({ stdout: "not JSON secret" });
    await expect(source.readMirror()).rejects.toThrow(/^database_restore_target_read_failed$/);
    run.mockResolvedValue({ stdout: JSON.stringify([{ success: false, results: [] }]) });
    await expect(source.readMirror()).rejects.toThrow(/^database_restore_target_read_failed$/);
  } finally {
    await source.dispose();
  }
});
