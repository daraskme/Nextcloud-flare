import { problem } from "@next-cloud-flare/shared/errors";
import { AccessAuthenticationError, type AccessVerifier } from "../auth/access";
import type { BootstrapPolicy } from "../auth/bootstrap";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import { loginAccessUser } from "../auth/login";
import type { Env } from "../env";
import { handlePrivateContentTicketHttp } from "./contentTickets";

export interface PrivateAppDependencies {
  readonly verifier: AccessVerifier;
  readonly csrf: CsrfTokens;
  readonly tokens: ContentTokens;
  readonly bootstrap: BootstrapPolicy;
}

export function privateAppRoute(request: Request): boolean {
  const url = new URL(request.url);
  return (
    (request.method === "POST" &&
      (url.pathname === "/api/v1/csrf" || url.pathname === "/api/v1/content-session")) ||
    (request.method === "DELETE" && /^\/api\/v1\/tickets\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname))
  );
}

/** Access/CSRF verification and session registration precede all private ticket routes. */
export async function handlePrivateAppHttp(
  request: Request,
  env: Env,
  epoch: number,
  dependencies: PrivateAppDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash) return problem(404, "not_found");
  const csrfIssue = url.pathname === "/api/v1/csrf" && request.method === "POST";
  const ticketIssue = url.pathname === "/api/v1/content-session" && request.method === "POST";
  const ticketCancel =
    /^\/api\/v1\/tickets\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && request.method === "DELETE";
  if (!csrfIssue && !ticketIssue && !ticketCancel) return problem(404, "not_found");
  let session;
  try {
    session = await loginAccessUser(
      env.DB,
      dependencies.verifier,
      request,
      epoch,
      dependencies.bootstrap,
    );
  } catch (error) {
    return error instanceof AccessAuthenticationError
      ? problem(401, "unauthorized")
      : problem(403, "forbidden");
  }
  if (csrfIssue) {
    try {
      const issued = await dependencies.csrf.issue(env.DB, request, {
        kind: "access",
        credentialId: session.credential_id,
        epoch: session.epoch,
      });
      return Response.json(issued, {
        status: 201,
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return problem(403, "forbidden");
    }
  }
  return handlePrivateContentTicketHttp(
    request,
    env,
    {
      kind: "user",
      user_id: session.user_id,
      credential_id: session.credential_id,
      epoch: session.epoch,
    },
    dependencies.csrf,
    dependencies.tokens,
    session.expires_at,
  );
}
