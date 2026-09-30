import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import { type ShareSession, sharePrincipal } from "../auth/shareSession";
import type { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { abortMultipartUpload, abortSingleUpload } from "../services/uploads/abort";
import { accessUpload } from "../services/uploads/access";
import { completeSingleUpload } from "../services/uploads/complete";
import { writeSingleUpload } from "../services/uploads/content";
import { createSingleUpload } from "../services/uploads/create";
import { createMultipartUploadReceipt, writeMultipartPart } from "../services/uploads/multipart";
import { completeMultipartUpload } from "../services/uploads/multipartComplete";
import { readUpload } from "../services/uploads/read";

const ID = "[A-Za-z0-9_-]{1,128}";
const UPLOAD_ID = "up_[a-f0-9]{64}";
const CREATE = new RegExp(`^/api/v1/public/shares/(${ID})/uploads$`);
const UPLOAD = new RegExp(
  `^/api/v1/public/shares/(${ID})/uploads/(${UPLOAD_ID})(?:/(content|complete|parts/([1-9][0-9]{0,4})))?$`,
);
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export interface PublicUploadDependencies {
  readonly csrf: Pick<CsrfTokens, "verify">;
  readonly capabilities?: UploadCapabilities;
}

export function publicUploadRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (CREATE.test(path)) return request.method === "POST";
  const match = UPLOAD.exec(path);
  return (
    !!match &&
    (match[3] === "content" || match[4] !== undefined
      ? request.method === "PUT"
      : match[3] === "complete"
        ? request.method === "POST"
        : ["GET", "DELETE"].includes(request.method))
  );
}

function sameOriginMutation(request: Request, origin: string): boolean {
  return (
    request.headers.get("Origin") === origin &&
    request.headers.get("Sec-Fetch-Site") === "same-origin"
  );
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

function receipt(shareId: string, uploadId: string) {
  return {
    receiptId: uploadId,
    statusUrl: `/api/v1/public/shares/${shareId}/uploads/${uploadId}`,
  };
}

function receiptHeaders(upload: {
  capability: string;
  mode: string;
  expiresAt: number;
  partBytes?: number | null;
  partCount?: number | null;
}) {
  return {
    ...HEADERS,
    "Upload-Capability": upload.capability,
    "Upload-Mode": upload.mode,
    "Upload-Expires-At": String(upload.expiresAt),
    ...(upload.partBytes ? { "Upload-Part-Bytes": String(upload.partBytes) } : {}),
    ...(upload.partCount ? { "Upload-Part-Count": String(upload.partCount) } : {}),
  };
}

function publicStatus(shareId: string, status: Awaited<ReturnType<typeof readUpload>>) {
  return {
    ...receipt(shareId, status.id),
    mode: status.mode,
    state: status.state,
    declaredSize: status.declaredSize,
    expiresAt: status.expiresAt,
    cleanupPending: status.cleanupPending,
    errorCode: status.errorCode,
    ...(status.mode === "multipart"
      ? {
          partBytes: status.partBytes,
          partCount: status.partCount,
          revision: status.revision,
          parts: status.parts,
          nextAfter: status.nextAfter,
        }
      : {}),
  };
}

export async function handlePublicUploadHttp(
  request: Request,
  env: Env,
  session: ShareSession,
  dependencies: PublicUploadDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    !publicUploadRoute(request) ||
    session.kind !== "upload_only"
  )
    return problem(404, "not_found");
  if (!dependencies.capabilities) return problem(503, "not_ready");
  const create = CREATE.exec(url.pathname);
  const match = UPLOAD.exec(url.pathname);
  if ((create?.[1] ?? match?.[1]) !== session.shareId) return problem(404, "not_found");
  const id = match?.[2];
  const action = match?.[3];
  const partNumber = match?.[4] === undefined ? undefined : Number(match[4]);
  const binary = action === "content" || partNumber !== undefined;
  if (request.method !== "GET" && !sameOriginMutation(request, env.APP_ORIGIN))
    return problem(403, "forbidden");
  if (request.method !== "GET" && !binary) {
    try {
      await dependencies.csrf.verify(env.DB, request, {
        kind: "share",
        credentialId: session.credentialId,
        epoch: session.epoch,
        shareId: session.shareId,
      });
    } catch {
      return problem(403, "forbidden");
    }
  }
  const principal = sharePrincipal(session);
  const capability = request.headers.get("Upload-Capability") ?? "";
  try {
    if (id && request.method === "GET") {
      return Response.json(
        publicStatus(
          session.shareId,
          await readUpload(
            env.DB,
            principal,
            id,
            capability,
            dependencies.capabilities,
            pageQuery(url),
          ),
        ),
        { headers: HEADERS },
      );
    }
    if (id && binary) {
      if (url.search) return problem(404, "not_found");
      const header = request.headers.get("Content-Length");
      if (header === null) return problem(411, "invalid_length");
      if (!/^(0|[1-9][0-9]{0,8})$/.test(header)) return problem(400, "invalid_length");
      const length = Number(header);
      if (length > 95_000_000) return problem(413, "payload_too_large");
      const attemptId = request.headers.get("Upload-Attempt-Id") ?? "";
      if (
        partNumber !== undefined &&
        (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) || partNumber > 10_000)
      )
        return problem(400, "bad_request");
      const { row } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        dependencies.capabilities,
      );
      if (row.mode !== (partNumber === undefined ? "single" : "multipart"))
        return problem(409, "conflict");
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
          dependencies.capabilities,
          partNumber,
          attemptId,
          body,
          length,
        );
        return Response.json(result, {
          status: result.disposition === "in_flight" ? 202 : 200,
          headers:
            result.disposition === "in_flight" ? { ...HEADERS, "Retry-After": "1" } : HEADERS,
        });
      }
      return Response.json(
        await writeSingleUpload(
          env,
          principal,
          id,
          capability,
          dependencies.capabilities,
          body,
          length,
        ),
        { headers: HEADERS },
      );
    }
    const body = await jsonBody(request);
    if (id && request.method === "DELETE") {
      if (url.search || Object.keys(body).length) return problem(400, "bad_request");
      const { row } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        dependencies.capabilities,
        false,
        "receipt",
      );
      await (row.mode === "multipart" ? abortMultipartUpload : abortSingleUpload)(
        env,
        principal,
        id,
        capability,
        dependencies.capabilities,
      );
      return Response.json(
        {
          ...receipt(session.shareId, id),
          state: row.mode === "multipart" ? "aborting" : "aborted",
        },
        { headers: HEADERS, status: row.mode === "multipart" ? 202 : 200 },
      );
    }
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
      return problem(400, "bad_request");
    if (id && action === "complete") {
      if (url.search || Object.keys(body).length) return problem(400, "bad_request");
      const { row } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        dependencies.capabilities,
        false,
        "receipt",
      );
      const outcome = await (row.mode === "multipart"
        ? completeMultipartUpload
        : completeSingleUpload)(env, principal, id, capability, dependencies.capabilities, key, []);
      if (outcome.kind === "commit_unknown") {
        const response = problem(503, "commit_unknown");
        response.headers.set("Operation-Id", outcome.operationId);
        response.headers.set("Retry-After", "1");
        return response;
      }
      if (outcome.operation.state !== "committed") return problem(409, "conflict");
      return Response.json(
        { ...receipt(session.shareId, id), state: "completed" },
        { status: 201, headers: HEADERS },
      );
    }
    if (
      url.search ||
      Object.keys(body).some((field) => !["mode", "name", "declared_size"].includes(field)) ||
      typeof body.name !== "string" ||
      typeof body.declared_size !== "number" ||
      (body.mode !== "single" && body.mode !== "multipart")
    )
      return problem(400, "bad_request");
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (ip.length > 64) return problem(403, "forbidden");
    let admitted;
    try {
      admitted = await env.EDGE_LIMITER.limit({
        key: `share-upload:${session.shareId}:${ip}`,
      });
    } catch {
      return problem(503, "not_ready");
    }
    if (!admitted.success) {
      const response = problem(429, "rate_limited");
      response.headers.set("Retry-After", "1");
      return response;
    }
    const input = {
      principal,
      requestId: key,
      spaceId: session.spaceId,
      parentId: session.rootNodeId,
      name: body.name,
      declaredSize: body.declared_size,
    };
    if (body.mode === "multipart") {
      const result = await createMultipartUploadReceipt(env, input, dependencies.capabilities);
      return Response.json(receipt(session.shareId, result.receipt.id), {
        status: result.pending ? 202 : 201,
        headers: {
          ...receiptHeaders(result.receipt),
          ...(result.pending ? { "Retry-After": "1" } : {}),
        },
      });
    }
    const result = await createSingleUpload(env, input, dependencies.capabilities);
    return Response.json(receipt(session.shareId, result.id), {
      status: 201,
      headers: receiptHeaders(result),
    });
  } catch (error) {
    if (error instanceof MutationUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    const message = error instanceof Error ? error.message : "";
    if (/capability|authorization_denied/.test(message)) return problem(403, "forbidden");
    if (message === "upload_not_found") return problem(404, "not_found");
    if (/quota_exceeded/.test(message)) return problem(507, "insufficient_storage");
    if (message === "dav_locked") return problem(423, "locked");
    if (/parallel_limit|public_upload_limit/.test(message)) {
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
