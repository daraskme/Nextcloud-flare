import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import { type AccessSession, revokeAccessSession } from "../auth/sessions";
import { primary } from "../db/primary";
import type { Env } from "../env";

interface MeRow {
  id: string;
  email: string;
  role: "member" | "app_admin";
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  spaceId: string;
  rootNodeId: string;
}

export async function handleAccountHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/me" && request.method === "GET") {
    const row = await primary(env.DB)
      .prepare(`SELECT u.id,u.email,u.role,u.quota_bytes AS quotaBytes,
        u.used_bytes AS usedBytes,u.reserved_bytes AS reservedBytes,
        sp.id AS spaceId,sp.root_node_id AS rootNodeId
        FROM credentials c JOIN sessions s ON s.id=c.session_id
        JOIN users u ON u.id=s.user_id JOIN spaces sp ON sp.owner_id=u.id
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=s.epoch AND ctl.maintenance=0
        WHERE c.id=? AND c.kind='access' AND s.kind='access' AND s.epoch=?
          AND s.revoked_at IS NULL AND s.expires_at>strftime('%s','now')*1000
          AND u.disabled_at IS NULL`)
      .bind(session.credential_id, session.epoch)
      .first<MeRow>();
    if (!row || row.id !== session.user_id) return problem(403, "forbidden");
    return Response.json(
      { ...row, epoch: session.epoch, contentOrigin: env.CONTENT_ORIGIN },
      {
        headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      },
    );
  }
  if (path === "/api/v1/auth/logout" && request.method === "POST") {
    try {
      await csrf.verify(env.DB, request, {
        kind: "access",
        credentialId: session.credential_id,
        epoch: session.epoch,
      });
    } catch {
      return problem(403, "forbidden");
    }
    // HTTP adapters can represent a zero-byte POST as a non-null closed stream.
    // Accept only EOF; never trust Content-Length or buffer a logout payload.
    if (request.body) {
      const reader = request.body.getReader();
      try {
        if (!(await reader.read()).done) {
          await reader.cancel();
          return problem(400, "bad_request");
        }
      } catch {
        return problem(400, "bad_request");
      } finally {
        reader.releaseLock();
      }
    }
    await revokeAccessSession(env.DB, session.credential_id, session.epoch);
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${env.APP_ORIGIN}/cdn-cgi/access/logout`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  return problem(404, "not_found");
}
