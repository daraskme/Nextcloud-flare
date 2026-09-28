import { problem } from "@next-cloud-flare/shared/errors";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { prepareContentBlobRead, streamBudgetedBlobPlan } from "../services/blobRead";
import type { ShareSession } from "../services/shareUnlock";
import { hasEmptyBody } from "./emptyBody";
import { publicPrincipal } from "./publicShareRead";

/** The ID selects a D1 grant; it is never a bearer credential without the original share cookie. */
export async function publicShareContent(
  request: Request,
  env: Env,
  session: ShareSession,
  nodeId: string,
): Promise<Response> {
  if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
  const sessionId = request.headers.get("Content-Session");
  if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return problem(400, "bad_request");
  try {
    request.signal.throwIfAborted();
    const principal = publicPrincipal(session);
    const grant = await primary(env.DB)
      .prepare(`SELECT cs.ticket_id AS ticketId FROM content_sessions cs
        JOIN tickets t ON t.id=cs.ticket_id AND t.purpose='content'
        WHERE cs.id=? AND cs.issued_by_credential_id=? AND cs.user_id IS NULL
          AND cs.share_id=? AND cs.share_version=? AND cs.epoch=?
          AND cs.revoked_at IS NULL AND cs.expires_at>strftime('%s','now')*1000
          AND t.cancelled_at IS NULL AND t.expires_at>strftime('%s','now')*1000`)
      .bind(
        sessionId,
        principal.credential_id,
        session.claims.share_id,
        session.claims.share_version,
        session.claims.epoch,
      )
      .first<{ ticketId: string }>();
    if (!grant) return problem(404, "not_found");
    const plan = await prepareContentBlobRead(
      env.DB,
      env.BLOBS,
      principal,
      session.spaceId,
      nodeId,
      { sessionId, ticketId: grant.ticketId, purpose: "content" },
    );
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
