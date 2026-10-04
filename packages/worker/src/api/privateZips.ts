import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { issueContentTicket } from "../services/contentTicket";
import { admitContentTicketCost } from "./contentTickets";

const ZIP_CREATE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/zip$/;
const ZIP_READ = /^\/api\/v1\/zips\/([A-Za-z0-9_-]{1,128})$/;
const MAX_BODY = 16;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function privateZipRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "POST" && ZIP_CREATE.test(path)) ||
    (request.method === "GET" && ZIP_READ.test(path))
  );
}

async function emptyJsonObject(request: Request): Promise<boolean> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body) return false;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) return false;
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
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    return (
      !!value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length
    );
  } catch {
    return false;
  }
}

function zipIssueFailure(error: unknown): Response {
  if (
    error instanceof Error &&
    ["invalid_idempotency_key", "invalid_content_ticket_request"].includes(error.message)
  )
    return problem(400, "bad_request");
  if (error instanceof Error && error.message === "idempotency_conflict")
    return problem(409, "conflict");
  if (error instanceof Error && error.message === "encrypted_operation_forbidden")
    return problem(409, "conflict");
  if (error instanceof Error && ["zip_entry_limit", "zip_size_limit"].includes(error.message))
    return problem(413, "payload_too_large");
  if (
    error instanceof Error &&
    [
      "invalid_zip_name",
      "zip_path_invalid",
      "zip_path_collision",
      "zip_selection_overlap",
    ].includes(error.message)
  )
    return problem(422, "unsupported_media_type");
  if (
    error instanceof MutationUnavailableError ||
    (error instanceof Error &&
      [
        "blob_storage_mismatch",
        "content_ticket_commit_unknown",
        "content_budget_commit_unknown",
      ].includes(error.message))
  ) {
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
  return problem(404, "not_found");
}

export async function handlePrivateZipHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
  tokens: ContentTokens,
  credentialExpiresAt = Number.MAX_SAFE_INTEGER,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    principal.kind !== "user" ||
    !privateZipRoute(request)
  )
    return problem(404, "not_found");
  const read = request.method === "GET" ? ZIP_READ.exec(url.pathname) : null;
  if (read) {
    const zipId = read[1] ?? "";
    const visible = await primary(env.DB)
      .prepare(`SELECT 1 FROM target_sets ts
        JOIN tickets t ON t.target_set_id=ts.id AND t.credential_id=ts.credential_id
        JOIN budgets b ON b.id=t.budget_id AND b.owner_id=ts.owner_id AND b.epoch=t.epoch
        JOIN credentials c ON c.id=t.credential_id AND c.kind='access'
        JOIN sessions s ON s.id=c.session_id AND s.kind='access'
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=t.epoch AND ctl.maintenance=0
        WHERE ts.id=? AND ts.credential_id=? AND ts.epoch=?
          AND t.purpose='zip' AND t.cancelled_at IS NULL
          AND t.expires_at>strftime('%s','now')*1000
          AND ts.expires_at=t.expires_at
          AND b.user_id=? AND b.share_id IS NULL AND b.state='active'
          AND b.expires_at>strftime('%s','now')*1000
          AND s.user_id=? AND s.epoch=t.epoch AND s.revoked_at IS NULL
          AND s.expires_at>strftime('%s','now')*1000`)
      .bind(zipId, principal.credential_id, principal.epoch, principal.user_id, principal.user_id)
      .first<number>();
    if (visible === null) return problem(404, "not_found");
    return new Response(null, {
      status: 307,
      headers: {
        ...HEADERS,
        Location: `${env.CONTENT_ORIGIN}/z/${encodeURIComponent(zipId)}`,
      },
    });
  }
  const create = ZIP_CREATE.exec(url.pathname);
  if (!create) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: principal.credential_id,
      epoch: principal.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  if (!(await emptyJsonObject(request))) return problem(400, "bad_request");
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey) return problem(400, "bad_request");
  const rateFailure = await admitContentTicketCost(env, principal, 1);
  if (rateFailure) return rateFailure;
  const nodeId = create[1] ?? "";
  const spaceId = await primary(env.DB)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) return problem(404, "not_found");
  try {
    const issued = await issueContentTicket(
      env,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId, nodeId }],
      "zip",
      Math.min(Date.now() + 300_000, credentialExpiresAt),
      undefined,
      { idempotencyKey },
    );
    return Response.json(issued, {
      status: 201,
      headers: {
        ...HEADERS,
        Location: `/api/v1/zips/${encodeURIComponent(issued.targetSetId)}`,
      },
    });
  } catch (error) {
    return zipIssueFailure(error);
  }
}
