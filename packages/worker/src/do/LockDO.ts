import type { Env } from "../env.js";

interface DavLockRequest {
  nodeId: string;
  creatorUserId: string;
  creatorCredentialId: string;
  appPasswordId: string;
  sessionId: string;
  tokenDigest: string;
  displayUri: string;
  depth: "0" | "infinity";
  timeoutSeconds: number;
  epoch: number;
}

interface PermitRequest {
  permitId: string;
  spaceId: string;
  epoch: number;
  ttlMs: number;
  nodeIds?: string[];
  creatorUserId?: string;
  lockTokenDigests?: string[];
}

function isPermitRequest(value: unknown): value is PermitRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Partial<PermitRequest>;
  return (
    typeof request.permitId === "string" &&
    request.permitId.length > 0 &&
    typeof request.spaceId === "string" &&
    request.spaceId.length > 0 &&
    Number.isSafeInteger(request.epoch) &&
    request.epoch !== undefined &&
    request.epoch > 0 &&
    Number.isSafeInteger(request.ttlMs) &&
    request.ttlMs !== undefined &&
    request.ttlMs >= 1000 &&
    request.ttlMs <= 30_000 &&
    (request.nodeIds === undefined ||
      (Array.isArray(request.nodeIds) &&
        request.nodeIds.length <= 64 &&
        request.nodeIds.every((nodeId) => typeof nodeId === "string" && nodeId.length > 0))) &&
    (request.creatorUserId === undefined || typeof request.creatorUserId === "string") &&
    (request.lockTokenDigests === undefined ||
      (Array.isArray(request.lockTokenDigests) &&
        request.lockTokenDigests.length <= 64 &&
        request.lockTokenDigests.every(
          (digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest),
        )))
  );
}

function isDavLockRequest(value: unknown): value is DavLockRequest {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Partial<DavLockRequest>;
  return (
    typeof input.nodeId === "string" &&
    typeof input.creatorUserId === "string" &&
    typeof input.creatorCredentialId === "string" &&
    typeof input.appPasswordId === "string" &&
    typeof input.sessionId === "string" &&
    typeof input.tokenDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(input.tokenDigest) &&
    typeof input.displayUri === "string" &&
    input.displayUri.length <= 2048 &&
    (input.depth === "0" || input.depth === "infinity") &&
    Number.isSafeInteger(input.timeoutSeconds) &&
    input.timeoutSeconds !== undefined &&
    input.timeoutSeconds >= 1 &&
    input.timeoutSeconds <= 3600 &&
    Number.isSafeInteger(input.epoch) &&
    input.epoch !== undefined &&
    input.epoch > 0
  );
}

export class LockDO {
  private readonly env: Env;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  private async issuePermit(input: PermitRequest): Promise<Response> {
    const control = await this.env.CONTROL.get(this.env.CONTROL.idFromName("singleton")).fetch(
      "https://control.internal/state",
    );
    if (!control.ok) {
      return Response.json({ error: "control_unavailable" }, { status: 503 });
    }
    const controlState: { maintenance: boolean } = await control.json();
    if (controlState.maintenance) {
      return Response.json({ error: "maintenance" }, { status: 503 });
    }
    const expiresAt = Date.now() + input.ttlMs;
    const locks = await this.env.DB.prepare(
      "WITH RECURSIVE requested(id) AS (SELECT value FROM json_each(?1)),ancestors(target_id,id,parent_id,depth) AS (SELECT r.id,n.id,n.parent_id,0 FROM requested r JOIN nodes n ON n.id=r.id UNION ALL SELECT a.target_id,p.id,p.parent_id,a.depth+1 FROM ancestors a JOIN nodes p ON p.id=a.parent_id WHERE a.depth<64) SELECT DISTINCT l.token_digest tokenDigest,l.creator_user_id creatorUserId FROM locks l JOIN ancestors a ON a.id=l.node_id WHERE l.expires_at>(strftime('%s','now')*1000) AND (a.depth=0 OR l.depth='infinity')",
    )
      .bind(JSON.stringify(input.nodeIds ?? []))
      .all<{ tokenDigest: string; creatorUserId: string }>();
    const submitted = new Set(input.lockTokenDigests ?? []);
    if (
      locks.results.some(
        (lock) => lock.creatorUserId !== input.creatorUserId || !submitted.has(lock.tokenDigest),
      )
    ) {
      return Response.json({ error: "locked" }, { status: 423 });
    }
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=?1)",
      ).bind(input.epoch),
      this.env.DB.prepare(
        "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?1,?2,?3,?4,'open')",
      ).bind(input.permitId, input.spaceId, input.epoch, expiresAt),
      this.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return Response.json({
      permit_id: input.permitId,
      space_id: input.spaceId,
      epoch: input.epoch,
      expires_at: expiresAt,
    });
  }

  private credentialGuard(input: DavLockRequest): D1PreparedStatement {
    return this.env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM app_passwords ap JOIN sessions s ON s.id=ap.session_id AND s.user_id=ap.user_id JOIN users u ON u.id=ap.user_id JOIN control c ON c.singleton=1 WHERE ap.id=?1 AND ap.user_id=?2 AND ap.session_id=?3 AND ap.revoked_at IS NULL AND ap.expires_at>(strftime('%s','now')*1000) AND s.kind='app_password' AND s.revoked_at IS NULL AND s.expires_at>(strftime('%s','now')*1000) AND u.disabled_at IS NULL AND c.epoch=?4)",
    ).bind(input.appPasswordId, input.creatorUserId, input.sessionId, input.epoch);
  }

  private async createDavLock(input: DavLockRequest): Promise<Response> {
    const conflict = await this.env.DB.prepare(
      "WITH RECURSIVE ancestors(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM nodes WHERE id=?1 UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN ancestors a ON n.id=a.parent_id WHERE a.depth<64),descendants(id,depth) AS (SELECT id,0 FROM nodes WHERE id=?1 UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN descendants d ON n.parent_id=d.id WHERE n.deleted_at IS NULL AND d.depth<64 LIMIT 1001) SELECT 1 value FROM locks l WHERE l.expires_at>(strftime('%s','now')*1000) AND (l.node_id IN (SELECT id FROM ancestors WHERE depth=0 OR l.depth='infinity') OR (?2='infinity' AND l.node_id IN (SELECT id FROM descendants))) LIMIT 1",
    )
      .bind(input.nodeId, input.depth)
      .first<{ value: number }>();
    if (conflict !== null) return Response.json({ error: "locked" }, { status: 423 });
    const now = Date.now();
    const expiresAt = now + input.timeoutSeconds * 1000;
    const id = `lck_${crypto.randomUUID().replaceAll("-", "")}`;
    await this.env.DB.batch([
      this.credentialGuard(input),
      this.env.DB.prepare(
        "INSERT INTO locks(id,node_id,creator_user_id,creator_credential_id,token_digest,depth,expires_at,epoch,display_uri,generation,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10)",
      ).bind(
        id,
        input.nodeId,
        input.creatorUserId,
        input.creatorCredentialId,
        input.tokenDigest,
        input.depth,
        expiresAt,
        input.epoch,
        input.displayUri,
        now,
      ),
      this.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return Response.json({ id, expiresAt, generation: 1 });
  }

  private async refreshDavLock(input: DavLockRequest): Promise<Response> {
    const expiresAt = Date.now() + input.timeoutSeconds * 1000;
    await this.env.DB.batch([
      this.credentialGuard(input),
      this.env.DB.prepare(
        "UPDATE locks SET expires_at=?1,generation=generation+1,creator_credential_id=?2 WHERE node_id=?3 AND creator_user_id=?4 AND token_digest=?5 AND epoch=?6 AND expires_at>(strftime('%s','now')*1000)",
      ).bind(
        expiresAt,
        input.creatorCredentialId,
        input.nodeId,
        input.creatorUserId,
        input.tokenDigest,
        input.epoch,
      ),
      this.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return Response.json({ expiresAt });
  }

  private async deleteDavLock(input: DavLockRequest): Promise<Response> {
    await this.env.DB.batch([
      this.credentialGuard(input),
      this.env.DB.prepare(
        "DELETE FROM locks WHERE node_id=?1 AND creator_user_id=?2 AND token_digest=?3 AND epoch=?4 AND expires_at>(strftime('%s','now')*1000)",
      ).bind(input.nodeId, input.creatorUserId, input.tokenDigest, input.epoch),
      this.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
    return new Response(null, { status: 204 });
  }

  private async closePermit(permitId: string, state: "released" | "revoked"): Promise<Response> {
    const statements = [
      this.env.DB.prepare("UPDATE permits SET state=?1 WHERE permit_id=?2 AND state='open'").bind(
        state,
        permitId,
      ),
      this.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ];
    if (state === "revoked") {
      statements.push(
        this.env.DB.prepare(
          "UPDATE operations SET state='failed',error_code='permit_revoked',updated_at=strftime('%s','now')*1000 WHERE permit_id=?1 AND state='claimed'",
        ).bind(permitId),
      );
    }
    await this.env.DB.batch(statements);
    return new Response(null, { status: 204 });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/permits") {
      const body: unknown = await request.json();
      return isPermitRequest(body)
        ? this.issuePermit(body)
        : Response.json({ error: "invalid_permit" }, { status: 400 });
    }
    if (["POST", "PATCH", "DELETE"].includes(request.method) && url.pathname === "/locks") {
      const body: unknown = await request.json();
      if (!isDavLockRequest(body)) return Response.json({ error: "invalid_lock" }, { status: 400 });
      if (request.method === "POST") return this.createDavLock(body);
      if (request.method === "PATCH") return this.refreshDavLock(body);
      return this.deleteDavLock(body);
    }
    const match = /^\/permits\/([^/]+)\/(release|revoke)$/u.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined && match[2] !== undefined) {
      return this.closePermit(match[1], match[2] === "release" ? "released" : "revoked");
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
