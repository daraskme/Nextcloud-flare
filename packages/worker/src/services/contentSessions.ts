import type { ContentPurpose } from "@ncf/shared";

import type { AuthenticatedUser } from "../auth/httpAuth.js";
import type { AuthenticatedShare } from "../auth/share.js";
import { randomToken, sha256, signToken, verifyToken } from "../auth/tokens.js";
import type { Env } from "../env.js";
import { acquireBudget, attachBudgetLease, hasOwnerBudgetCapacity } from "./budgets.js";
import { getContentDescriptor, serveNodeContentById, type ContentDescriptor } from "./content.js";
import { assertShareNode, findInternalShare, type ShareCapability } from "./shares.js";

const CONTENT_SESSION_TTL_MS = 10 * 60 * 1000;
const CONTENT_COOKIE = "__Host-ncf_cs";

interface ContentTarget {
  nodeId: string;
  blobId: string;
  purpose: ContentPurpose;
  size: number;
}

interface TicketResult {
  ticket: string;
  expiresAt: number;
  contentOrigin: string;
}

function signingKey(env: Env): string {
  const key = env.CONTENT_SESSION_KEY;
  if (key === undefined || key.length < 32)
    throw new Error("content_session_configuration_invalid");
  return key;
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${CONTENT_COOKIE}=`));
  return matches.length === 1 ? (matches[0]?.slice(CONTENT_COOKIE.length + 1) ?? null) : null;
}

async function createTicket(
  env: Env,
  input: {
    issuerSessionId: string;
    userId: string | null;
    shareId: string | null;
    shareVersion: number | null;
    ownerId: string;
    budgetId: string;
    maxBytes: number;
    purpose: ContentPurpose;
    targets: ContentTarget[];
    expiresAt: number;
  },
): Promise<TicketResult> {
  if (!(await hasOwnerBudgetCapacity(env, input.ownerId))) throw new Error("budget_owner_limit");
  const now = Date.now();
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  const targetSetId = `cts_${randomToken(18)}`;
  const ticketId = `tkt_${randomToken(18)}`;
  const targetsJson = JSON.stringify(input.targets);
  const targetHash = await sha256(targetsJson);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND revoked_at IS NULL AND expires_at>?2)",
    ).bind(input.issuerSessionId, now),
    ...(input.shareId === null
      ? []
      : [
          env.DB.prepare(
            "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shares WHERE id=?1 AND version=?2 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?3))",
          ).bind(input.shareId, input.shareVersion, now),
        ]),
    env.DB.prepare(
      "INSERT INTO content_target_sets(id,owner_id,target_hash,targets_json,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",
    ).bind(targetSetId, input.ownerId, targetHash, targetsJson, now, input.expiresAt),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "INSERT INTO content_tickets(id,issuer_session_id,user_id,share_id,share_version,target_set_id,purpose,budget_id,max_bytes,epoch,expires_at,canceled_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12)",
    ).bind(
      ticketId,
      input.issuerSessionId,
      input.userId,
      input.shareId,
      input.shareVersion,
      targetSetId,
      input.purpose,
      input.budgetId,
      input.maxBytes,
      control.epoch,
      input.expiresAt,
      now,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return {
    ticket: await signToken(signingKey(env), {
      typ: "content-session",
      kid: "content-session-v1",
      aud: env.CONTENT_ORIGIN,
      iat: now,
      exp: input.expiresAt,
      epoch: control.epoch,
      ticketId,
      targetSetId,
      targetHash,
      purpose: input.purpose,
      budgetId: input.budgetId,
    }),
    expiresAt: input.expiresAt,
    contentOrigin: env.CONTENT_ORIGIN,
  };
}

function tripleBudget(bytes: number): number {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > Math.floor(Number.MAX_SAFE_INTEGER / 3)
  ) {
    throw new Error("content_target_too_large");
  }
  return bytes * 3;
}

export async function createUserContentTicket(
  env: Env,
  user: AuthenticatedUser,
  purpose: ContentPurpose,
  nodeIds: readonly string[],
): Promise<TicketResult> {
  const targets: ContentTarget[] = [];
  let shared: ShareCapability | null = null;
  let ownerId = user.principal.userId;
  for (const nodeId of nodeIds) {
    const item = await getContentDescriptor(env, nodeId);
    if (item.ownerId !== user.principal.userId) {
      const share = await findInternalShare(env, user.principal.userId, nodeId, "download");
      if (share === null || (shared !== null && share.id !== shared.id)) {
        throw new Error("node_not_found");
      }
      shared = share;
      ownerId = share.ownerId;
    } else if (shared !== null) {
      throw new Error("content_target_mixed_scope");
    }
    targets.push({ nodeId, blobId: item.blobId, purpose, size: item.size });
  }
  const now = Date.now();
  return createTicket(env, {
    issuerSessionId: user.principal.sessionId,
    userId: user.principal.userId,
    shareId: shared?.id ?? null,
    shareVersion: shared?.version ?? null,
    ownerId,
    budgetId:
      shared === null ? `u:${user.principal.userId}` : `u:${user.principal.userId}:s:${shared.id}`,
    maxBytes: tripleBudget(targets.reduce((sum, target) => sum + target.size, 0)),
    purpose,
    targets,
    expiresAt: now + CONTENT_SESSION_TTL_MS,
  });
}

export async function createShareContentTicket(
  env: Env,
  authentication: AuthenticatedShare,
  purpose: ContentPurpose,
  nodeIds: readonly string[],
): Promise<TicketResult> {
  const targets: ContentTarget[] = [];
  for (const nodeId of nodeIds) {
    await assertShareNode(env, authentication.share, nodeId, "download");
    const item = await getContentDescriptor(env, nodeId);
    targets.push({ nodeId, blobId: item.blobId, purpose, size: item.size });
  }
  const now = Date.now();
  return createTicket(env, {
    issuerSessionId: authentication.sessionId,
    userId: null,
    shareId: authentication.share.id,
    shareVersion: authentication.share.version,
    ownerId: authentication.share.ownerId,
    budgetId: authentication.budgetId,
    maxBytes: authentication.budgetMaxBytes,
    purpose,
    targets,
    expiresAt: Math.min(
      now + CONTENT_SESSION_TTL_MS,
      authentication.share.expiresAt ?? Number.MAX_SAFE_INTEGER,
    ),
  });
}

export async function acceptContentTicket(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<{ cookie: string; expiresAt: number }> {
  const payload = await verifyToken(signingKey(env), token);
  if (
    payload?.typ !== "content-session" ||
    payload.kid !== "content-session-v1" ||
    payload.aud !== env.CONTENT_ORIGIN ||
    typeof payload.ticketId !== "string" ||
    typeof payload.targetSetId !== "string" ||
    typeof payload.targetHash !== "string" ||
    typeof payload.budgetId !== "string" ||
    typeof payload.epoch !== "number" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat > now ||
    payload.exp <= now ||
    payload.exp - payload.iat > CONTENT_SESSION_TTL_MS
  ) {
    throw new Error("content_ticket_invalid");
  }
  const row = await env.DB.prepare(
    "SELECT t.issuer_session_id issuerSessionId,t.user_id userId,t.share_id shareId,t.share_version shareVersion,t.target_set_id targetSetId,ts.target_hash targetHash,t.budget_id budgetId,t.epoch,t.expires_at expiresAt FROM content_tickets t JOIN content_target_sets ts ON ts.id=t.target_set_id JOIN sessions se ON se.id=t.issuer_session_id JOIN control c ON c.singleton=1 WHERE t.id=?1 AND t.canceled_at IS NULL AND t.expires_at>?2 AND ts.expires_at>?2 AND se.revoked_at IS NULL AND se.expires_at>?2 AND c.epoch=t.epoch",
  )
    .bind(payload.ticketId, now)
    .first<{
      issuerSessionId: string;
      userId: string | null;
      shareId: string | null;
      shareVersion: number | null;
      targetSetId: string;
      targetHash: string;
      budgetId: string;
      epoch: number;
      expiresAt: number;
    }>();
  if (
    row === null ||
    row.targetSetId !== payload.targetSetId ||
    row.targetHash !== payload.targetHash ||
    row.budgetId !== payload.budgetId ||
    row.epoch !== payload.epoch ||
    row.expiresAt !== payload.exp
  ) {
    throw new Error("content_ticket_invalid");
  }
  if (row.shareId !== null) {
    const live = await env.DB.prepare(
      "SELECT 1 live FROM shares WHERE id=?1 AND version=?2 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?3)",
    )
      .bind(row.shareId, row.shareVersion, now)
      .first<{ live: number }>();
    if (live === null) throw new Error("content_ticket_invalid");
  }
  const sessionId = `cs_${randomToken(24)}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO content_sessions(id,user_id,share_id,share_version,issued_by_credential_id,target_set_id,budget_id,epoch,issued_at,expires_at,revoked_at,ticket_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,?11)",
    ).bind(
      sessionId,
      row.userId,
      row.shareId,
      row.shareVersion,
      row.issuerSessionId,
      row.targetSetId,
      row.budgetId,
      row.epoch,
      now,
      row.expiresAt,
      payload.ticketId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  return {
    cookie: `${CONTENT_COOKIE}=${sessionId}; Path=/; Max-Age=${Math.floor((row.expiresAt - now) / 1000)}; Secure; HttpOnly; SameSite=None`,
    expiresAt: row.expiresAt,
  };
}

async function contentSession(
  env: Env,
  request: Request,
  nodeId: string,
  blobId: string,
  purpose: ContentPurpose,
  now = Date.now(),
): Promise<{ descriptor: ContentDescriptor; budgetId: string; maxBytes: number }> {
  const sessionId = cookieValue(request);
  if (sessionId === null || !/^cs_[A-Za-z0-9_-]{20,}$/u.test(sessionId)) {
    throw new Error("content_session_required");
  }
  const row = await env.DB.prepare(
    "SELECT cs.user_id userId,cs.share_id shareId,cs.share_version shareVersion,cs.issued_by_credential_id issuerSessionId,cs.budget_id budgetId,ts.targets_json targetsJson,t.max_bytes maxBytes FROM content_sessions cs JOIN content_target_sets ts ON ts.id=cs.target_set_id JOIN content_tickets t ON t.id=cs.ticket_id JOIN sessions se ON se.id=cs.issued_by_credential_id JOIN control c ON c.singleton=1 WHERE cs.id=?1 AND cs.revoked_at IS NULL AND cs.expires_at>?2 AND ts.expires_at>?2 AND t.canceled_at IS NULL AND t.expires_at>?2 AND se.revoked_at IS NULL AND se.expires_at>?2 AND c.epoch=cs.epoch",
  )
    .bind(sessionId, now)
    .first<{
      userId: string | null;
      shareId: string | null;
      shareVersion: number | null;
      issuerSessionId: string;
      budgetId: string;
      targetsJson: string;
      maxBytes: number;
    }>();
  if (row === null) throw new Error("content_session_required");
  if (row.shareId !== null) {
    const live = await env.DB.prepare(
      "SELECT 1 live FROM shares s LEFT JOIN share_sessions ss ON ss.id=?1 AND ss.share_id=s.id WHERE s.id=?2 AND s.version=?3 AND s.disabled_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?4) AND (ss.id IS NULL OR (ss.share_version=s.version AND ss.revoked_at IS NULL AND ss.expires_at>?4))",
    )
      .bind(row.issuerSessionId, row.shareId, row.shareVersion, now)
      .first<{ live: number }>();
    if (live === null) throw new Error("content_session_required");
  }
  let targets: ContentTarget[];
  try {
    targets = JSON.parse(row.targetsJson) as ContentTarget[];
  } catch {
    throw new Error("content_session_invalid");
  }
  if (
    !targets.some(
      (target) =>
        target.nodeId === nodeId && target.blobId === blobId && target.purpose === purpose,
    )
  ) {
    throw new Error("content_target_forbidden");
  }
  const descriptor = await getContentDescriptor(env, nodeId);
  if (descriptor.blobId !== blobId) throw new Error("content_target_stale");
  return { descriptor, budgetId: row.budgetId, maxBytes: row.maxBytes };
}

export async function serveContentSession(
  env: Env,
  request: Request,
  nodeId: string,
  blobId: string,
  purpose: ContentPurpose = "content",
): Promise<Response> {
  const session = await contentSession(env, request, nodeId, blobId, purpose);
  const bytes = request.method === "HEAD" ? 0 : session.descriptor.size;
  const lease = await acquireBudget(env, session.budgetId, session.maxBytes, bytes);
  try {
    return await attachBudgetLease(await serveNodeContentById(env, nodeId, request), lease);
  } catch (error) {
    await lease.settle().catch(() => undefined);
    throw error;
  }
}

export async function cancelContentTicket(
  env: Env,
  ticketId: string,
  issuerSessionId: string,
  now = Date.now(),
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE content_tickets SET canceled_at=?1 WHERE id=?2 AND issuer_session_id=?3 AND canceled_at IS NULL",
    ).bind(now, ticketId, issuerSessionId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE content_sessions SET revoked_at=?1 WHERE ticket_id=?2 AND revoked_at IS NULL",
    ).bind(now, ticketId),
  ]);
}
