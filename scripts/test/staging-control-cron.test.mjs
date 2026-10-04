import { expect, it, vi } from "vitest";
import { advanceRecovery } from "../../ops/staging/control-cron.mjs";
import { validateCronConfig } from "../../ops/staging/control-cron-config.mjs";

const empty = () => ({
  epoch: 1,
  maintenance: 1,
  gcPaused: 1,
  users: 0,
  spaces: 0,
  nodes: 0,
  blobs: 0,
  shares: 0,
});
const base = (control) => ({
  STAGING_CONTROL_CRON_ENABLED: "true",
  STAGING_TARGET: "next-cloud-flare-staging",
  STAGING_CONTROL: { initialState: empty, ...control },
});
const status = (maintenance, gcPaused) => ({ epoch: 2, maintenance, gcPaused });
const audit = (pages, completed = false) => ({
  epoch: 2,
  stage: completed ? "complete" : "users",
  pages,
  completed,
});

it("fails closed without the staging-only config", async () => {
  await expect(advanceRecovery(base({}))).rejects.toThrow();
  await expect(
    advanceRecovery({ ...base({}), STAGING_CONTROL_CRON_ENABLED: "false" }),
  ).rejects.toThrow("staging_control_cron_unconfigured");
  expect(() =>
    validateCronConfig({
      name: "ncf-staging-control-recovery",
      main: "./control-cron.mjs",
      workers_dev: true,
    }),
  ).toThrow("staging_control_cron_config_invalid");
});

it("refuses populated D1 before calling recover", async () => {
  const recover = vi.fn();
  await expect(
    advanceRecovery(base({ initialState: () => ({ ...empty(), users: 1 }), recover })),
  ).rejects.toThrow("staging_control_cron_not_empty_initial_state");
  expect(recover).not.toHaveBeenCalled();
});

it("keeps a completed recovery read-only on later ticks", async () => {
  const recover = vi.fn().mockResolvedValue(status(false, false));
  const log = vi.fn();
  expect(await advanceRecovery(base({ recover }), log)).toEqual({ epoch: 2, stage: "complete" });
  expect(log).toHaveBeenCalledWith({ epoch: 2, stage: "complete" });
  expect(recover).toHaveBeenCalledOnce();
});

it("only resumes GC when admission is already open", async () => {
  const resumeGarbageCollection = vi.fn().mockResolvedValue(status(false, false));
  expect(
    await advanceRecovery(base({ recover: () => status(false, true), resumeGarbageCollection })),
  ).toEqual({ epoch: 2, stage: "gc_resumed" });
  expect(resumeGarbageCollection).toHaveBeenCalledExactlyOnceWith(2);
});

it("starts an absent audit, persists bounded page progress, then completes on a later tick", async () => {
  let pages = 0;
  const beginAudit = vi.fn().mockResolvedValue(audit(0));
  const resume = vi.fn().mockResolvedValue(status(false, true));
  const gc = vi.fn().mockResolvedValue(status(false, false));
  const control = {
    recover: () => status(true, true),
    auditStatus: () => (pages === 0 ? null : audit(pages)),
    beginAudit,
    nextAuditPage: () => audit(++pages, pages === 11),
    resume,
    resumeGarbageCollection: gc,
  };
  expect(await advanceRecovery(base(control))).toMatchObject({ pages: 8, completed: false });
  expect(resume).not.toHaveBeenCalled();
  expect(await advanceRecovery(base(control))).toMatchObject({ pages: 11, completed: true });
  expect(beginAudit).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledExactlyOnceWith(2);
  expect(gc).toHaveBeenCalledExactlyOnceWith(2);
});

it("does not reopen admission after a malformed audit result", async () => {
  const resume = vi.fn();
  await expect(
    advanceRecovery(
      base({
        recover: () => status(true, true),
        auditStatus: () => ({ ...audit(10, true), epoch: 3 }),
        resume,
      }),
    ),
  ).rejects.toThrow("staging_control_cron_invalid_audit");
  expect(resume).not.toHaveBeenCalled();
});
