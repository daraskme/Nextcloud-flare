import { problem } from "@next-cloud-flare/shared/errors";
import { selectedShare } from "../../../shared/src/shares";
import type { Principal } from "../auth/authorize";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import type { ShareSession } from "../services/shareUnlock";
import { streamZipTicket } from "../services/zipRead";
import { issueZipTicket } from "../services/zipTicket";
import { hasEmptyBody } from "./emptyBody";
import { readShareBody } from "./shares";

const PRIVATE = /^\/api\/v1\/(?:nodes\/([A-Za-z0-9_-]{1,128})\/zip|zips\/([A-Za-z0-9_-]{1,128}))$/;
const PUBLIC =
  /^\/api\/v1\/public\/shares\/([A-Za-z0-9_-]{1,128})\/(?:nodes\/([A-Za-z0-9_-]{1,128})\/zip|zips\/([A-Za-z0-9_-]{1,128}))$/;

export function zipRoute(request: Request): boolean {
  const match = PRIVATE.exec(new URL(request.url).pathname);
  return (
    !!match &&
    ((!!match[1] && request.method === "POST") || (!!match[2] && request.method === "GET"))
  );
}
export function publicZipRoute(request: Request): boolean {
  const match = PUBLIC.exec(new URL(request.url).pathname);
  return (
    !!match &&
    ((!!match[2] && request.method === "POST") || (!!match[3] && request.method === "GET"))
  );
}

/** Both routes require current app authentication; ZIP IDs never authorize an anonymous download. */
export async function handleZipHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
  tokens: ContentTokens | undefined,
  credentialExpiresAt: number,
  session?: ShareSession,
): Promise<Response> {
  const url = new URL(request.url),
    match = (session ? PUBLIC : PRIVATE).exec(url.pathname);
  if (
    !match ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    (session
      ? !publicZipRoute(request) ||
        principal.kind !== "link_share" ||
        match[1] !== session.claims.share_id ||
        session.kind !== "link"
      : !zipRoute(request) || principal.kind !== "user")
  )
    return problem(404, "not_found");
  const nodeId = match[session ? 2 : 1],
    ticketId = match[session ? 3 : 2];
  if (ticketId) {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
  } else {
    if (!tokens) return problem(503, "not_ready");
    if (session && request.headers.get("Share-Session") !== session.claims.session_id)
      return problem(412, "precondition_failed");
    try {
      await csrf.verify(
        env.DB,
        request,
        session
          ? {
              kind: "share",
              credentialId: principal.credential_id,
              epoch: principal.epoch,
              shareId: session.claims.share_id,
            }
          : { kind: "access", credentialId: principal.credential_id, epoch: principal.epoch },
      );
    } catch {
      return problem(403, "forbidden");
    }
    try {
      const input = (await readShareBody(request)) as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => key !== "share") ||
        (session && input.share !== undefined)
      )
        return problem(400, "bad_request");
      if (input.share !== undefined && principal.kind === "user")
        principal = { ...principal, selected_share: selectedShare(input.share) };
    } catch {
      return problem(400, "bad_request");
    }
  }
  try {
    if (ticketId) return await streamZipTicket(env, principal, ticketId, request);
    const result = await issueZipTicket(
      env,
      tokens!,
      principal,
      nodeId!,
      Math.min(Date.now() + 600_000, credentialExpiresAt),
    );
    const prefix = session ? `/api/v1/public/shares/${session.claims.share_id}` : "/api/v1";
    return Response.json(
      { ...result, url: `${prefix}/zips/${result.id}` },
      {
        status: 201,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "budget_exceeded") return problem(429, "budget_exceeded");
    if (code === "zip_entry_limit") return problem(413, "payload_too_large");
    if (code === "invalid_zip_manifest") return problem(409, "conflict");
    if (
      [
        "zip_unavailable",
        "zip_snapshot_changed",
        "authorization_denied",
        "budget_authorization_denied",
        "content_ticket_rejected",
      ].includes(code)
    )
      return problem(404, "not_found");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
