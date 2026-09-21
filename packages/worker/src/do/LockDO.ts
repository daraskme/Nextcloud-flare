import type { Env } from "../env.js";

interface PermitRequest {
  permitId: string;
  spaceId: string;
  epoch: number;
  ttlMs: number;
  nodeIds?: string[];
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
        request.nodeIds.every((nodeId) => typeof nodeId === "string" && nodeId.length > 0)))
  );
}

export class LockDO {
  private readonly env: Env;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  private async issuePermit(input: PermitRequest): Promise<Response> {
    const expiresAt = Date.now() + input.ttlMs;
    const locked = await this.env.DB.prepare(
      "SELECT 1 locked FROM locks WHERE expires_at>(strftime('%s','now')*1000) AND node_id IN (SELECT value FROM json_each(?1)) LIMIT 1",
    )
      .bind(JSON.stringify(input.nodeIds ?? []))
      .first<{ locked: number }>();
    if (locked !== null) {
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
    const match = /^\/permits\/([^/]+)\/(release|revoke)$/u.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined && match[2] !== undefined) {
      return this.closePermit(match[1], match[2] === "release" ? "released" : "revoked");
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
