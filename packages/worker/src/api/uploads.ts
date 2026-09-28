import { problem } from "@next-cloud-flare/shared/errors";
import { selectedShare } from "../../../shared/src/shares";
import { authorizeNode, type Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";
import type { ShareSession } from "../services/shareUnlock";
import { abortMultipartUpload, abortSingleUpload } from "../services/uploads/abort";
import { accessUpload } from "../services/uploads/access";
import { completeSingleUpload } from "../services/uploads/complete";
import { writeSingleUpload } from "../services/uploads/content";
import { createSingleUpload } from "../services/uploads/create";
import { createMultipartUploadReceipt, writeMultipartPart } from "../services/uploads/multipart";
import { completeMultipartUpload } from "../services/uploads/multipartComplete";
import { readUpload } from "../services/uploads/read";
import { hasEmptyBody } from "./emptyBody";
import { readShareBody } from "./shares";

const UPLOAD =
  /^\/api\/v1\/uploads\/(up_[a-f0-9]{64})(?:\/(content|complete|parts\/([1-9][0-9]{0,4})))?$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function uploadRoute(request: Request): boolean {
  return route(new URL(request.url).pathname, request.method);
}
export function publicUploadRoute(request: Request): boolean {
  const match = /^\/api\/v1\/public\/shares\/[A-Za-z0-9_-]{1,128}(\/uploads(?:\/.*)?)$/.exec(
    new URL(request.url).pathname,
  );
  return !!match && route(`/api/v1${match[1]}`, request.method);
}
function route(path: string, method: string): boolean {
  if (path === "/api/v1/uploads") return method === "POST";
  const match = UPLOAD.exec(path);
  return (
    !!match &&
    (match[2] === "content" || match[3] !== undefined
      ? method === "PUT"
      : match[2] === "complete"
        ? method === "POST"
        : ["GET", "DELETE"].includes(method))
  );
}

export function uploadReadRoute(request: Request): boolean {
  return request.method === "GET" && uploadRoute(request);
}

function pageQuery(url: URL) {
  if (!url.search) return undefined;
  if (url.search.length > 64) throw new Error("invalid_upload_page");
  const params = url.searchParams;
  if (
    [...params.keys()].some(
      (key) => !["after", "limit"].includes(key) || params.getAll(key).length !== 1,
    )
  )
    throw new Error("invalid_upload_page");
  const after = params.get("after") ?? "0";
  const limit = params.get("limit") ?? "200";
  if (!/^(0|[1-9][0-9]{0,4})$/.test(after) || !/^[1-9][0-9]{0,2}$/.test(limit))
    throw new Error("invalid_upload_page");
  return { after: Number(after), limit: Number(limit) };
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_upload_body");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(8192);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) {
        await reader.cancel();
        throw new Error("invalid_upload_body");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)),
    );
  } catch {
    throw new Error("invalid_upload_body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_upload_body");
  return value as Record<string, unknown>;
}

export async function handleUploadHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
  capabilities?: UploadCapabilities,
  publicSession?: ShareSession,
): Promise<Response> {
  const url = new URL(request.url);
  if (publicSession) {
    const prefix = `/api/v1/public/shares/${publicSession.claims.share_id}`;
    if (!url.pathname.startsWith(`${prefix}/`) || !publicUploadRoute(request))
      return problem(404, "not_found");
    url.pathname = `/api/v1${url.pathname.slice(prefix.length)}`;
  }
  if (
    url.origin !== env.APP_ORIGIN ||
    (url.search && request.method !== "GET") ||
    url.hash ||
    !route(url.pathname, request.method)
  )
    return problem(404, "not_found");
  if (
    publicSession
      ? principal.kind !== "link_share" ||
        principal.share_id !== publicSession.claims.share_id ||
        principal.share_version !== publicSession.claims.share_version ||
        principal.credential_id !== `ss:${publicSession.claims.session_id}`
      : principal.kind !== "user"
  )
    return problem(403, "forbidden");
  if (!capabilities) return problem(503, "not_ready");
  const match = UPLOAD.exec(url.pathname);
  const id = match?.[1];
  const action = match?.[2];
  const partNumber = match?.[3] === undefined ? undefined : Number(match[3]);
  const binary = action === "content" || partNumber !== undefined;
  const uploadOnly = publicSession?.kind === "upload_only";
  const receipt = (uploadId: string, capability?: string, status = 201) =>
    Response.json(
      {
        receipt_id: uploadId,
        status_url: `/api/v1/public/shares/${publicSession!.claims.share_id}/uploads/${uploadId}`,
      },
      {
        status,
        headers: { ...HEADERS, ...(capability ? { "Upload-Capability": capability } : {}) },
      },
    );
  const progress = <T extends { operationId: string | null; errorCode: string | null }>(
    value: T,
  ) =>
    uploadOnly
      ? { ...value, operationId: null, errorCode: value.errorCode ? "upload_failed" : null }
      : value;
  const capability = request.headers.get("Upload-Capability") ?? "";
  if (request.method !== "GET" && request.headers.get("Origin") !== env.APP_ORIGIN)
    return problem(403, "forbidden");
  // Binary requests use the current authenticated credential, capability and exact Origin.
  if (request.method !== "GET" && !binary) {
    try {
      await csrf.verify(
        env.DB,
        request,
        publicSession
          ? {
              kind: "share",
              credentialId: principal.credential_id,
              epoch: principal.epoch,
              shareId: publicSession.claims.share_id,
            }
          : {
              kind: "access",
              credentialId: principal.credential_id,
              epoch: principal.epoch,
            },
      );
    } catch {
      return problem(403, "forbidden");
    }
  }
  try {
    if (id && request.method === "GET") {
      if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
      return Response.json(
        progress(await readUpload(env.DB, principal, id, capability, capabilities, pageQuery(url))),
        { headers: HEADERS },
      );
    }
    if (id && binary) {
      const header = request.headers.get("Content-Length");
      if (header === null) return problem(411, "invalid_length");
      if (!/^(0|[1-9][0-9]{0,8})$/.test(header)) return problem(400, "invalid_length");
      const length = Number(header);
      if (length > 95000000) return problem(413, "payload_too_large");
      const attemptId = request.headers.get("Upload-Attempt-Id") ?? "";
      if (
        partNumber !== undefined &&
        (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) || partNumber > 10000)
      )
        return problem(400, "bad_request");
      const { row, authorized } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        capabilities,
      );
      if (row.mode !== (partNumber === undefined ? "single" : "multipart"))
        return problem(409, "conflict");
      if (partNumber !== undefined && !["created", "uploading"].includes(row.state))
        return problem(409, "conflict");
      if (row.target_id) {
        const ifMatch = request.headers.get("If-Match");
        if (!ifMatch) return problem(428, "precondition_failed");
        if (
          authorized.operation !== "node.content.write" ||
          ifMatch !== `"b-${authorized.node.current_blob_id}"`
        )
          return problem(412, "precondition_failed");
      }
      const body =
        request.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      if (partNumber !== undefined) {
        const result = await writeMultipartPart(
          env,
          principal,
          id,
          capability,
          capabilities,
          partNumber,
          attemptId,
          body,
          length,
        );
        if (uploadOnly)
          return receipt(id, undefined, result.disposition === "in_flight" ? 202 : 201);
        return Response.json(result, {
          status: result.disposition === "in_flight" ? 202 : 200,
          headers:
            result.disposition === "in_flight" ? { ...HEADERS, "Retry-After": "1" } : HEADERS,
        });
      }
      const result = await writeSingleUpload(
        env,
        principal,
        id,
        capability,
        capabilities,
        body,
        length,
      );
      return uploadOnly ? receipt(id) : Response.json(result, { headers: HEADERS });
    }
    const body = publicSession
      ? ((await readShareBody(request)) as Record<string, unknown>)
      : await jsonBody(request);
    if (id && request.method === "DELETE") {
      if (Object.keys(body).length) return problem(400, "bad_request");
      const { row } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        capabilities,
        false,
        "receipt",
      );
      return Response.json(
        progress(
          await (row.mode === "multipart" ? abortMultipartUpload : abortSingleUpload)(
            env,
            principal,
            id,
            capability,
            capabilities,
          ),
        ),
        { headers: HEADERS, status: row.mode === "multipart" ? 202 : 200 },
      );
    }
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
      return problem(400, "bad_request");
    if (id && action === "complete") {
      if (publicSession && Object.keys(body).length) return problem(400, "bad_request");
      const tokens = body.lockTokens ?? [];
      if (
        Object.keys(body).some((key) => key !== "lockTokens") ||
        !Array.isArray(tokens) ||
        tokens.length > 16 ||
        !tokens.every(
          (token) => typeof token === "string" && token.length > 0 && token.length <= 256,
        )
      )
        return problem(400, "bad_request");
      const { row } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        capabilities,
        false,
        "receipt",
      );
      const outcome = await (row.mode === "multipart"
        ? completeMultipartUpload
        : completeSingleUpload)(env, principal, id, capability, capabilities, key, tokens);
      if (outcome.kind === "commit_unknown") {
        const response = problem(503, "commit_unknown");
        if (!uploadOnly) response.headers.set("Operation-Id", outcome.operationId);
        response.headers.set("Retry-After", "1");
        return response;
      }
      if (uploadOnly) return receipt(id);
      if (outcome.operation.state !== "committed") return problem(409, "conflict");
      return Response.json(outcome.operation, { headers: HEADERS });
    }
    if (publicSession) {
      if (
        Object.keys(body).some(
          (key) =>
            !(
              uploadOnly
                ? ["mode", "name", "declared_size"]
                : ["mode", "parentId", "name", "declared_size", "targetId", "targetRevision"]
            ).includes(key),
        )
      )
        return problem(400, "bad_request");
      body.spaceId = publicSession.spaceId;
      if (uploadOnly) body.parentId = publicSession.rootNodeId;
    }
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "mode",
            "spaceId",
            "parentId",
            "name",
            "declared_size",
            "targetId",
            "targetRevision",
            "share",
          ].includes(key),
      ) ||
      typeof body.spaceId !== "string" ||
      (typeof body.parentId !== "string" &&
        !(
          body.parentId === undefined &&
          (publicSession || "share" in body) &&
          typeof body.targetId === "string"
        )) ||
      typeof body.name !== "string" ||
      typeof body.declared_size !== "number" ||
      (body.targetId !== undefined && typeof body.targetId !== "string") ||
      (body.targetRevision !== undefined && typeof body.targetRevision !== "number")
    )
      return problem(400, "bad_request");
    if (body.mode !== "single" && body.mode !== "multipart") return problem(400, "bad_request");
    if ("share" in body) {
      if (principal.kind !== "user") return problem(400, "bad_request");
      principal = { ...principal, selected_share: selectedShare(body.share) };
    }
    // A directly shared file hides its parent ID. Resolve that operand under the selected grant.
    let parentId = body.parentId as string | undefined;
    if (parentId === undefined) {
      const target = await authorizeNode(env.DB, principal, {
        operation: "node.content.write",
        spaceId: body.spaceId,
        nodeId: body.targetId as string,
      });
      if (target.operation !== "node.content.write") throw new Error("authorization_denied");
      parentId = target.parentId;
    }
    const input = {
      principal,
      requestId: key,
      spaceId: body.spaceId,
      parentId,
      name: body.name,
      declaredSize: body.declared_size,
      ...(typeof body.targetId === "string" ? { targetId: body.targetId } : {}),
      ...(typeof body.targetRevision === "number" ? { targetRevision: body.targetRevision } : {}),
    };
    if (body.mode === "multipart") {
      const result = await createMultipartUploadReceipt(env, input, capabilities);
      if (uploadOnly) return receipt(result.receipt.id, result.receipt.capability);
      return Response.json(result.receipt, {
        status: result.pending ? 202 : 201,
        headers: HEADERS,
      });
    }
    const result = await createSingleUpload(env, input, capabilities);
    if (uploadOnly) return receipt(result.id, result.capability);
    return Response.json(result, { status: 201, headers: HEADERS });
  } catch (error) {
    if (error instanceof Error && error.message === "mutation_unavailable") {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    const message = error instanceof Error ? error.message : "";
    if (/capability|authorization_denied/.test(message)) return problem(403, "forbidden");
    if (message === "upload_not_found") return problem(404, "not_found");
    if (/quota_exceeded/.test(message)) return problem(507, "insufficient_storage");
    if (message === "dav_locked") return problem(423, "locked");
    if (message === "upload_parallel_limit") {
      const response = problem(429, "rate_limited");
      response.headers.set("Retry-After", "1");
      return response;
    }
    if (message === "upload_complete_pending") {
      const response = problem(503, "commit_unknown");
      response.headers.set("Retry-After", "1");
      return response;
    }
    if (/payload_too_large/.test(message)) return problem(413, "payload_too_large");
    if (/invalid_|size_mismatch|portable|name_/.test(message)) return problem(400, "bad_request");
    if (
      /conflict|target_changed|not_receiving|content_pending|not_accepting|not_completable|parts_incomplete|part_busy|part_attempt|complete_in_progress|already_completed|cleanup_started|data_budget|upload_expired/.test(
        message,
      )
    )
      return problem(409, "conflict");
    return problem(503, "not_ready");
  } finally {
    if (binary && request.body && !request.body.locked) {
      try {
        await request.body.cancel();
      } catch {
        /* The client may already have disconnected. */
      }
    }
  }
}
