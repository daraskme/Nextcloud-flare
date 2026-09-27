import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { restoreControlCalls } from "../restore/control.mjs";
import { reserveRestoreEpoch } from "../restore/epoch.mjs";
import { restoreStatus } from "../restore/verify.mjs";

let id, selected, proof, reader, control;
beforeEach(() => {
  id = randomUUID();
  selected = {
    id,
    epoch: 2,
    state: "frozen",
    createdAt: 1,
    source: { kind: "time_travel", bookmark: "opaque" },
  };
  const accountId = "a".repeat(32);
  reader = {
    target: { mode: "remote", accountId, databaseId: randomUUID() },
    blobsTarget: { accountId, bucket: "blobs-test", jurisdiction: "default" },
    backupsTarget: { accountId, bucket: "backups-test", jurisdiction: "default" },
    assertUnchanged: vi.fn(async () => {}),
  };
  proof = {
    ...selected,
    state: "epoch_reserved",
    newEpoch: 8,
    reservedAt: 2,
    validator: "restore-epoch-v1",
    targets: { target: reader.target, blobs: reader.blobsTarget, backups: reader.backupsTarget },
    token: "do-not-print",
    history_token: "do-not-print",
  };
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    reserveEpoch: vi.fn(async () => structuredClone(proof)),
    cancel: vi.fn(),
    prepare: vi.fn(),
    freeze: vi.fn(),
  };
});
const run = () => reserveRestoreEpoch({ epoch: 2, id, control, reader });

it.each(["frozen", "epoch_reserving", "epoch_reserved"])(
  "reserves or reconciles %s without repinning the request",
  async (state) => {
    selected.state = state;
    if (state === "epoch_reserved") selected.newEpoch = proof.newEpoch;
    const result = await run();
    expect(result).toMatchObject({ state: "epoch_reserved", epoch: 2, newEpoch: 8, reservedAt: 2 });
    expect(control.reserveEpoch).toHaveBeenCalledExactlyOnceWith(2, id, proof.targets);
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(control.freeze).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);

it.each(["preparing", "cancelled", "freezing", "cancelling"])(
  "rejects %s before dispatch",
  async (state) => {
    selected.state = state;
    await expect(run()).rejects.toThrow(/epoch_not_frozen/);
    expect(control.reserveEpoch).not.toHaveBeenCalled();
  },
);

it.each([
  ["newEpoch", 2],
  ["newEpoch", 2.1],
  ["newEpoch", undefined],
  ["reservedAt", 0],
  ["reservedAt", 2.1],
  ["state", "frozen"],
  ["validator", "other"],
  ["epoch", 3],
  ["id", "bad"],
  ["createdAt", 2],
  ["source", { kind: "time_travel", bookmark: "other" }],
])("rejects changed or malformed %s", async (field, value) => {
  proof[field] = value;
  await expect(run()).rejects.toThrow();
  expect(control.cancel).not.toHaveBeenCalled();
});

it("rejects a changed reserved epoch and a changed target", async () => {
  selected.newEpoch = 7;
  await expect(run()).rejects.toThrow(/invalid_epoch_proof/);
  selected.newEpoch = 8;
  proof.targets.backups = { ...reader.backupsTarget, bucket: "other" };
  await expect(run()).rejects.toThrow(/invalid_epoch_proof/);
});

it("requires a future epoch beyond the selected logical source", async () => {
  selected.source = { kind: "logical", id: randomUUID(), epoch: 8, manifestSha256: "a".repeat(64) };
  proof.source = selected.source;
  await expect(run()).rejects.toThrow(/invalid_epoch_proof/);
});

it.each([1, 2, 3])("detects configuration changes at boundary %s", async (boundary) => {
  let checks = 0;
  reader.assertUnchanged.mockImplementation(async () => {
    if (++checks === boundary) throw new Error("database_restore_config_changed");
  });
  await expect(run()).rejects.toThrow(/config_changed/);
  expect(control.reserveEpoch).toHaveBeenCalledTimes(boundary === 3 ? 1 : 0);
  expect(control.cancel).not.toHaveBeenCalled();
});

it("preserves native unknown status without retrying or cancelling", async () => {
  const binding = {
    reserveEpoch: vi.fn(async () => {
      throw new Error("epoch_history_write_unsettled");
    }),
  };
  control.reserveEpoch = restoreControlCalls(binding).reserveEpoch;
  await expect(run()).rejects.toThrow("epoch_history_write_unsettled");
  expect(binding.reserveEpoch).toHaveBeenCalledTimes(1);
  expect(control.cancel).not.toHaveBeenCalled();
});

it("inspect retains the public future epoch and removes internal fields", () => {
  const result = restoreStatus(proof, 2, id);
  expect(result).toMatchObject({ state: "epoch_reserved", newEpoch: 8 });
  expect(result).not.toHaveProperty("token");
});

it("documents reserve-epoch and rejects local invocation before connecting", async () => {
  const execute = promisify(execFile);
  expect(
    (await execute(process.execPath, ["scripts/database-restore.mjs", "--help"])).stdout,
  ).toContain("reserve-epoch");
  await expect(
    execute(process.execPath, [
      "scripts/database-restore.mjs",
      "reserve-epoch",
      "--local",
      "--operator-config",
      "missing.json",
      "--config",
      "missing.json",
      "--epoch",
      "2",
      "--id",
      id,
    ]),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("database_restore_invalid_arguments"),
  });
});
