import { problem } from "@next-cloud-flare/shared/errors";
import { AdminCursorTokens } from "../auth/adminCursor";
import type { Principal } from "../auth/authorize";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import { type AccessSession, readAccessSession } from "../auth/sessions";
import { assertExists, primary } from "../db/primary";
import type { Env } from "../env";
import {
  acquireAccountMutation,
  commitAccountMutation,
  MutationUnavailableError,
  userActor,
} from "../services/accountMutation";
import { issueContentTicket } from "../services/contentTicket";
import { listNodeChildren, readNode, readNodePath } from "../services/nodeRead";
import { admitContentTicketCost } from "./contentTickets";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const USERS = "/api/v1/admin/users";
const AUDIT = "/api/v1/admin/audit";
const NODE =
  /^\/api\/v1\/admin\/users\/([A-Za-z0-9_-]{1,128})\/nodes\/([A-Za-z0-9_-]{1,128})(\/children|\/path)?$/;
const CONTENT = /^\/api\/v1\/admin\/users\/([A-Za-z0-9_-]{1,128})\/content-session$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function adminBrowseRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" && (path === USERS || path === AUDIT || NODE.test(path))) ||
    (request.method === "POST" && CONTENT.test(path))
  );
}

function queryCursor(url: URL): string | undefined {
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1
  )
    throw new Error("invalid_admin_cursor");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096))
    throw new Error("invalid_admin_cursor");
  return cursor;
}

async function liveAdmin(env: Env, session: AccessSession): Promise<boolean> {
  const live = await readAccessSession(env.DB, session.credential_id, session.epoch);
  return live?.user_id === session.user_id && live.role === "app_admin";
}

function adminPrincipal(session: AccessSession, ownerId: string): Principal {
  return {
    kind: "admin_read",
    user_id: session.user_id,
    owner_id: ownerId,
    credential_id: session.credential_id,
    epoch: session.epoch,
  };
}

async function auditMetadata(env: Env, session: AccessSession, ownerId: string, nodeId: string) {
  const admission = await acquireAccountMutation(
    env,
    ownerId,
    session.epoch,
    "admin.files.read",
    userActor(session.user_id),
  );
  await commitAccountMutation(env.DB, admission, ownerId, [
    assertExists(
      `SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
      JOIN users actor ON actor.id=s.user_id JOIN nodes n ON n.id=? AND n.owner_id=?
      JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=s.epoch AND ctl.maintenance=0
      WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.user_id=?
        AND s.epoch=? AND s.revoked_at IS NULL AND s.expires_at>strftime('%s','now')*1000
        AND actor.role='app_admin' AND actor.disabled_at IS NULL AND n.deleted_at IS NULL`,
      [nodeId, ownerId, session.credential_id, session.user_id, session.epoch],
    ),
    {
      sql: `INSERT INTO admin_browse_audit(id,actor_id,owner_id,node_id,action,occurred_at)
        VALUES(?,?,?,?,'metadata',strftime('%s','now')*1000)`,
      values: [crypto.randomUUID(), session.user_id, ownerId, nodeId],
    },
  ]);
}

async function readJsonBounded(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("bad_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 8192) throw new Error("bad_body");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad_body");
  return value as Record<string, unknown>;
}

export async function handleAdminBrowseHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
  tokens: ContentTokens,
  nodeCursors?: NodeCursorTokens,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.hash || !adminBrowseRoute(request))
    return problem(404, "not_found");
  if (request.method === "GET" && request.body) return problem(400, "bad_request");
  if (session.role !== "app_admin" || !(await liveAdmin(env, session)))
    return problem(403, "forbidden");
  const cursors = nodeCursors ? new AdminCursorTokens(nodeCursors.ring) : undefined;
  if (url.pathname === USERS && request.method === "GET") {
    if (!cursors) return problem(503, "not_ready");
    try {
      const raw = queryCursor(url);
      const after = raw
        ? (await cursors.verify(raw, "users", session.credential_id, session.epoch)).lastId
        : "";
      const results = await primary(env.DB)
        .prepare(`SELECT u.id,u.email,sp.id AS spaceId,
        sp.root_node_id AS rootNodeId,u.quota_bytes AS quotaBytes,u.used_bytes AS usedBytes,
        (u.disabled_at IS NOT NULL) AS disabled FROM users u JOIN spaces sp ON sp.owner_id=u.id
        WHERE u.id>? ORDER BY u.id LIMIT 51`)
        .bind(after)
        .all();
      if (!(await liveAdmin(env, session))) return problem(403, "forbidden");
      const rows = (results.results ?? []) as Array<{
        id: string;
        email: string;
        spaceId: string;
        rootNodeId: string;
        quotaBytes: number;
        usedBytes: number;
        disabled: number;
      }>;
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      const nextCursor =
        rows.length > 50 && last
          ? await cursors.issue({
              kind: "users",
              credentialId: session.credential_id,
              epoch: session.epoch,
              lastId: last.id,
              lastTime: 0,
            })
          : null;
      return Response.json(
        {
          users: page.map(({ disabled, ...row }) => ({ ...row, disabled: disabled === 1 })),
          nextCursor,
        },
        { headers: HEADERS },
      );
    } catch {
      return problem(400, "bad_request");
    }
  }
  if (url.pathname === AUDIT && request.method === "GET") {
    if (!cursors) return problem(503, "not_ready");
    try {
      const raw = queryCursor(url);
      const after = raw
        ? await cursors.verify(raw, "audit", session.credential_id, session.epoch)
        : undefined;
      const results = await primary(env.DB)
        .prepare(`SELECT id,actor_id AS actorId,owner_id AS ownerId,
        node_id AS nodeId,action,occurred_at AS occurredAt FROM admin_browse_audit
        WHERE (? IS NULL OR occurred_at<? OR (occurred_at=? AND id<?))
        ORDER BY occurred_at DESC,id DESC LIMIT 51`)
        .bind(
          after?.lastTime ?? null,
          after?.lastTime ?? null,
          after?.lastTime ?? null,
          after?.lastId ?? "",
        )
        .all();
      if (!(await liveAdmin(env, session))) return problem(403, "forbidden");
      const rows = (results.results ?? []) as Array<{
        id: string;
        actorId: string;
        ownerId: string;
        nodeId: string | null;
        action: string;
        occurredAt: number;
      }>;
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      const nextCursor =
        rows.length > 50 && last
          ? await cursors.issue({
              kind: "audit",
              credentialId: session.credential_id,
              epoch: session.epoch,
              lastId: last.id,
              lastTime: last.occurredAt,
            })
          : null;
      return Response.json({ events: page, nextCursor }, { headers: HEADERS });
    } catch {
      return problem(400, "bad_request");
    }
  }
  const node = NODE.exec(url.pathname);
  if (node && request.method === "GET") {
    const ownerId = node[1] ?? "";
    const nodeId = node[2] ?? "";
    if (!ID.test(ownerId) || !ID.test(nodeId)) return problem(404, "not_found");
    try {
      const principal = adminPrincipal(session, ownerId);
      let result: unknown;
      if (node[3] === "/children") {
        if (!nodeCursors) return problem(503, "not_ready");
        result = await listNodeChildren(env.DB, principal, nodeId, nodeCursors, queryCursor(url));
      } else {
        if (url.search) return problem(400, "bad_request");
        result =
          node[3] === "/path"
            ? await readNodePath(env.DB, principal, nodeId)
            : await readNode(env.DB, principal, nodeId);
      }
      await auditMetadata(env, session, ownerId, nodeId);
      return Response.json(result, { headers: HEADERS });
    } catch (error) {
      if (error instanceof MutationUnavailableError) return problem(503, "not_ready");
      if (error instanceof Error && error.message === "invalid_admin_cursor")
        return problem(400, "bad_request");
      return problem(404, "not_found");
    }
  }
  const content = CONTENT.exec(url.pathname);
  if (content && request.method === "POST") {
    if (url.search) return problem(404, "not_found");
    try {
      await csrf.verify(env.DB, request, {
        kind: "access",
        credentialId: session.credential_id,
        epoch: session.epoch,
      });
    } catch {
      return problem(403, "forbidden");
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBounded(request);
    } catch {
      return problem(400, "bad_request");
    }
    if (
      Object.keys(body).sort().join(",") !== "action,purpose,targets,ttlSeconds" ||
      (body.action !== "preview" && body.action !== "download") ||
      body.purpose !== "content" ||
      !Number.isSafeInteger(body.ttlSeconds) ||
      (body.ttlSeconds as number) < 1 ||
      (body.ttlSeconds as number) > 600 ||
      !Array.isArray(body.targets) ||
      body.targets.length !== 1
    )
      return problem(400, "bad_request");
    const target = body.targets[0] as { nodeId?: unknown; spaceId?: unknown } | null;
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.keys(target).sort().join(",") !== "nodeId,spaceId" ||
      typeof target.nodeId !== "string" ||
      !ID.test(target.nodeId) ||
      typeof target.spaceId !== "string" ||
      !ID.test(target.spaceId)
    )
      return problem(400, "bad_request");
    const ticketRateFailure = await admitContentTicketCost(
      env,
      adminPrincipal(session, content[1] ?? ""),
      1,
    );
    if (ticketRateFailure) return ticketRateFailure;
    try {
      const issued = await issueContentTicket(
        env,
        env.BLOBS,
        tokens,
        adminPrincipal(session, content[1] ?? ""),
        [{ nodeId: target.nodeId, spaceId: target.spaceId }],
        "content",
        Math.min(Date.now() + (body.ttlSeconds as number) * 1000, session.expires_at),
        undefined,
        { adminAction: body.action },
      );
      return Response.json(issued, { status: 201, headers: HEADERS });
    } catch (error) {
      if (
        error instanceof MutationUnavailableError ||
        (error instanceof Error &&
          ["content_ticket_commit_unknown", "content_budget_commit_unknown"].includes(
            error.message,
          ))
      )
        return problem(503, "not_ready");
      return problem(404, "not_found");
    }
  }
  return problem(404, "not_found");
}
