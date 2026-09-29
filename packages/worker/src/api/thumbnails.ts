import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { prepareContentBlobRead, streamBudgetedBlobPlan } from "../services/blobRead";
import { thumbnailVariant } from "../services/thumbnailManifest";
import { hasEmptyBody } from "./emptyBody";

export function thumbnailRoute(request: Request) {
  return (
    ["GET", "HEAD", "POST"].includes(request.method) &&
    /^\/api\/v1\/nodes\/[A-Za-z0-9_-]{1,128}\/thumb$/.test(new URL(request.url).pathname)
  );
}

/** The session ID selects a grant belonging to the authenticated Access/share credential. */
export async function handleThumbnailHttp(
  request: Request,
  env: Env,
  principal: Principal,
  nodeId: string,
) {
  const reply = await read(request, env, principal, nodeId);
  const headers = new Headers(reply.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (request.method === "HEAD") void reply.body?.cancel().catch(() => undefined);
  return new Response(request.method === "HEAD" ? null : reply.body, {
    status: reply.status,
    headers,
  });
}
async function read(request: Request, env: Env, principal: Principal, nodeId: string) {
  const url = new URL(request.url),
    variant = url.searchParams.get("variant"),
    sessionId = request.headers.get("Content-Session");
  if (
    url.origin !== env.APP_ORIGIN ||
    request.headers.get("Sec-Fetch-Site") !== "same-origin" ||
    (request.headers.has("Origin") && request.headers.get("Origin") !== env.APP_ORIGIN)
  )
    return problem(403, "forbidden");
  if (
    !["GET", "HEAD"].includes(request.method) ||
    url.hash ||
    !(await hasEmptyBody(request)) ||
    [...url.searchParams.keys()].join(",") !== "variant" ||
    !thumbnailVariant(variant) ||
    !sessionId ||
    !/^[A-Za-z0-9_-]{43}$/.test(sessionId)
  )
    return problem(400, "bad_request");
  try {
    const grant = await primary(env.DB)
      .prepare(`SELECT cs.ticket_id AS ticketId,cs.share_id AS shareId,
      cs.share_version AS shareVersion FROM content_sessions cs JOIN tickets t ON t.id=cs.ticket_id
      WHERE cs.id=? AND cs.issued_by_credential_id=? AND t.purpose='thumb'`)
      .bind(sessionId, principal.credential_id)
      .first<{ ticketId: string; shareId: string | null; shareVersion: number | null }>();
    const spaceId = await primary(env.DB)
      .prepare("SELECT space_id FROM nodes WHERE id=?")
      .bind(nodeId)
      .first<string>("space_id");
    if (!grant || !spaceId) return problem(404, "not_found");
    const plan = await prepareContentBlobRead(env.DB, env.BLOBS, principal, spaceId, nodeId, {
      sessionId,
      ticketId: grant.ticketId,
      purpose: "thumb",
      variant,
      ...(principal.kind !== "link_share" && grant.shareId && grant.shareVersion
        ? { share: { id: grant.shareId, version: grant.shareVersion } }
        : {}),
    });
    return await streamBudgetedBlobPlan(env.BLOBS, env.BUDGETS, plan, request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "budget_exceeded") return problem(429, "budget_exceeded");
    if (
      ["authorization_denied", "content_not_available", "budget_authorization_denied"].includes(
        code,
      )
    )
      return problem(404, "not_found");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
