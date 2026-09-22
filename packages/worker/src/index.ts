import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { primary } from "./db/primary";
import { CONTROL_NAME } from "./do/ControlDO";
import { type Env, hasBindings } from "./env";
import { dispatchPendingOutbox } from "./jobs/outbox";
import { handleOutboxBatch } from "./jobs/queue";

async function admittedEpoch(env: Env): Promise<number | null> {
  if (!hasBindings(env)) return null;
  const status = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).status();
  if (status.maintenance) return null;
  const mirror = await primary(env.DB)
    .prepare("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0")
    .bind(status.epoch)
    .first<number>();
  return mirror === null ? null : status.epoch;
}

// Phase 0 exports establish binding compatibility only. No authority is issued yet.
class UnavailableDO extends DurableObject<Env> {
  fetch(): Response {
    return problem(503, "not_ready");
  }
}

export { ControlDO } from "./do/ControlDO";
export { LockDO } from "./do/LockDO";
export class UploadDO extends UnavailableDO {}
export class BudgetDO extends UnavailableDO {}

export default {
  fetch(_request: Request, env: Env): Response {
    if (!hasBindings(env)) return problem(503, "binding_unavailable");
    // Phase 1 installs the authenticated manifest. Do not expose assets or probe routes.
    return problem(404, "not_found");
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    let epoch: number | null;
    try {
      epoch = await admittedEpoch(env);
    } catch {
      // Unknown control/D1 outcomes and unavailable bindings retain every delivery.
      batch.retryAll();
      return;
    }
    if (epoch === null) {
      batch.retryAll();
      return;
    }
    await handleOutboxBatch(env.DB, batch);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const epoch = await admittedEpoch(env);
    if (epoch === null) return;
    await dispatchPendingOutbox(env.DB, env.JOBS, epoch);
  },
} satisfies ExportedHandler<Env>;
