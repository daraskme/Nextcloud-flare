import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import {
  assertCreateLocks,
  assertTrashLocks,
  hasBlockingLocks,
  hasBlockingTrashLocks,
  lockTokenHashes,
} from "../auth/locks";
import { grantPermit, type Permit, releasePermit, revokeSpacePermits } from "../db/permits";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { CONTROL_NAME } from "./ControlDO";

export interface CreatePermitRequest {
  requestId: string;
  spaceId: string;
  parentId: string;
  principal: Principal;
  lockTokens: readonly string[];
}
export interface RenamePermitRequest {
  requestId: string;
  spaceId: string;
  nodeId: string;
  principal: Principal;
  lockTokens: readonly string[];
}
export interface NodeWritePermitRequest {
  requestId: string;
  spaceId: string;
  nodeId: string;
  principal: Principal;
  lockTokens: readonly string[];
  operation?: "node.props.write" | "node.content.write";
}
export interface TrashPermitRequest {
  requestId: string;
  spaceId: string;
  nodeId: string;
  principal: Principal;
  lockTokens: readonly string[];
}
export interface DavLockRequest {
  requestId: string;
  spaceId: string;
  nodeId: string;
  principal: Principal;
  displayHref: string;
  depth: "0" | "infinity";
  ownerText: string;
  timeoutSeconds: number;
}
export interface DavLockTokenRequest {
  spaceId: string;
  nodeId: string;
  principal: Principal;
  token: string;
  timeoutSeconds?: number;
}
export interface DavLockResult {
  readonly token: string;
  readonly depth: "0" | "infinity";
  readonly ownerText: string;
  readonly timeoutSeconds: number;
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

  async #davLockConflict(
    nodeId: string,
    spaceId: string,
    epoch: number,
    depth: "0" | "infinity",
  ): Promise<boolean> {
    const blocked = await primary(this.env.DB)
      .prepare(
        `WITH RECURSIVE
          ancestors(id,parent_id,depth) AS (
            SELECT id,parent_id,0 FROM nodes WHERE id=?1 AND space_id=?2 AND deleted_at IS NULL
            UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN ancestors a ON n.id=a.parent_id
              WHERE a.depth<64 AND n.space_id=?2 AND n.deleted_at IS NULL
          ), descendants(id,depth) AS (
            SELECT id,0 FROM nodes WHERE id=?1 AND space_id=?2 AND deleted_at IS NULL
            UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN descendants d ON n.parent_id=d.id
              WHERE d.depth<64 AND n.space_id=?2 AND n.deleted_at IS NULL
          ) SELECT (EXISTS(
            SELECT 1 FROM permits p WHERE p.space_id=?2 AND p.epoch=?3 AND p.state='open'
              AND p.expires_at>strftime('%s','now')*1000)
            OR EXISTS(SELECT 1 FROM locks l WHERE l.space_id=?2 AND l.epoch=?3
              AND l.expires_at>strftime('%s','now')*1000 AND (
                EXISTS(SELECT 1 FROM ancestors a WHERE a.id=l.node_id AND (a.depth=0 OR l.depth='infinity'))
                OR (?4='infinity' AND EXISTS(SELECT 1 FROM descendants d WHERE d.id=l.node_id))))) AS blocked`,
      )
      .bind(nodeId, spaceId, epoch, depth)
      .first<number>("blocked");
    if (blocked === null) throw new Error("lock_state_unavailable");
    return blocked === 1;
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
    if (
      await hasBlockingLocks(
        this.env.DB,
        request.parentId,
        request.spaceId,
        request.principal,
        hashes,
      )
    )
      throw new Error("dav_locked");
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

  async acquireRename(request: RenamePermitRequest): Promise<Permit> {
    this.#canonical(request.spaceId);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)) throw new Error("invalid_lock_request");
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (status.maintenance || status.epoch !== request.principal.epoch)
      throw new Error("admission_closed");
    await this.#initialize(request.spaceId, status.epoch);
    const authorized = await authorizeNode(this.env.DB, request.principal, {
      operation: "node.rename",
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== "node.rename") throw new Error("invalid_rename_authorization");
    const hashes = await lockTokenHashes(request.lockTokens);
    if (
      (await hasBlockingLocks(
        this.env.DB,
        request.nodeId,
        request.spaceId,
        request.principal,
        hashes,
      )) ||
      (await hasBlockingLocks(
        this.env.DB,
        authorized.parentId,
        request.spaceId,
        request.principal,
        hashes,
      ))
    )
      throw new Error("dav_locked");
    const digest = JSON.stringify([
      "node.rename",
      request.nodeId,
      authorized.parentId,
      request.principal.kind,
      request.principal.credential_id,
      request.principal.kind === "link_share"
        ? request.principal.share_id
        : request.principal.user_id,
      status.epoch,
      request.principal.kind === "link_share" ? request.principal.share_version : null,
      hashes,
    ]);
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
        assertCreateLocks(request.nodeId, request.spaceId, request.principal, hashes),
        assertCreateLocks(authorized.parentId, request.spaceId, request.principal, hashes),
      ],
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM permit_intents WHERE request_id IN (SELECT request_id FROM permit_intents WHERE created_at<? LIMIT 1000)",
      Date.now() - 120_000,
    );
    return permit;
  }

  async acquireNodeWrite(request: NodeWritePermitRequest): Promise<Permit> {
    this.#canonical(request.spaceId);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)) throw new Error("invalid_lock_request");
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (status.maintenance || status.epoch !== request.principal.epoch)
      throw new Error("admission_closed");
    await this.#initialize(request.spaceId, status.epoch);
    const operation = request.operation ?? "node.props.write";
    const authorized = await authorizeNode(this.env.DB, request.principal, {
      operation,
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== operation) throw new Error("invalid_node_write_authorization");
    const hashes = await lockTokenHashes(request.lockTokens);
    if (
      await hasBlockingLocks(
        this.env.DB,
        request.nodeId,
        request.spaceId,
        request.principal,
        hashes,
      )
    )
      throw new Error("dav_locked");
    const digest = JSON.stringify([
      operation,
      request.nodeId,
      request.principal.kind,
      request.principal.credential_id,
      request.principal.kind === "link_share"
        ? request.principal.share_id
        : request.principal.user_id,
      status.epoch,
      request.principal.kind === "link_share" ? request.principal.share_version : null,
      hashes,
    ]);
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
        assertCreateLocks(request.nodeId, request.spaceId, request.principal, hashes),
      ],
    );
    return permit;
  }

  async acquireTrash(request: TrashPermitRequest): Promise<Permit> {
    this.#canonical(request.spaceId);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)) throw new Error("invalid_lock_request");
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (status.maintenance || status.epoch !== request.principal.epoch)
      throw new Error("admission_closed");
    await this.#initialize(request.spaceId, status.epoch);
    const authorized = await authorizeNode(this.env.DB, request.principal, {
      operation: "node.trash",
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== "node.trash") throw new Error("invalid_trash_authorization");
    const hashes = await lockTokenHashes(request.lockTokens);
    if (
      await hasBlockingTrashLocks(
        this.env.DB,
        request.nodeId,
        request.spaceId,
        request.principal,
        hashes,
      )
    )
      throw new Error("dav_locked");
    const digest = JSON.stringify([
      "node.trash",
      request.nodeId,
      authorized.parentId,
      request.principal.kind,
      request.principal.credential_id,
      request.principal.kind === "link_share"
        ? request.principal.share_id
        : request.principal.user_id,
      status.epoch,
      request.principal.kind === "link_share" ? request.principal.share_version : null,
      hashes,
    ]);
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
    return grantPermit(
      this.env.DB,
      `p:${request.requestId}`,
      request.spaceId,
      status.epoch,
      undefined,
      [
        authorizationAssertion(authorized),
        assertTrashLocks(request.nodeId, request.spaceId, request.principal, hashes),
      ],
    );
  }

  async createDavLock(request: DavLockRequest): Promise<DavLockResult> {
    this.#canonical(request.spaceId);
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId) ||
      !request.displayHref.startsWith("/dav/") ||
      new TextEncoder().encode(request.displayHref).byteLength > 16_384 ||
      !["0", "infinity"].includes(request.depth) ||
      new TextEncoder().encode(request.ownerText).byteLength > 8192 ||
      !Number.isSafeInteger(request.timeoutSeconds) ||
      request.timeoutSeconds < 1 ||
      request.timeoutSeconds > 3600
    )
      throw new Error("invalid_dav_lock");
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (status.maintenance || status.epoch !== request.principal.epoch)
      throw new Error("admission_closed");
    await this.#initialize(request.spaceId, status.epoch);
    const authorized = await authorizeNode(this.env.DB, request.principal, {
      operation: "node.props.write",
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== "node.props.write") throw new Error("authorization_denied");
    if (
      await this.#davLockConflict(
        request.nodeId,
        request.spaceId,
        request.principal.epoch,
        request.depth,
      )
    )
      throw new Error("dav_locked");
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const [hash] = await lockTokenHashes([token]);
    const id = `lock_${crypto.randomUUID()}`;
    const conflict = assertExists(
      `WITH RECURSIVE
        ancestors(id,parent_id,depth) AS (
          SELECT id,parent_id,0 FROM nodes WHERE id=?1 AND space_id=?2 AND deleted_at IS NULL
          UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN ancestors a ON n.id=a.parent_id
            WHERE a.depth<64 AND n.space_id=?2 AND n.deleted_at IS NULL
        ), descendants(id,depth) AS (
          SELECT id,0 FROM nodes WHERE id=?1 AND space_id=?2 AND deleted_at IS NULL
          UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN descendants d ON n.parent_id=d.id
            WHERE d.depth<64 AND n.space_id=?2 AND n.deleted_at IS NULL
        ) SELECT 1 WHERE NOT EXISTS(
          SELECT 1 FROM locks l WHERE l.space_id=?2 AND l.epoch=?3
            AND l.expires_at>strftime('%s','now')*1000 AND (
              EXISTS(SELECT 1 FROM ancestors a WHERE a.id=l.node_id AND (a.depth=0 OR l.depth='infinity'))
              OR (?4='infinity' AND EXISTS(SELECT 1 FROM descendants d WHERE d.id=l.node_id))))`,
      [request.nodeId, request.spaceId, request.principal.epoch, request.depth],
    );
    try {
      await atomicBatch(this.env.DB, [
        {
          sql: "UPDATE permits SET state='revoked' WHERE space_id=? AND state='open' AND expires_at<=strftime('%s','now')*1000",
          values: [request.spaceId],
        },
        {
          sql: `UPDATE operations SET state='failed',error_code='permit_expired',updated_at=MAX(updated_at,strftime('%s','now')*1000)
            WHERE space_id=? AND state='claimed' AND EXISTS(
              SELECT 1 FROM permits p WHERE p.permit_id=operations.permit_id AND p.state<>'open')`,
          values: [request.spaceId],
        },
        authorizationAssertion(authorized),
        assertExists(
          `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM permits
            WHERE space_id=? AND epoch=? AND state='open' AND expires_at>strftime('%s','now')*1000)`,
          [request.spaceId, request.principal.epoch],
        ),
        conflict,
        {
          sql: `INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,strftime('%s','now')*1000+?*1000)`,
          values: [
            id,
            request.nodeId,
            request.spaceId,
            request.principal.credential_id,
            hash!,
            request.displayHref,
            request.depth,
            request.ownerText,
            request.principal.epoch,
            request.timeoutSeconds,
          ],
        },
        assertOneChange,
      ]);
    } catch (error) {
      const committed = await primary(this.env.DB)
        .prepare(
          "SELECT 1 FROM locks WHERE id=? AND node_id=? AND space_id=? AND token_hash=? AND epoch=?",
        )
        .bind(id, request.nodeId, request.spaceId, hash!, request.principal.epoch)
        .first();
      if (!committed) {
        if (
          await this.#davLockConflict(
            request.nodeId,
            request.spaceId,
            request.principal.epoch,
            request.depth,
          )
        )
          throw new Error("dav_locked");
        throw error;
      }
    }
    return Object.freeze({
      token,
      depth: request.depth,
      ownerText: request.ownerText,
      timeoutSeconds: request.timeoutSeconds,
    });
  }

  async refreshDavLock(request: DavLockTokenRequest): Promise<DavLockResult> {
    if (
      !Number.isSafeInteger(request.timeoutSeconds) ||
      (request.timeoutSeconds ?? 0) < 1 ||
      (request.timeoutSeconds ?? 0) > 3600
    )
      throw new Error("invalid_dav_lock");
    return this.#changeDavLock(request, "refresh");
  }

  async unlockDavLock(request: DavLockTokenRequest): Promise<void> {
    await this.#changeDavLock(request, "unlock");
  }

  async #changeDavLock(
    request: DavLockTokenRequest,
    action: "refresh" | "unlock",
  ): Promise<DavLockResult> {
    this.#canonical(request.spaceId);
    const status = await this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_NAME)).status();
    if (status.maintenance || status.epoch !== request.principal.epoch)
      throw new Error("admission_closed");
    await this.#initialize(request.spaceId, status.epoch);
    const authorized = await authorizeNode(this.env.DB, request.principal, {
      operation: "node.props.write",
      nodeId: request.nodeId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== "node.props.write") throw new Error("authorization_denied");
    const [hash] = await lockTokenHashes([request.token]);
    const creator = request.principal.kind === "app_password" ? request.principal.user_id : null;
    const expiresAt = action === "refresh" ? Date.now() + request.timeoutSeconds! * 1000 : null;
    const current = await primary(this.env.DB)
      .prepare(
        `SELECT l.depth,l.owner_text FROM locks l JOIN credentials c ON c.id=l.creator_credential_id
          JOIN app_passwords ap ON ap.id=c.app_password_id AND c.kind='app_password'
          WHERE l.node_id=? AND l.space_id=? AND l.token_hash=? AND l.epoch=?
            AND l.expires_at>strftime('%s','now')*1000 AND ap.user_id=?`,
      )
      .bind(request.nodeId, request.spaceId, hash!, request.principal.epoch, creator)
      .first<{ depth: "0" | "infinity"; owner_text: string }>();
    if (!current) throw new Error("dav_lock_token_mismatch");
    try {
      await atomicBatch(this.env.DB, [
        authorizationAssertion(authorized),
        action === "refresh"
          ? {
              sql: `UPDATE locks SET expires_at=? WHERE node_id=? AND space_id=? AND token_hash=? AND epoch=?
              AND expires_at>strftime('%s','now')*1000 AND creator_credential_id IN (
                SELECT c.id FROM credentials c JOIN app_passwords ap ON ap.id=c.app_password_id
                WHERE c.kind='app_password' AND ap.user_id=?)`,
              values: [
                expiresAt!,
                request.nodeId,
                request.spaceId,
                hash!,
                request.principal.epoch,
                creator,
              ],
            }
          : {
              sql: `DELETE FROM locks WHERE node_id=? AND space_id=? AND token_hash=? AND epoch=?
              AND expires_at>strftime('%s','now')*1000 AND creator_credential_id IN (
                SELECT c.id FROM credentials c JOIN app_passwords ap ON ap.id=c.app_password_id
                WHERE c.kind='app_password' AND ap.user_id=?)`,
              values: [request.nodeId, request.spaceId, hash!, request.principal.epoch, creator],
            },
        assertOneChange,
      ]);
    } catch (error) {
      const after = await primary(this.env.DB)
        .prepare("SELECT expires_at FROM locks WHERE node_id=? AND space_id=? AND token_hash=?")
        .bind(request.nodeId, request.spaceId, hash!)
        .first<number>("expires_at");
      if (
        !((action === "unlock" && after === null) || (action === "refresh" && after === expiresAt))
      )
        throw error;
    }
    return Object.freeze({
      token: request.token,
      depth: current.depth,
      ownerText: current.owner_text,
      timeoutSeconds: request.timeoutSeconds ?? 0,
    });
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
