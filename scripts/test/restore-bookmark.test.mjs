import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { restoreBookmarkTimestamp } from "../../packages/shared/src/restoreBookmark.ts";
import { RESTORE_D1_WINDOW_MS } from "../../packages/shared/src/restoreTarget.ts";
import { verifyRestoreBookmark } from "../restore/bookmark.mjs";
import { restoreControlCalls } from "../restore/control.mjs";
import { restoreD1Reader } from "../restore/target.mjs";
import { timeTravelSelection } from "../restore/verify.mjs";

const execute = promisify(execFile);
let directory, id, target, c, selected, control, reader, timestamp;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "restore-bookmark-test-"));
  id = randomUUID();
  target = { mode: "remote", databaseId: randomUUID(), accountId: "a".repeat(32) };
  const issuedAt = Date.now();
  timestamp = new Date(issuedAt - 60000).toISOString();
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
  selected = {
    id,
    epoch: 2,
    source: timeTravelSelection("opaque"),
    state: "preparing",
    createdAt: issuedAt,
  };
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    challengeD1: vi.fn(async () => structuredClone(c)),
    attestD1: vi.fn(async () => ({
      ...proof(),
      state: "d1_verified",
      validator: "d1-mirror-v1",
    })),
    attestBookmark: vi.fn(async () => proof()),
    cancel: vi.fn(),
  };
  reader = {
    target,
    readMirror: vi.fn(async () => [
      {
        epoch: 2,
        maintenance: 1,
        gc_paused: 1,
        admission_revision: c.revision,
        admission_token: c.token,
        backup_frozen: 0,
        backup_token: null,
      },
    ]),
    readBookmark: vi.fn(async () => ({ bookmark: "opaque", timestamp })),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const verify = () => verifyRestoreBookmark({ epoch: 2, id, control, reader, timestamp });
function proof() {
  return {
    id,
    epoch: 2,
    target,
    bookmark: "opaque",
    timestamp,
    state: "bookmark_verified",
    validator: "time-travel-bookmark-v1",
    challengeId: c.challengeId,
    revision: c.revision,
    verifiedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  };
}

it("checks the fresh D1 target before provider lookup and saves only the matching bookmark", async () => {
  control.attestBookmark.mockResolvedValue({
    ...proof(),
    secret: "must-not-print",
    token: c.token,
  });
  reader.readBookmark.mockResolvedValue({
    bookmark: "opaque",
    timestamp,
    providerSecret: "hidden",
  });
  expect(await verify()).toEqual(proof());
  expect(control.attestBookmark).toHaveBeenCalledExactlyOnceWith(2, id, c, {
    bookmark: "opaque",
    timestamp,
  });
  const ordered = [
    control.challengeD1,
    reader.readMirror,
    control.attestD1,
    reader.readBookmark,
    control.attestBookmark,
  ];
  for (let i = 1; i < ordered.length; i++)
    expect(ordered[i - 1].mock.invocationCallOrder[0]).toBeLessThan(
      ordered[i].mock.invocationCallOrder[0],
    );
  expect(control.cancel).not.toHaveBeenCalled();
});

it("uses a new challenge and new provider lookup after success and lost attestation responses", async () => {
  await verify();
  control.attestBookmark.mockRejectedValueOnce(new Error("database_restore_operator_timeout"));
  await expect(verify()).rejects.toThrow("database_restore_operator_timeout");
  c.challengeId = randomUUID();
  c.token = randomUUID();
  expect(await verify()).toEqual(proof());
  expect(control.challengeD1).toHaveBeenCalledTimes(3);
  expect(reader.readBookmark).toHaveBeenCalledTimes(3);
  expect(control.cancel).not.toHaveBeenCalled();
});

it.each(["local", "logical", "cancelled", "future"])(
  "refuses %s before challenge or provider read",
  async (kind) => {
    if (kind === "local") reader.target = { mode: "local", databaseId: target.databaseId };
    if (kind === "logical")
      selected.source = {
        kind: "logical",
        id: randomUUID(),
        epoch: 1,
        manifestSha256: "b".repeat(64),
      };
    if (kind === "cancelled") selected.state = "cancelled";
    if (kind === "future") timestamp = new Date(Date.now() + 60000).toISOString();
    await expect(verify()).rejects.toThrow(/database_restore_/);
    expect(control.challengeD1).not.toHaveBeenCalled();
    expect(reader.readBookmark).not.toHaveBeenCalled();
  },
);

it.each(["mirror", "d1 proof", "provider failure", "bookmark", "timestamp"])(
  "does not attest after wrong %s",
  async (kind) => {
    if (kind === "mirror") reader.readMirror.mockResolvedValue([]);
    if (kind === "d1 proof") control.attestD1.mockResolvedValue({});
    if (kind === "provider failure")
      reader.readBookmark.mockRejectedValue(new Error("database_restore_bookmark_read_failed"));
    if (kind === "bookmark")
      reader.readBookmark.mockResolvedValue({ bookmark: "another", timestamp });
    if (kind === "timestamp")
      reader.readBookmark.mockResolvedValue({
        bookmark: "opaque",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    await expect(verify()).rejects.toThrow(/database_restore_/);
    expect(control.attestBookmark).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it.each([
  { id: "wrong" },
  { epoch: 3 },
  { target: { mode: "local", databaseId: randomUUID() } },
  { state: "preparing" },
  { validator: "other" },
  { bookmark: "other" },
  { timestamp: "wrong" },
  { challengeId: randomUUID() },
  { revision: 0 },
  { verifiedAt: 0 },
  { expiresAt: 0 },
])("rejects a mismatched attestation response %j", async (change) => {
  control.attestBookmark.mockResolvedValue({ ...proof(), ...change });
  await expect(verify()).rejects.toThrow("database_restore_invalid_bookmark_proof");
});

it.each([
  undefined,
  "",
  "today",
  "2026-01-01",
  "2026-02-30T00:00:00.000Z",
  "2026-01-01T00:00:00Z",
  "2026-01-01T00:00:00.000+00:00",
  "1969-12-31T23:59:59.999Z",
])("rejects noncanonical or invalid timestamp %j", (value) => {
  expect(() => restoreBookmarkTimestamp(value, Date.now())).toThrow(
    "database_restore_invalid_timestamp",
  );
});

async function configuration(mode = "remote") {
  const config = join(directory, "wrangler.json"),
    operatorConfig = join(directory, "operator.json");
  await writeFile(
    config,
    JSON.stringify({
      name: "restore-test",
      compatibility_date: "2026-08-15",
      vars: { ENVIRONMENT: "development" },
      ...(mode === "remote" ? { account_id: target.accountId } : {}),
      d1_databases: [{ binding: "DB", database_name: "fixture", database_id: target.databaseId }],
    }),
  );
  await writeFile(
    operatorConfig,
    JSON.stringify({
      service: "restore-test",
      environment: "development",
      ...(mode === "remote" ? { accountId: target.accountId } : {}),
    }),
  );
  return { config, operatorConfig, mode };
}

it("runs only Time Travel info with pinned DB/account, explicit timestamp and bounded output", async () => {
  let temporary;
  const run = vi.fn(async (_node, args, settings) => {
    expect(args.slice(1, 7)).toEqual(["d1", "time-travel", "info", "DB", "--timestamp", timestamp]);
    expect(args).toContain("--json");
    expect(args).not.toContain("restore");
    temporary = args[args.indexOf("--config") + 1];
    const config = JSON.parse(await readFile(temporary, "utf8"));
    expect(config.d1_databases[0].database_id).toBe(target.databaseId);
    expect(config.account_id).toBe(target.accountId);
    expect(settings.env.CLOUDFLARE_ACCOUNT_ID).toBe(target.accountId);
    expect(settings).toMatchObject({ timeout: 30000, maxBuffer: 1024 * 1024 });
    return { stdout: JSON.stringify({ bookmark: "opaque", token: "secret" }) };
  });
  const source = await restoreD1Reader(await configuration(), run);
  try {
    expect(await source.readBookmark(timestamp)).toEqual({ bookmark: "opaque", timestamp });
  } finally {
    await source.dispose();
  }
  await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses local Time Travel before any child process dispatch", async () => {
  const run = vi.fn(),
    source = await restoreD1Reader(await configuration("local"), run);
  try {
    await expect(source.readBookmark(timestamp)).rejects.toThrow(
      "database_restore_bookmark_unavailable",
    );
    expect(run).not.toHaveBeenCalled();
  } finally {
    await source.dispose();
  }
});

it.each(["config", "operatorConfig"])(
  "checks %s both before and after provider lookup",
  async (key) => {
    const options = await configuration(),
      original = await readFile(options[key]);
    const run = vi.fn(async () => {
      await writeFile(options[key], "{}");
      return { stdout: JSON.stringify({ bookmark: "opaque" }) };
    });
    const source = await restoreD1Reader(options, run);
    try {
      await writeFile(options[key], "{}");
      await expect(source.readBookmark(timestamp)).rejects.toThrow(
        "database_restore_target_config_changed",
      );
      expect(run).not.toHaveBeenCalled();
      await writeFile(options[key], original);
      await expect(source.readBookmark(timestamp)).rejects.toThrow(
        "database_restore_target_config_changed",
      );
    } finally {
      await source.dispose();
    }
  },
);

it("redacts failed provider responses and rejects missing, invalid or ambiguous bookmarks", async () => {
  const run = vi.fn(async () => {
    throw new Error("https://secret.invalid/token");
  });
  const source = await restoreD1Reader(await configuration(), run);
  try {
    await expect(source.readBookmark(timestamp)).rejects.toThrow(
      /^database_restore_bookmark_read_failed$/,
    );
    for (const result of [
      null,
      [],
      {},
      { bookmark: "" },
      { bookmark: "a b" },
      { bookmark: "a".repeat(257) },
    ]) {
      run.mockResolvedValue({ stdout: JSON.stringify(result) });
      await expect(source.readBookmark(timestamp)).rejects.toThrow(
        /^database_restore_invalid_bookmark$/,
      );
    }
    run.mockResolvedValue({ stdout: "secret malformed JSON" });
    await expect(source.readBookmark(timestamp)).rejects.toThrow(
      /^database_restore_bookmark_read_failed$/,
    );
  } finally {
    await source.dispose();
  }
});

it("bounds and redacts the new private RPC", async () => {
  const binding = {
    attestBookmark: vi.fn(async () => {
      throw new Error("private token");
    }),
  };
  await expect(restoreControlCalls(binding).attestBookmark(2, id, c, {})).rejects.toThrow(
    /^database_restore_operator_unavailable$/,
  );
  binding.attestBookmark.mockImplementation(() => new Promise(() => {}));
  await expect(restoreControlCalls(binding, 5).attestBookmark(2, id, c, {})).rejects.toThrow(
    "database_restore_operator_timeout",
  );
});

it.each([
  ["prepare", "--local", "--bookmark", "opaque"],
  ["prepare", "--remote", "--bookmark", "opaque", "--source-id", "other"],
  ["prepare", "--remote", "--bookmark", ""],
  ["verify-bookmark", "--local", "--config", "missing", "--timestamp", "2026-01-01T00:00:00.000Z"],
  ["verify-bookmark", "--remote", "--config", "missing"],
  ["verify-bookmark", "--remote", "--config", "missing", "--timestamp", "today"],
])("rejects invalid CLI input before opening operator configuration: %j", async (...args) => {
  await expect(
    execute(
      process.execPath,
      [
        "scripts/database-restore.mjs",
        ...args,
        "--operator-config",
        "must-not-open.json",
        "--epoch",
        "2",
        "--id",
        id,
      ],
      { timeout: 10000 },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(
      /^(database_restore_invalid_arguments|database_restore_invalid_bookmark|database_restore_invalid_timestamp):/,
    ),
  });
});
