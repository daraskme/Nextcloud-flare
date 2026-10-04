import { WorkerEntrypoint } from "cloudflare:workers";
import { primary } from "../db/primary";
import { CONTROL_NAME } from "../do/controlName";
import { epochNumber } from "../do/epochHistory";
import type { Env } from "../env";

interface StagingControlProps {
  purpose?: string;
  environment?: string;
}

/** A service-binding-only recovery capability. It has no public HTTP route. */
export class StagingControlOperator extends WorkerEntrypoint<Env, StagingControlProps> {
  #control() {
    if (
      this.env.ENVIRONMENT !== "staging" ||
      this.env.STAGING_CONTROL_OPERATOR_ENABLED !== "true" ||
      this.ctx.props?.purpose !== "staging-control-recovery-v1" ||
      this.ctx.props.environment !== "staging"
    )
      throw new Error("staging_control_forbidden");
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME));
  }

  recover() {
    return this.#control().recover();
  }

  /** Narrow D1 witness so the temporary Cron cannot resume a populated installation. */
  async initialState() {
    this.#control();
    return primary(this.env.DB)
      .prepare(
        `SELECT epoch,maintenance,gc_paused AS gcPaused,
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM spaces) AS spaces,
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM blobs) AS blobs,
        (SELECT COUNT(*) FROM shares) AS shares
        FROM control WHERE singleton=1`,
      )
      .first<{
        epoch: number;
        maintenance: number;
        gcPaused: number;
        users: number;
        spaces: number;
        nodes: number;
        blobs: number;
        shares: number;
      }>();
  }

  status() {
    return this.#control().status();
  }

  beginAudit(epoch: number) {
    epochNumber(epoch);
    return this.#control().beginRecoveryAudit(epoch);
  }

  auditStatus(epoch: number) {
    epochNumber(epoch);
    return this.#control().recoveryAuditStatus(epoch);
  }

  nextAuditPage(epoch: number) {
    epochNumber(epoch);
    return this.#control().nextRecoveryAuditPage(epoch, 20);
  }

  resume(epoch: number) {
    epochNumber(epoch);
    return this.#control().resumeAdmission(epoch);
  }

  resumeGarbageCollection(epoch: number) {
    epochNumber(epoch);
    return this.#control().resumeGarbageCollection(epoch);
  }

  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
