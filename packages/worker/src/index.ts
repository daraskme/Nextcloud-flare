import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { type Env, hasBindings } from "./env";

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
  queue(batch: MessageBatch): void {
    // A delivery is not a completed job. Preserve messages until claims/outbox exist.
    batch.retryAll();
  },
  scheduled(): void {
    // No maintenance actions before the Phase 1 fences exist.
  },
} satisfies ExportedHandler<Env>;
