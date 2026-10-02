const MAX_PAGES_PER_TICK = 8;

export async function advanceRecovery(env, log = () => {}) {
  if (
    env.STAGING_CONTROL_CRON_ENABLED !== "true" ||
    env.STAGING_TARGET !== "next-cloud-flare-staging" ||
    !env.STAGING_CONTROL
  )
    throw new Error("staging_control_cron_unconfigured");

  const control = env.STAGING_CONTROL;
  const initial = await control.initialState();
  if (
    !initial ||
    ![1, 2].includes(initial.epoch) ||
    initial.users !== 0 ||
    initial.spaces !== 0 ||
    initial.nodes !== 0 ||
    initial.blobs !== 0 ||
    initial.shares !== 0 ||
    (initial.epoch === 1 && (initial.maintenance !== 1 || initial.gcPaused !== 1))
  )
    throw new Error("staging_control_cron_not_empty_initial_state");
  const state = await control.recover();
  if (
    !Number.isSafeInteger(state?.epoch) ||
    state.epoch < 1 ||
    typeof state.maintenance !== "boolean" ||
    typeof state.gcPaused !== "boolean"
  )
    throw new Error("staging_control_cron_invalid_status");
  const epoch = state.epoch;
  if (epoch !== 2) throw new Error("staging_control_cron_unexpected_epoch");
  if (!state.maintenance) {
    if (state.gcPaused) {
      const next = await control.resumeGarbageCollection(epoch);
      if (next.epoch !== epoch || next.maintenance || next.gcPaused)
        throw new Error("staging_control_cron_invalid_status");
      log({ epoch, stage: "gc_resumed" });
      return { epoch, stage: "gc_resumed" };
    }
    log({ epoch, stage: "complete" });
    return { epoch, stage: "complete" };
  }

  let audit = await control.auditStatus(epoch);
  if (audit === null) audit = await control.beginAudit(epoch);
  if (!validAudit(audit, epoch)) throw new Error("staging_control_cron_invalid_audit");
  for (let page = 0; page < MAX_PAGES_PER_TICK && !audit.completed; page++) {
    audit = await control.nextAuditPage(epoch);
    if (!validAudit(audit, epoch)) throw new Error("staging_control_cron_invalid_audit");
  }
  if (!audit.completed) {
    log({ epoch, stage: audit.stage, pages: audit.pages, completed: false });
    return { epoch, stage: audit.stage, pages: audit.pages, completed: false };
  }

  const resumed = await control.resume(epoch);
  if (resumed.epoch !== epoch || resumed.maintenance)
    throw new Error("staging_control_cron_invalid_status");
  const gc = await control.resumeGarbageCollection(epoch);
  if (gc.epoch !== epoch || gc.maintenance || gc.gcPaused)
    throw new Error("staging_control_cron_invalid_status");
  log({ epoch, stage: "complete", pages: audit.pages, completed: true });
  return { epoch, stage: "complete", pages: audit.pages, completed: true };
}

function validAudit(audit, epoch) {
  return (
    audit?.epoch === epoch &&
    typeof audit.completed === "boolean" &&
    typeof audit.stage === "string" &&
    Number.isSafeInteger(audit.pages) &&
    audit.pages >= 0
  );
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  async scheduled(_event, env) {
    try {
      await advanceRecovery(env, (progress) => console.log(JSON.stringify(progress)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.error(
        /^staging_control_cron_[a-z_]+$/.test(message)
          ? message
          : "staging_control_cron_unavailable",
      );
      throw new Error("staging_control_cron_failed");
    }
  },
};
