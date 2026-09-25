import { beforeEach, expect, it, vi } from "vitest";
import { maintainBackups } from "../backup/maintenance.mjs";

const epoch = 2,
  now = Date.UTC(2026, 8, 25, 12);
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let current, finished, invalid, control, run, inspect, progress;
function plan() {
  return {
    id: id(current),
    epoch,
    scheduledAt: now,
    observedAt: now,
    ...(finished.has(id(current))
      ? { state: "completed", createdAt: now, completedAt: now, manifestSha256: "a".repeat(64) }
      : { state: "run" }),
  };
}
function health() {
  const eligible = [...finished].filter((id) => !invalid.has(id)).length;
  const missing = Math.max(0, 5 - eligible),
    alerts = [];
  if (missing) alerts.push("backup_generations_insufficient");
  if (invalid.size) alerts.push("backup_generation_invalid");
  return { epoch, complete: true, healthy: alerts.length === 0, eligible, missing, alerts };
}
beforeEach(() => {
  current = 0;
  finished = new Set();
  invalid = new Set();
  progress = vi.fn();
  control = {
    daily: vi.fn(async () => plan()),
    replenish: vi.fn(async (_, previous) => {
      if (previous === id(current) && finished.has(previous)) current++;
      return plan();
    }),
    cancel: vi.fn(),
  };
  run = vi.fn(async ({ id }) => {
    finished.add(id);
    return { id, epoch, state: "completed" };
  });
  inspect = vi.fn(async () => health());
});
const maintain = () =>
  maintainBackups({
    epoch,
    control,
    store: {},
    source: {},
    directory: "fixture",
    run,
    inspect,
    progress,
  });

it("captures the daily generation, reports shortage, adds only the missing four and verifies health again", async () => {
  const result = await maintain();
  expect(result).toMatchObject({
    healthy: true,
    completed: [id(0), id(1), id(2), id(3), id(4)],
    initial: { missing: 4 },
    health: { missing: 0, eligible: 5 },
  });
  expect(run).toHaveBeenCalledTimes(5);
  expect(control.replenish.mock.calls).toEqual([0, 1, 2, 3].map((n) => [epoch, id(n)]));
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(
    progress.mock.calls.filter(([e]) => e.stage === "maintenance_health").map(([e]) => e.phase),
  ).toEqual(["before", "after"]);
  expect(control.cancel).not.toHaveBeenCalled();
});
it("replays a healthy completed day without creating another generation", async () => {
  await maintain();
  run.mockClear();
  control.replenish.mockClear();
  inspect.mockClear();
  const result = await maintain();
  expect(result).toMatchObject({ healthy: true, completed: [] });
  expect(run).not.toHaveBeenCalled();
  expect(control.replenish).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenCalledTimes(1);
});
it("resumes the server-planned successor after its planning acknowledgement was lost", async () => {
  const advance = control.replenish;
  control.replenish = vi
    .fn()
    .mockImplementationOnce(async (...args) => {
      await advance(...args);
      throw new Error("backup_operator_timeout");
    })
    .mockImplementation(advance);
  await expect(maintain()).rejects.toThrow("backup_operator_timeout");
  expect(current).toBe(1);
  expect(finished.size).toBe(1);
  expect((await maintain()).healthy).toBe(true);
  expect([...finished]).toEqual([0, 1, 2, 3, 4].map(id));
  expect(run.mock.calls.map(([request]) => request.id)).toEqual([0, 1, 2, 3, 4].map(id));
  expect(control.cancel).not.toHaveBeenCalled();
});
it("retries an uncertain capture with the same identity and never cancels it automatically", async () => {
  const capture = run;
  run = vi
    .fn()
    .mockRejectedValueOnce(new Error("backup_store_write_unknown"))
    .mockImplementation(capture);
  await expect(maintain()).rejects.toThrow("backup_store_write_unknown");
  expect(inspect).not.toHaveBeenCalled();
  expect(control.replenish).not.toHaveBeenCalled();
  expect((await maintain()).healthy).toBe(true);
  expect(run.mock.calls.slice(0, 2).map(([request]) => request.id)).toEqual([id(0), id(0)]);
  expect(control.cancel).not.toHaveBeenCalled();
});
it("does not recreate a generation whose completed acknowledgement was lost", async () => {
  const capture = run;
  run = vi
    .fn()
    .mockImplementationOnce(async (args) => {
      await capture(args);
      throw new Error("backup_operator_timeout");
    })
    .mockImplementation(capture);
  await expect(maintain()).rejects.toThrow("backup_operator_timeout");
  expect((await maintain()).healthy).toBe(true);
  expect(run.mock.calls.map(([request]) => request.id)).toEqual([0, 1, 2, 3, 4].map(id));
});
it("can replace lost redundancy despite a corrupt completed daily export and retains its alert", async () => {
  finished.add(id(0));
  invalid.add(id(0));
  const result = await maintain();
  expect(result).toMatchObject({
    healthy: false,
    initial: { missing: 5 },
    health: { eligible: 5, missing: 0, alerts: ["backup_generation_invalid"] },
  });
  expect(result.completed).toEqual([1, 2, 3, 4, 5].map(id));
  expect(run).toHaveBeenCalledTimes(5);
  expect(control.cancel).not.toHaveBeenCalled();
});
it("does not keep adding generations when redundancy is sufficient but another stored generation is corrupt", async () => {
  for (let n = 0; n < 6; n++) finished.add(id(n));
  invalid.add(id(5));
  const result = await maintain();
  expect(result).toMatchObject({
    healthy: false,
    completed: [],
    health: { eligible: 5, missing: 0 },
  });
  expect(control.replenish).not.toHaveBeenCalled();
});
it("repairs daily freshness even when five older generations already satisfy the minimum count", async () => {
  for (let n = 0; n < 5; n++) finished.add(id(n));
  current = 4;
  inspect.mockResolvedValueOnce({ ...health(), healthy: false, alerts: ["backup_daily_missing"] });
  const result = await maintain();
  expect(result).toMatchObject({
    healthy: true,
    completed: [id(5)],
    health: { eligible: 6, missing: 0 },
  });
  expect(control.replenish).toHaveBeenCalledExactlyOnceWith(epoch, id(4));
  expect(inspect).toHaveBeenCalledTimes(2);
});
it("does not advance from an incomplete inspection", async () => {
  finished.add(id(0));
  inspect.mockResolvedValue({ ...health(), complete: false, healthy: false });
  expect((await maintain()).healthy).toBe(false);
  expect(control.replenish).not.toHaveBeenCalled();
});
it("stops and re-inspects when another runner has already completed the successor", async () => {
  finished.add(id(0));
  control.replenish.mockImplementationOnce(async () => {
    current = 1;
    finished.add(id(1));
    return plan();
  });
  const result = await maintain();
  expect(result).toMatchObject({
    healthy: false,
    completed: [],
    health: { eligible: 2, missing: 3 },
  });
  expect(run).not.toHaveBeenCalled();
  expect(control.replenish).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(2);
});
it("refuses a non-advancing plan instead of looping indefinitely", async () => {
  finished.add(id(0));
  control.replenish.mockImplementation(async () => plan());
  await expect(maintain()).rejects.toThrow("backup_replenishment_stalled");
  expect(run).not.toHaveBeenCalled();
});
it.each(["planning", "inspection", "advance"])(
  "preserves failure at %s without automatic cancellation",
  async (point) => {
    if (point === "planning") control.daily.mockRejectedValue(new Error("backup_active"));
    if (point === "inspection") inspect.mockRejectedValue(new Error("backup_inventory_changed"));
    if (point === "advance") control.replenish.mockRejectedValue(new Error("backup_conflict"));
    await expect(maintain()).rejects.toThrow();
    expect(control.cancel).not.toHaveBeenCalled();
  },
);
it("does not return healthy without a successful final inspection", async () => {
  inspect
    .mockImplementationOnce(async () => health())
    .mockRejectedValue(new Error("backup_inventory_changed"));
  await expect(maintain()).rejects.toThrow("backup_inventory_changed");
  expect(finished.size).toBe(5);
});
it.each([-1, 6, 1.5])("rejects an invalid shortage %s before advancing", async (missing) => {
  finished.add(id(0));
  inspect.mockResolvedValue({ ...health(), missing });
  await expect(maintain()).rejects.toThrow("backup_invalid_health");
  expect(control.replenish).not.toHaveBeenCalled();
});
