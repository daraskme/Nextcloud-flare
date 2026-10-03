const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_COMPLETE_CALLS_PER_TICK = 4;

function configuration(env) {
  if (
    env.BACKUP_CRON_ENABLED !== "true" ||
    env.BACKUP_TARGET !== "next-cloud-flare-staging" ||
    env.BACKUP_EPOCH !== "2" ||
    !ID.test(env.BACKUP_ID ?? "") ||
    !["begin", "complete", "receipt"].includes(env.BACKUP_OPERATION) ||
    !env.BACKUP_CONTROL ||
    (env.BACKUP_OPERATION === "complete"
      ? !SHA256.test(env.BACKUP_MANIFEST_SHA256 ?? "")
      : env.BACKUP_MANIFEST_SHA256 !== undefined)
  )
    throw new Error("staging_backup_cron_unconfigured");
  return { control: env.BACKUP_CONTROL, id: env.BACKUP_ID, epoch: 2 };
}

/** A single fixed operator action per deployment; unknown RPC outcomes are retried with the same identity. */
export async function advanceBackup(env, log = () => {}) {
  const { control, id, epoch } = configuration(env);
  const operation = env.BACKUP_OPERATION;
  if (operation === "begin") {
    const result = await control.begin(epoch, id);
    if (
      result?.id !== id ||
      result.epoch !== epoch ||
      !["frozen", "released"].includes(result.state)
    )
      throw new Error("staging_backup_cron_invalid_status");
    const status = { operation, stage: result.state };
    log(status);
    return status;
  }
  if (operation === "receipt") {
    const result = await control.receipt(epoch, id);
    if (
      result !== null &&
      (result?.id !== id ||
        result.epoch !== epoch ||
        !["pending", "exporting", "completed", "failed"].includes(result.state))
    )
      throw new Error("staging_backup_cron_invalid_status");
    const status = { operation, stage: result?.state ?? "missing" };
    log(status);
    return status;
  }
  for (let call = 0; call < MAX_COMPLETE_CALLS_PER_TICK; call++) {
    const result = await control.complete(epoch, id, env.BACKUP_MANIFEST_SHA256);
    if (
      result?.id !== id ||
      result.epoch !== epoch ||
      result.manifestSha256 !== env.BACKUP_MANIFEST_SHA256 ||
      !["verifying", "completed"].includes(result.state) ||
      !Number.isSafeInteger(result.partsTotal) ||
      result.partsTotal < 1 ||
      !Number.isSafeInteger(result.partsVerified) ||
      result.partsVerified < 0 ||
      result.partsVerified > result.partsTotal ||
      (result.state === "completed" && result.partsVerified !== result.partsTotal)
    )
      throw new Error("staging_backup_cron_invalid_status");
    if (result.state === "completed") {
      const status = { operation, stage: "completed" };
      log(status);
      return status;
    }
  }
  const status = { operation, stage: "verifying" };
  log(status);
  return status;
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  async scheduled(_event, env) {
    try {
      await advanceBackup(env, (status) => console.log(JSON.stringify(status)));
    } catch {
      // Provider failures may contain signed URLs, IDs or other private data.
      console.error("staging_backup_cron_failed");
      throw new Error("staging_backup_cron_failed");
    }
  },
};
