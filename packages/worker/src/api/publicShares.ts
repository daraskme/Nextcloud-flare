import { problem } from "@next-cloud-flare/shared/errors";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { SharePasswordRing } from "../auth/shareSecrets";
import { type ShareTokens, shareCookieHeader, shareCookieValue } from "../auth/shareTokens";
import { CONTROL_NAME } from "../do/controlName";
import { canonicalClientIp } from "../do/controlShareUnlock";
import type { Env } from "../env";
import {
  logoutShare,
  readShareSession,
  type ShareSession,
  unlockShare,
} from "../services/shareUnlock";
import { hasEmptyBody } from "./emptyBody";
import {
  PUBLIC_OPERATION,
  publicOperationRoute,
  publicShareMutation,
  publicShareOperation,
} from "./publicShareMutations";
import { publicShareRead, publicShareTicket } from "./publicShareRead";
import { readShareBody } from "./shares";

const ROUTE =
  /^\/api\/v1\/public\/shares\/([A-Za-z0-9_-]{1,128})(?:\/(unlock|logout|csrf|content-session|tickets(?:\/[A-Za-z0-9_-]{1,128})?|nodes(?:\/[A-Za-z0-9_-]{1,128})?|children\/[A-Za-z0-9_-]{1,128}))?$/;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export interface PublicShareDependencies {
  tokens: ShareTokens;
  csrf: CsrfTokens;
  passwords?: SharePasswordRing;
  cursors?: NodeCursorTokens;
  contentTokens?: ContentTokens;
}
export const publicShareRoute = (request: Request) => {
  const match = ROUTE.exec(new URL(request.url).pathname),
    action = match?.[2] ?? "";
  return (
    publicOperationRoute(request) ||
    (!!match &&
      ((request.method === "GET" && (!action || action.startsWith("children/"))) ||
        (request.method === "POST" &&
          ["unlock", "csrf", "logout", "tickets", "content-session", "nodes"].includes(action)) ||
        (request.method === "PATCH" && action.startsWith("nodes/")) ||
        (request.method === "DELETE" && action.startsWith("tickets/"))))
  );
};
const csrfSession = (s: ShareSession) => ({
  kind: "share" as const,
  credentialId: `ss:${s.claims.session_id}`,
  epoch: s.claims.epoch,
  shareId: s.claims.share_id,
});
const info = (s: ShareSession) => ({
  unlocked: true,
  id: s.claims.share_id,
  version: s.claims.share_version,
  rootNodeId: s.rootNodeId,
  expiresAt: s.claims.exp * 1000,
});
function limited(seconds: number) {
  const response = problem(429, "rate_limited");
  response.headers.set("Retry-After", String(seconds));
  return response;
}

/** Public authentication is independent of Access and never accepts credentials in query strings. */
export async function handlePublicShareHttp(
  request: Request,
  env: Env,
  epoch: number,
  dependencies: PublicShareDependencies,
): Promise<Response> {
  const url = new URL(request.url),
    match = ROUTE.exec(url.pathname),
    operation = publicOperationRoute(request) ? PUBLIC_OPERATION.exec(url.pathname) : null;
  if ((!match && !operation) || !publicShareRoute(request) || url.origin !== env.APP_ORIGIN)
    return problem(404, "not_found");
  const id = operation ? request.headers.get("X-Share-Id")! : match![1]!,
    action = match?.[2] ?? "",
    { tokens, csrf, passwords } = dependencies;
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return problem(400, "bad_request");
    if ((url.search && !action.startsWith("children/")) || url.hash)
      return problem(400, "bad_request");
    if (
      (request.headers.get("Origin") !== env.APP_ORIGIN &&
        !(request.method === "GET" && request.headers.get("Origin") === null)) ||
      request.headers.get("Sec-Fetch-Site") !== "same-origin"
    )
      return problem(403, "forbidden");
    const ip = canonicalClientIp(
      request.headers.get("CF-Connecting-IP") ??
        (env.ENVIRONMENT === "development" ? "127.0.0.1" : ""),
    );
    if (!(await env.EDGE_LIMITER.limit({ key: `public:${ip}` })).success) return limited(60);
    let session: ShareSession | null = null;
    let previousSessionNonce: string | undefined;
    const existing = shareCookieValue(request.headers.get("Cookie"), id);
    if (existing) {
      try {
        const claims = await tokens.verify(existing, id, epoch);
        previousSessionNonce = claims.nonce;
        session = await readShareSession(env.DB, claims);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["share_cookie_rejected", "share_session_unavailable"].includes(error.message)
        )
          throw error;
      }
    }
    if (operation || action === "nodes" || action.startsWith("nodes/")) {
      if (!session) return problem(401, "unauthorized");
      // Bind retries to the original unlock credential even if another tab replaces the cookie.
      if (request.headers.get("Share-Session") !== session.claims.session_id)
        return problem(412, "precondition_failed");
      if (operation) return await publicShareOperation(request, env, session, operation[1]!);
      await csrf.verify(env.DB, request, csrfSession(session));
      return publicShareMutation(request, env, session, action);
    }
    if (request.method === "GET") {
      if (!session) return problem(401, "unauthorized");
      return publicShareRead(request, env, session, action, dependencies.cursors);
    }
    if (action === "tickets" || action === "content-session" || action.startsWith("tickets/")) {
      if (!session) return problem(401, "unauthorized");
      await csrf.verify(env.DB, request, csrfSession(session));
      return publicShareTicket(
        request,
        env,
        session,
        action.startsWith("tickets/") ? action.slice(8) : undefined,
        dependencies.contentTokens,
      );
    }
    if (action === "csrf") {
      if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
      if (!session) return problem(401, "unauthorized");
      return Response.json(await csrf.issue(env.DB, request, csrfSession(session)), {
        headers: HEADERS,
      });
    }
    if (action === "logout") {
      if (!session) return problem(401, "unauthorized");
      await csrf.verify(env.DB, request, csrfSession(session));
      const body = await readShareBody(request);
      if (Object.keys(body as object).length) return problem(400, "bad_request");
      await logoutShare(env, session);
      const response = new Response(null, { status: 204, headers: HEADERS });
      response.headers.append("Set-Cookie", shareCookieHeader(id, "", 0));
      response.headers.append("Set-Cookie", shareCookieHeader(id, "", 0, true));
      return response;
    }
    const value = await readShareBody(request),
      input = value as Record<string, unknown>;
    if (input.step === "challenge" && Object.keys(input).length === 1) {
      // This step reveals no unauthenticated share metadata, and performs no D1 mutation or KDF.
      if (session) return Response.json(info(session), { headers: HEADERS });
      const prior = shareCookieValue(request.headers.get("Cookie"), id, true);
      if (prior) {
        try {
          const challenge = await tokens.verifyChallenge(prior, id, epoch);
          // A challenge belonging to an unavailable credential cannot revive it.
          // Keep a newer challenge stable even while the old session cookie remains:
          // its successful unlock response may have been lost.
          if (challenge.nonce !== previousSessionNonce)
            return Response.json(
              { token: prior, expiresAt: challenge.exp * 1000 },
              { headers: HEADERS },
            );
        } catch {
          /* issue a fresh challenge after expiry/key removal */
        }
      }
      const challenge = await tokens.challenge(id, epoch);
      return Response.json(
        { token: challenge.token, expiresAt: challenge.claims.exp * 1000 },
        {
          headers: { ...HEADERS, "Set-Cookie": shareCookieHeader(id, challenge.token, 300, true) },
        },
      );
    }
    const challengeToken = shareCookieValue(request.headers.get("Cookie"), id, true);
    if (!challengeToken || request.headers.get("X-CSRF-Token") !== challengeToken)
      return problem(403, "forbidden");
    const challenge = await tokens.verifyChallenge(challengeToken, id, epoch);
    if (!session) {
      // Never retry a rate RPC with an unknown outcome, and never fall back to isolate counters.
      const result = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).admitShareUnlock({
        shareId: id,
        clientIp: ip,
        epoch,
        deadline: Date.now() + 5000,
      });
      if (result.allowed !== true) {
        if (
          result.allowed !== false ||
          !Number.isSafeInteger(result.retryAfter) ||
          result.retryAfter < 1 ||
          result.retryAfter > 60
        )
          throw new Error("share_unlock_unavailable");
        return limited(result.retryAfter);
      }
      session = await unlockShare(env, challenge, input, passwords, request.signal);
    }
    const cookie = await tokens.issue(session.claims);
    return Response.json(info(session), {
      headers: {
        ...HEADERS,
        "Set-Cookie": shareCookieHeader(
          id,
          cookie,
          Math.max(0, session.claims.exp - Math.floor(Date.now() / 1000)),
        ),
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "invalid_share_request") return problem(400, "bad_request");
    if (["csrf_rejected", "share_cookie_rejected"].includes(code)) return problem(403, "forbidden");
    if (["share_unlock_rejected", "share_session_unavailable"].includes(code)) {
      const response = problem(401, "unauthorized");
      if (code === "share_session_unavailable")
        response.headers.append("Set-Cookie", shareCookieHeader(id, "", 0, true));
      return response;
    }
    return problem(503, "not_ready");
  }
}
