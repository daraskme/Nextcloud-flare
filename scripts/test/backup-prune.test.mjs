import { expect, it, vi } from "vitest";
import { controlCalls } from "../backup/control.mjs";
import { PRUNE_MAX_STEPS, pruneBackup } from "../backup/prune.mjs";

const id = "00000000-0000-0000-0000-000000000001",
  epoch = 2;
const result = (extra = {}) => ({
  id,
  epoch,
  generationEpoch: 1,
  createdAt: 1,
  manifestSha256: "a".repeat(64),
  state: "absent",
  deletedObjects: 1,
  ...extra,
});
it("drains bounded server batches under the current epoch and the same old generation identity", async () => {
  const prune = vi
    .fn()
    .mockResolvedValueOnce(result({ state: "pending", deletedObjects: 20 }))
    .mockResolvedValue(result());
  const progress = vi.fn();
  expect(await pruneBackup({ epoch, id, control: { prune }, progress })).toMatchObject({
    complete: true,
    steps: 2,
  });
  expect(prune.mock.calls).toEqual([
    [epoch, id],
    [epoch, id],
  ]);
  expect(progress).toHaveBeenCalledTimes(2);
});
it("returns incomplete at the call budget so a later invocation can resume", async () => {
  const prune = vi.fn().mockResolvedValue(result({ state: "pending" }));
  expect(await pruneBackup({ epoch, id, control: { prune } })).toMatchObject({
    complete: false,
    steps: PRUNE_MAX_STEPS,
  });
  expect(prune).toHaveBeenCalledTimes(PRUNE_MAX_STEPS);
});
it.each([
  { id: "wrong" },
  { epoch: 1 },
  { generationEpoch: 3 },
  { createdAt: -1 },
  { manifestSha256: "bad" },
  { state: "completed" },
  { deletedObjects: 22 },
])("rejects malformed server responses %j", async (extra) => {
  const prune = vi.fn().mockResolvedValue(result(extra));
  await expect(pruneBackup({ epoch, id, control: { prune } })).rejects.toThrow(
    "backup_invalid_prune_result",
  );
  expect(prune).toHaveBeenCalledTimes(1);
});
it("does not mix identities across continuation calls", async () => {
  const prune = vi
    .fn()
    .mockResolvedValueOnce(result({ state: "pending" }))
    .mockResolvedValue(result({ manifestSha256: "b".repeat(64) }));
  await expect(pruneBackup({ epoch, id, control: { prune } })).rejects.toThrow(
    "backup_generation_conflict",
  );
});
it("does not automatically retry ambiguous deletions, cancel or begin another generation", async () => {
  const prune = vi.fn().mockRejectedValue(new Error("backup_operator_timeout")),
    cancel = vi.fn(),
    begin = vi.fn();
  await expect(pruneBackup({ epoch, id, control: { prune, cancel, begin } })).rejects.toThrow(
    "backup_operator_timeout",
  );
  expect(prune).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
});
it("routes pruning through the private capability and redacts upstream details", async () => {
  const prune = vi.fn().mockRejectedValue(new Error("secret provider SQL"));
  await expect(controlCalls({ prune }).prune(epoch, id)).rejects.toThrow(
    /^backup_operator_unavailable$/,
  );
  expect(prune).toHaveBeenCalledWith(epoch, id);
});
