import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import {
  authenticateShareSession,
  clearShareCookie,
  revokeShareSession,
  shareCookie,
  sharePrincipal,
  unlockShare,
} from "../auth/shareSession";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { listNodeChildren, readNode } from "../services/nodeRead";

const ID = "[A-Za-z0-9_-]{1,128}";
const SHARE = new RegExp(`^/api/v1/public/shares/(${ID})$`);
const CHILDREN = new RegExp(`^/api/v1/public/shares/(${ID})/children/(${ID})$`);
const UNLOCK = new RegExp(`^/api/v1/public/shares/(${ID})/unlock$`);
const LOGOUT = new RegExp(`^/api/v1/public/shares/(${ID})/logout$`);
const CSRF = new RegExp(`^/api/v1/public/shares/(${ID})/csrf$`);
const MAX_BODY = 4096;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export interface PublicShareDependencies {
  readonly csrf: Pick<CsrfTokens, "issue" | "verify">;
  readonly cursors?: NodeCursorTokens;
}

export function publicShareApiRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" && (SHARE.test(path) || CHILDREN.test(path))) ||
    (request.method === "POST" && (UNLOCK.test(path) || LOGOUT.test(path) || CSRF.test(path)))
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
    if (Object.keys(body).join(",") !== "secret" || typeof body.secret !== "string")
      return problem(400, "bad_request");
    try {
      const { session, cookieSecret } = await unlockShare(env, shareId, body.secret, epoch);
      return Response.json(
        { shareId: session.shareId, expiresAt: session.expiresAt },
        {
          headers: {
            ...HEADERS,
            "Set-Cookie": shareCookie(session.shareId, cookieSecret, session.expiresAt),
          },
        },
      );
    } catch (error) {
      if (error instanceof MutationUnavailableError) {
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
  const shareId = shareMatch?.[1] ?? childrenMatch?.[1] ?? csrfMatch?.[1] ?? logoutMatch?.[1] ?? "";
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
  if (shareMatch) {
    if (url.search) return problem(404, "not_found");
    try {
      const root = await readNode(env.DB, principal, session.rootNodeId);
      return Response.json(
        {
          id: session.shareId,
          version: session.shareVersion,
          expiresAt: session.shareExpiresAt,
          createdAt: session.createdAt,
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
