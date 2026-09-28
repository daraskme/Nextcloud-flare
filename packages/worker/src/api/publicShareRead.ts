import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { ContentTokens } from "../auth/contentTokens";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";
import { issueContentTicket } from "../services/contentTicket";
import { cancelContentTicket } from "../services/contentTicketCancel";
import { listNodeChildren, readNode } from "../services/nodeRead";
import type { ShareSession } from "../services/shareUnlock";
import { hasEmptyBody } from "./emptyBody";
import { readShareBody } from "./shares";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export const publicPrincipal = (session: ShareSession): Principal => ({
  kind: "link_share",
  share_id: session.claims.share_id,
  share_version: session.claims.share_version,
  credential_id: `ss:${session.claims.session_id}`,
  epoch: session.claims.epoch,
});

export async function publicShareRead(
  request: Request,
  env: Env,
  session: ShareSession,
  suffix: string,
  cursors?: NodeCursorTokens,
) {
  const url = new URL(request.url),
    principal = publicPrincipal(session);
  if (!(await hasEmptyBody(request)) || url.hash) return problem(400, "bad_request");
  const child = /^children\/([A-Za-z0-9_-]{1,128})$/.exec(suffix);
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "cursor" || !child || url.searchParams.getAll(key).length !== 1,
    )
  )
    return problem(400, "bad_request");
  try {
    if (child) {
      if (!cursors) return problem(503, "not_ready");
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096))
        return problem(400, "bad_request");
      return Response.json(await listNodeChildren(env.DB, principal, child[1]!, cursors, cursor), {
        headers: HEADERS,
      });
    }
    const {
      ownerId: _owner,
      spaceId: _space,
      ...root
    } = await readNode(env.DB, principal, session.rootNodeId);
    return Response.json(
      {
        id: session.claims.share_id,
        version: session.claims.share_version,
        sessionId: session.claims.session_id,
        permissions: session.permissions,
        expiresAt: session.claims.exp * 1000,
        root,
        contentOrigin: env.CONTENT_ORIGIN,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "invalid_node_cursor") return problem(400, "bad_request");
    if (["node_unavailable", "node_not_folder", "authorization_denied"].includes(code))
      return problem(404, "not_found");
    return problem(503, "not_ready");
  }
}

/** Infer space and share from the authenticated cookie; the client selects only node IDs. */
export async function publicShareTicket(
  request: Request,
  env: Env,
  session: ShareSession,
  ticketId: string | undefined,
  tokens?: ContentTokens,
) {
  if (!tokens) return problem(503, "not_ready");
  try {
    if (ticketId) {
      if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
      await cancelContentTicket(env, publicPrincipal(session), ticketId);
      return new Response(null, { status: 204, headers: HEADERS });
    }
    const input = (await readShareBody(request, 262144)) as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["nodeIds", "ttlSeconds"].includes(key)) ||
      !Array.isArray(input.nodeIds) ||
      input.nodeIds.length < 1 ||
      input.nodeIds.length > 1000 ||
      input.nodeIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      new Set(input.nodeIds).size !== input.nodeIds.length ||
      !Number.isSafeInteger(input.ttlSeconds) ||
      (input.ttlSeconds as number) < 1 ||
      (input.ttlSeconds as number) > 600
    )
      return problem(400, "bad_request");
    const issued = await issueContentTicket(
      env,
      env.BLOBS,
      tokens,
      publicPrincipal(session),
      input.nodeIds.map((nodeId) => ({ nodeId, spaceId: session.spaceId })),
      "content",
      Math.min(Date.now() + (input.ttlSeconds as number) * 1000, session.claims.exp * 1000),
    );
    return Response.json(issued, { status: 201, headers: HEADERS });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "invalid_share_request") return problem(400, "bad_request");
    if (
      [
        "invalid_ticket_cancel_request",
        "authorization_denied",
        "content_ticket_target_unavailable",
        "content_ticket_blob_unavailable",
      ].includes(code)
    )
      return problem(404, "not_found");
    return problem(503, "not_ready");
  }
}
