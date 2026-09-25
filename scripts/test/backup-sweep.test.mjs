import { expect, it, vi } from "vitest";
import { SWEEP_MAX_STEPS, sweepBackups } from "../backup/sweep.mjs";

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const initial = () => ({
  epoch: 2,
  round: id(0),
  state: "running",
  startedAt: 1,
  after: null,
  through: id(200),
  scanned: 0,
  absent: 0,
  errors: 0,
  lastError: null,
});
it("resumes a server-owned round and applies one global step budget", async () => {
  let position = 0;
  const sweep = vi.fn(async (_, round) => {
    if (round) position++;
    return {
      ...initial(),
      after: position ? id(position) : null,
      scanned: position,
      absent: position,
      state: position === 200 ? "completed" : "running",
    };
  });
  const args = { epoch: 2, control: { sweep } };
  expect(await sweepBackups(args)).toMatchObject({
    healthy: false,
    complete: false,
    steps: SWEEP_MAX_STEPS,
    after: id(100),
  });
  expect(await sweepBackups(args)).toMatchObject({
    healthy: true,
    complete: true,
    after: id(200),
    absent: 200,
  });
  expect(sweep.mock.calls[0]).toEqual([2]);
  expect(sweep.mock.calls[1]).toEqual([2, id(0)]);
});
it("reports persisted corruption after resuming even if every subsequent step succeeds", async () => {
  const previous = {
    ...initial(),
    scanned: 1,
    after: id(1),
    errors: 1,
    lastError: { id: id(1), code: "backup_publication_hash_mismatch" },
  };
  const sweep = vi
    .fn()
    .mockResolvedValueOnce(previous)
    .mockResolvedValue({
      ...previous,
      state: "completed",
      after: id(200),
      scanned: 200,
      absent: 199,
    });
  expect(await sweepBackups({ epoch: 2, control: { sweep } })).toMatchObject({
    complete: true,
    healthy: false,
    errors: 1,
  });
});
it.each([
  { epoch: 1 },
  { scanned: -1 },
  { absent: 1 },
  { after: id(201) },
  { through: "bad" },
  { errors: 1 },
  { state: "absent" },
])("rejects malformed sweep status %j", async (extra) => {
  const sweep = vi.fn().mockResolvedValue({ ...initial(), ...extra });
  await expect(sweepBackups({ epoch: 2, control: { sweep } })).rejects.toThrow();
  expect(sweep).toHaveBeenCalledTimes(1);
});
it.each([{ round: id(8) }, { startedAt: 2 }, { through: id(201) }, { after: null, scanned: 0 }])(
  "rejects a changed or regressing round %j",
  async (extra) => {
    const previous = { ...initial(), after: id(1), scanned: 1 };
    const sweep = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockResolvedValue({ ...previous, ...extra });
    await expect(sweepBackups({ epoch: 2, control: { sweep } })).rejects.toThrow(
      "backup_sweep_changed",
    );
  },
);
it("leaves uncertain steps to an explicit retry and never automatically starts a new round", async () => {
  const sweep = vi
    .fn()
    .mockResolvedValueOnce(initial())
    .mockRejectedValue(new Error("backup_operator_timeout"));
  await expect(sweepBackups({ epoch: 2, control: { sweep } })).rejects.toThrow(
    "backup_operator_timeout",
  );
  expect(sweep).toHaveBeenCalledTimes(2);
});
