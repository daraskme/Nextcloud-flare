import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertCreateLocks, lockTokenHashes } from "../auth/locks";
import { grantPermit, type Permit, releasePermit, revokeSpacePermits } from "../db/permits";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { CONTROL_NAME } from "./ControlDO";

export interface CreatePermitRequest {
  requestId: string;
  spaceId: string;
  parentId: string;
  principal: Principal;
  lockTokens: readonly string[];
}
interface LockState extends Record<string, SqlStorageValue> {
  space_id: string;
  epoch: number;
}

/** Per-space namespace admission. DAV lock creation/refresh and other mutation tuples follow separately. */
export class LockDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS lock_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),space_id TEXT NOT NULL,epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS permit_intents(request_id TEXT PRIMARY KEY NOT NULL,digest TEXT NOT NULL,epoch INTEGER NOT NULL,created_at INTEGER NOT NULL);`);
  }

  fetch(): Response {
    return problem(503, "not_ready");
  }

  #canonical(spaceId: string) {
    if (
      !spaceId ||
      spaceId.length > 128 ||
      this.ctx.id.toString() !== this.env.LOCKS.idFromName(spaceId).toString()
    )
      throw new Error("lock_namespace_mismatch");
  }

  async #initialize(spaceId: string, epoch: number) {
    const state = this.ctx.storage.sql
      .exec<LockState>("SELECT space_id,epoch FROM lock_state WHERE singleton=1")
      .toArray()[0];
    if (state?.space_id === spaceId && state.epoch === epoch) return;
    if (state && (state.space_id !== spaceId || state.epoch > epoch))
      throw new Error("lock_epoch_conflict");
    const prior = await primary(this.env.DB)
      .prepare(`SELECT MAX(epoch) AS epoch FROM (
      SELECT epoch FROM permits WHERE space_id=? UNION ALL SELECT epoch FROM locks WHERE space_id=?)`)
      .bind(spaceId, spaceId)
      .first<number | null>("epoch");
    const concurrent = this.ctx.storage.sql
      .exec<LockState>("SELECT space_id,epoch FROM lock_state WHERE singleton=1")
      .toArray()[0];
    if (concurrent?.space_id === spaceId && concurrent.epoch === epoch) return;
    if (concurrent && (concurrent.space_id !== spaceId || concurrent.epoch > epoch))
      throw new Error("lock_epoch_conflict");
    if (prior !== null && prior >= epoch) throw new Error("lock_recovery_required");
    this.ctx.storage.sql.exec(
      "INSERT INTO lock_state VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch WHERE lock_state.space_id=excluded.space_id AND lock_state.epoch<excluded.epoch",
      spaceId,
      epoch,
    );
  }

  async acquireCreate(request: CreatePermitRequest): Promise<Permit> {
    this.#canonical(request.spaceId);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)) throw new Error("invalid_lock_request");
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (status.maintenance || status.epoch !== request.principal.epoch)
      throw new Error("admission_closed");
    await this.#initialize(request.spaceId, status.epoch);
    const authorized = await authorizeNode(this.env.DB, request.principal, {
      operation: "node.create",
      parentId: request.parentId,
      spaceId: request.spaceId,
    });
    const hashes = await lockTokenHashes(request.lockTokens);
    const digest = JSON.stringify([
      request.parentId,
      request.principal.kind,
      request.principal.credential_id,
      request.principal.kind === "link_share"
        ? request.principal.share_id
        : request.principal.user_id,
      status.epoch,
      request.principal.kind === "link_share" ? request.principal.share_version : null,
      hashes,
    ]);
    // Durable intent precedes external I/O; no raw lock token is persisted.
    this.ctx.storage.sql.exec(
      "INSERT INTO permit_intents VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING",
      request.requestId,
      digest,
      status.epoch,
      Date.now(),
    );
    const intent = this.ctx.storage.sql
      .exec<{ digest: string; epoch: number }>(
        "SELECT digest,epoch FROM permit_intents WHERE request_id=?",
        request.requestId,
      )
      .one();
    if (intent.digest !== digest || intent.epoch !== status.epoch)
      throw new Error("lock_intent_conflict");
    const permit = await grantPermit(
      this.env.DB,
      `p:${request.requestId}`,
      request.spaceId,
      status.epoch,
      undefined,
      [
        authorizationAssertion(authorized),
        assertCreateLocks(request.parentId, request.spaceId, request.principal, hashes),
      ],
    );
    // Cache cleanup never removes D1 terminal permits; deterministic IDs prevent a replay grant.
    this.ctx.storage.sql.exec(
      "DELETE FROM permit_intents WHERE request_id IN (SELECT request_id FROM permit_intents WHERE created_at<? LIMIT 1000)",
      Date.now() - 120_000,
    );
    return permit;
  }

  async release(requestId: string, permit: Permit): Promise<void> {
    this.#canonical(permit.space_id);
    if (permit.permit_id !== `p:${requestId}`) throw new Error("lock_intent_conflict");
    await releasePermit(this.env.DB, permit);
    this.ctx.storage.sql.exec("DELETE FROM permit_intents WHERE request_id=?", requestId);
  }

  async recover(spaceId: string, epoch: number): Promise<void> {
    this.#canonical(spaceId);
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (!status.maintenance || status.epoch !== epoch)
      throw new Error("recovery_requires_maintenance");
    const prior = await primary(this.env.DB)
      .prepare(
        "SELECT MAX(epoch) AS epoch FROM (SELECT epoch FROM permits WHERE space_id=? UNION ALL SELECT epoch FROM locks WHERE space_id=?)",
      )
      .bind(spaceId, spaceId)
      .first<number | null>("epoch");
    const local = this.ctx.storage.sql
      .exec<LockState>("SELECT space_id,epoch FROM lock_state WHERE singleton=1")
      .toArray()[0];
    if ((prior !== null && prior >= epoch) || (local && local.epoch >= epoch))
      throw new Error("recovery_requires_new_epoch");
    await revokeSpacePermits(this.env.DB, spaceId, epoch);
    this.ctx.storage.sql.exec(
      "INSERT INTO lock_state VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch WHERE lock_state.space_id=excluded.space_id AND lock_state.epoch<excluded.epoch",
      spaceId,
      epoch,
    );
    this.ctx.storage.sql.exec("DELETE FROM permit_intents WHERE epoch<?", epoch);
  }
}
