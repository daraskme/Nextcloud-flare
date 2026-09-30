import { problem } from "@next-cloud-flare/shared/errors";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import { KdfUnavailableError } from "../auth/kdf";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { SharePasswordPepperRing } from "../auth/sharePassword";
import {
  authenticateShareSession,
  clearShareCookie,
  revokeShareSession,
  SharePasswordRequiredError,
  shareCookie,
  sharePrincipal,
  unlockShare,
} from "../auth/shareSession";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { issueContentTicket } from "../services/contentTicket";
import { cancelContentTicket } from "../services/contentTicketCancel";
import { listNodeChildren, readNode } from "../services/nodeRead";
import { readContentTicketRequest } from "./contentTickets";
import { hasEmptyBody } from "./emptyBody";
import { handlePublicUploadHttp, publicUploadRoute } from "./publicUploads";

const ID = "[A-Za-z0-9_-]{1,128}";
const SHARE = new RegExp(`^/api/v1/public/shares/(${ID})$`);
const CHILDREN = new RegExp(`^/api/v1/public/shares/(${ID})/children/(${ID})$`);
const UNLOCK = new RegExp(`^/api/v1/public/shares/(${ID})/unlock$`);
const LOGOUT = new RegExp(`^/api/v1/public/shares/(${ID})/logout$`);
const CSRF = new RegExp(`^/api/v1/public/shares/(${ID})/csrf$`);
const TICKETS = new RegExp(`^/api/v1/public/shares/(${ID})/tickets$`);
const TICKET = new RegExp(`^/api/v1/public/shares/(${ID})/tickets/(${ID})$`);
const CONTENT_SESSION = new RegExp(`^/api/v1/public/shares/(${ID})/content-session$`);
const MAX_BODY = 8192;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export interface PublicShareDependencies {
  readonly csrf: Pick<CsrfTokens, "issue" | "verify">;
  readonly cursors?: NodeCursorTokens;
  readonly tokens?: ContentTokens;
  readonly passwordPepper?: SharePasswordPepperRing;
  readonly uploadCapabilities?: import("../auth/uploadCapability").UploadCapabilities;
}

class SharePasswordRateLimitError extends Error {
  constructor() {
    super("share_password_rate_limited");
  }
}

export function publicShareApiRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" && (SHARE.test(path) || CHILDREN.test(path))) ||
    (request.method === "POST" &&
      (UNLOCK.test(path) ||
        LOGOUT.test(path) ||
        CSRF.test(path) ||
        TICKETS.test(path) ||
        CONTENT_SESSION.test(path))) ||
    (request.method === "DELETE" && TICKET.test(path)) ||
    publicUploadRoute(request)
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_public_share_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_public_share_request");
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_public_share_request");
  return parsed as Record<string, unknown>;
}

function sameOriginForm(request: Request, origin: string): boolean {
  return (
    new URL(request.url).origin === origin &&
    request.headers.get("Origin") === origin &&
    request.headers.get("Sec-Fetch-Site") === "same-origin" &&
    request.headers.get("Content-Type") === "application/json"
  );
}

function sessionCsrf(session: Awaited<ReturnType<typeof authenticateShareSession>>) {
  return {
    kind: "share" as const,
    credentialId: session.credentialId,
    epoch: session.epoch,
    shareId: session.shareId,
  };
}

function nodeFailure(error: unknown): Response {
  return error instanceof Error && error.message === "invalid_node_cursor"
    ? problem(400, "bad_request")
    : problem(404, "not_found");
}

export async function handlePublicShareHttp(
  request: Request,
  env: Env,
  epoch: number,
  dependencies: PublicShareDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.hash || (request.method === "GET" && request.body))
    return problem(404, "not_found");
  const unlock = request.method === "POST" ? UNLOCK.exec(url.pathname) : null;
  if (unlock) {
    if (url.search || !sameOriginForm(request, env.APP_ORIGIN)) return problem(403, "forbidden");
    const shareId = unlock[1] ?? "";
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (ip.length > 64) return problem(403, "forbidden");
    try {
      if (!(await env.EDGE_LIMITER.limit({ key: `share-unlock:${shareId}:${ip}` })).success)
        return problem(429, "rate_limited");
    } catch {
      return problem(503, "not_ready");
    }
    let body: Record<string, unknown>;
    try {
      body = await jsonBody(request);
    } catch {
      return problem(400, "bad_request");
    }
    if (
      Object.keys(body).some((key) => !["secret", "password"].includes(key)) ||
      typeof body.secret !== "string" ||
      (body.password !== undefined && typeof body.password !== "string")
    )
      return problem(400, "bad_request");
    try {
      const { session, cookieSecret } = await unlockShare(env, shareId, body.secret, epoch, {
        ...(body.password === undefined ? {} : { password: body.password as string }),
        ...(dependencies.passwordPepper ? { passwordRing: dependencies.passwordPepper } : {}),
        signal: request.signal,
        admitPasswordAttempt: async () => {
          let shareLimit;
          let ipLimit;
          try {
            [shareLimit, ipLimit] = await Promise.all([
              env.SHARE_PASSWORD_LIMITER.limit({ key: shareId }),
              env.SHARE_PASSWORD_IP_LIMITER.limit({ key: ip }),
            ]);
          } catch {
            throw new KdfUnavailableError();
          }
          if (!shareLimit.success || !ipLimit.success) throw new SharePasswordRateLimitError();
        },
      });
      return Response.json(
        { shareId: session.shareId, kind: session.kind, expiresAt: session.expiresAt },
        {
          headers: {
            ...HEADERS,
            "Set-Cookie": shareCookie(session.shareId, cookieSecret, session.expiresAt),
          },
        },
      );
    } catch (error) {
      if (error instanceof SharePasswordRequiredError) return problem(401, "password_required");
      if (error instanceof SharePasswordRateLimitError) {
        const response = problem(429, "rate_limited");
        response.headers.set("Retry-After", "60");
        return response;
      }
      if (error instanceof MutationUnavailableError || error instanceof KdfUnavailableError) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return problem(404, "not_found");
    }
  }
  const shareMatch = request.method === "GET" ? SHARE.exec(url.pathname) : null;
  const childrenMatch = request.method === "GET" ? CHILDREN.exec(url.pathname) : null;
  const csrfMatch = request.method === "POST" ? CSRF.exec(url.pathname) : null;
  const logoutMatch = request.method === "POST" ? LOGOUT.exec(url.pathname) : null;
  const ticketsMatch = request.method === "POST" ? TICKETS.exec(url.pathname) : null;
  const contentSessionMatch = request.method === "POST" ? CONTENT_SESSION.exec(url.pathname) : null;
  const ticketMatch = request.method === "DELETE" ? TICKET.exec(url.pathname) : null;
  const uploadShareId = publicUploadRoute(request)
    ? url.pathname.match(/^\/api\/v1\/public\/shares\/([A-Za-z0-9_-]{1,128})\/uploads(?:\/|$)/)?.[1]
    : undefined;
  const shareId =
    shareMatch?.[1] ??
    childrenMatch?.[1] ??
    csrfMatch?.[1] ??
    logoutMatch?.[1] ??
    ticketsMatch?.[1] ??
    contentSessionMatch?.[1] ??
    ticketMatch?.[1] ??
    uploadShareId ??
    "";
  if (!shareId) return problem(404, "not_found");
  let session;
  try {
    session = await authenticateShareSession(env.DB, request, shareId, epoch);
  } catch {
    return problem(401, "unauthorized");
  }
  if (csrfMatch) {
    if (url.search) return problem(404, "not_found");
    try {
      return Response.json(await dependencies.csrf.issue(env.DB, request, sessionCsrf(session)), {
        headers: HEADERS,
      });
    } catch {
      return problem(403, "forbidden");
    }
  }
  if (uploadShareId) {
    return handlePublicUploadHttp(request, env, session, {
      csrf: dependencies.csrf,
      ...(dependencies.uploadCapabilities ? { capabilities: dependencies.uploadCapabilities } : {}),
    });
  }
  if (logoutMatch) {
    if (url.search) return problem(404, "not_found");
    try {
      await dependencies.csrf.verify(env.DB, request, sessionCsrf(session));
      const body = await jsonBody(request);
      if (Object.keys(body).length !== 0) return problem(400, "bad_request");
      await revokeShareSession(env, session);
      return new Response(null, {
        status: 204,
        headers: { ...HEADERS, "Set-Cookie": clearShareCookie(shareId) },
      });
    } catch (error) {
      if (error instanceof MutationUnavailableError) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return problem(403, "forbidden");
    }
  }
  const principal = sharePrincipal(session);
  if (
    session.kind === "upload_only" &&
    (childrenMatch || ticketMatch || ticketsMatch || contentSessionMatch)
  )
    return problem(404, "not_found");
  if (ticketMatch) {
    if (url.search) return problem(404, "not_found");
    try {
      await dependencies.csrf.verify(env.DB, request, sessionCsrf(session));
    } catch {
      return problem(403, "forbidden");
    }
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    try {
      await cancelContentTicket(env, principal, ticketMatch[2] ?? "");
    } catch (error) {
      if (
        error instanceof MutationUnavailableError ||
        (error instanceof Error && error.message === "ticket_cancel_commit_unknown")
      ) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return problem(404, "not_found");
    }
    return new Response(null, { status: 204, headers: HEADERS });
  }
  if (ticketsMatch || contentSessionMatch) {
    if (url.search) return problem(404, "not_found");
    if (!dependencies.tokens) return problem(503, "not_ready");
    try {
      await dependencies.csrf.verify(env.DB, request, sessionCsrf(session));
    } catch {
      return problem(403, "forbidden");
    }
    let body;
    try {
      body = await readContentTicketRequest(request);
      if (body.share || !["content", "thumb"].includes(body.purpose))
        throw new Error("invalid_ticket_body");
    } catch {
      return problem(400, "bad_request");
    }
    try {
      const issued = await issueContentTicket(
        env,
        env.BLOBS,
        dependencies.tokens,
        principal,
        body.targets,
        body.purpose,
        Math.min(Date.now() + body.ttlSeconds * 1000, session.expiresAt),
      );
      return Response.json(issued, { status: 201, headers: HEADERS });
    } catch (error) {
      if (
        error instanceof MutationUnavailableError ||
        (error instanceof Error &&
          ["content_ticket_commit_unknown", "content_budget_commit_unknown"].includes(
            error.message,
          ))
      ) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return problem(404, "not_found");
    }
  }
  if (shareMatch) {
    if (url.search) return problem(404, "not_found");
    if (session.kind === "upload_only") {
      return Response.json(
        {
          id: session.shareId,
          kind: session.kind,
          version: session.shareVersion,
          expiresAt: session.shareExpiresAt,
          createdAt: session.createdAt,
          actions: ["create", "upload"],
        },
        { headers: HEADERS },
      );
    }
    try {
      const root = await readNode(env.DB, principal, session.rootNodeId);
      return Response.json(
        {
          id: session.shareId,
          kind: session.kind,
          version: session.shareVersion,
          expiresAt: session.shareExpiresAt,
          createdAt: session.createdAt,
          contentOrigin: env.CONTENT_ORIGIN,
          root,
          actions: ["read", "download"],
        },
        { headers: HEADERS },
      );
    } catch (error) {
      return nodeFailure(error);
    }
  }
  if (!childrenMatch) return problem(404, "not_found");
  if (!dependencies.cursors) return problem(503, "not_ready");
  if (
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1
  )
    return problem(400, "bad_request");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096))
    return problem(400, "bad_request");
  try {
    return Response.json(
      await listNodeChildren(
        env.DB,
        principal,
        childrenMatch[2] ?? "",
        dependencies.cursors,
        cursor,
      ),
      { headers: HEADERS },
    );
  } catch (error) {
    return nodeFailure(error);
  }
}
