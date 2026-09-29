import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import type { AccessSession } from "../auth/sessions";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import {
  type CreateShareInput,
  createShare,
  disableShare,
  listShares,
  readShare,
} from "../services/shares";
import { hasEmptyBody } from "./emptyBody";

const BASE = "/api/v1/shares";
const DETAIL = /^\/api\/v1\/shares\/([A-Za-z0-9_-]{1,128})$/;
const MAX_BODY = 4096;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function shareRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (path === BASE && ["GET", "POST"].includes(request.method)) ||
    (DETAIL.test(path) && ["GET", "DELETE"].includes(request.method))
  );
}

async function createBody(request: Request): Promise<CreateShareInput> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_share_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_share_request");
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
    throw new Error("invalid_share_request");
  const body = parsed as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !["rootNodeId", "spaceId", "ttlDays"].includes(key)) ||
    typeof body.rootNodeId !== "string" ||
    typeof body.spaceId !== "string" ||
    (body.ttlDays !== undefined && typeof body.ttlDays !== "number")
  )
    throw new Error("invalid_share_request");
  return {
    rootNodeId: body.rootNodeId,
    spaceId: body.spaceId,
    ...(body.ttlDays === undefined ? {} : { ttlDays: body.ttlDays as number }),
  };
}

export async function handleShareHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash) return problem(404, "not_found");
  const detail = DETAIL.exec(url.pathname);
  if (url.pathname === BASE && request.method === "GET") {
    try {
      return Response.json(
        { shares: await listShares(env.DB, session) },
        { headers: PRIVATE_HEADERS },
      );
    } catch {
      return problem(503, "not_ready");
    }
  }
  if (detail && request.method === "GET") {
    try {
      return Response.json(await readShare(env.DB, session, detail[1] ?? ""), {
        headers: PRIVATE_HEADERS,
      });
    } catch {
      return problem(404, "not_found");
    }
  }
  const create = url.pathname === BASE && request.method === "POST";
  const disable = detail && request.method === "DELETE";
  if (!create && !disable) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  if (disable) {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    try {
      await disableShare(env, session, detail?.[1] ?? "");
      return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
    } catch (error) {
      if (error instanceof MutationUnavailableError) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return error instanceof Error && error.message === "share_not_found"
        ? problem(404, "not_found")
        : problem(503, "not_ready");
    }
  }
  let body: CreateShareInput;
  try {
    body = await createBody(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    const created = await createShare(env, session, body);
    return Response.json(
      {
        ...created,
        shareUrl: `${env.APP_ORIGIN}/s/${created.id}#${created.secret}`,
      },
      { status: 201, headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MutationUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    if (error instanceof Error && error.message === "invalid_share_request")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "share_root_not_found")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "share_limit") return problem(409, "conflict");
    return problem(503, "not_ready");
  }
}
