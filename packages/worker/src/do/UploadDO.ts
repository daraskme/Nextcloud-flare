import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import type { Env } from "../env";
import { MultipartLedger } from "./uploadLedger";

/** Durable part journal foundation. Admission awaits D1 authorization/reservation and R2 services. */
export class UploadDO extends DurableObject<Env> {
  readonly #ledger: MultipartLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ledger = new MultipartLedger(ctx.storage);
  }

  fetch(): Response {
    return problem(503, "not_ready");
  }

  async alarm(): Promise<void> {
    this.#ledger.advance(Date.now());
    const at = this.#ledger.nextAlarmAt();
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
    // cleanup_pending is durable. R2 abort/delete and the Cron repair consumer follow separately.
  }
}
