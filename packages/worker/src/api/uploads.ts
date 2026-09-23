import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { UploadCapabilities } from "../auth/uploadCapability";
import type { Env } from "../env";
import { abortSingleUpload } from "../services/uploads/abort";
import { accessUpload, uploadStatus } from "../services/uploads/access";
import { completeSingleUpload } from "../services/uploads/complete";
import { writeSingleUpload } from "../services/uploads/content";
import { createSingleUpload } from "../services/uploads/create";

const UPLOAD = /^\/api\/v1\/uploads\/(up_[a-f0-9]{64})(?:\/(content|complete))?$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function uploadRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/uploads") return request.method === "POST";
  const match = UPLOAD.exec(path);
  return (
    !!match &&
    (match[2] === "content"
      ? request.method === "PUT"
      : match[2] === "complete"
        ? request.method === "POST"
        : ["GET", "DELETE"].includes(request.method))
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

export async function handleUploadHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
  capabilities?: UploadCapabilities,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash || !uploadRoute(request))
    return problem(404, "not_found");
  if (principal.kind !== "user") return problem(403, "forbidden");
  if (!capabilities) return problem(503, "not_ready");
  const match = UPLOAD.exec(url.pathname);
  const id = match?.[1];
  const action = match?.[2];
  const capability = request.headers.get("Upload-Capability") ?? "";
  if (request.method !== "GET" && request.headers.get("Origin") !== env.APP_ORIGIN)
    return problem(403, "forbidden");
  // The binary profile uses current Access credentials plus a dedicated capability and exact Origin.
  if (request.method !== "GET" && action !== "content") {
    try {
      await csrf.verify(env.DB, request, {
        kind: "access",
        credentialId: principal.credential_id,
        epoch: principal.epoch,
      });
    } catch {
      return problem(403, "forbidden");
    }
  }
  try {
    if (id && request.method === "GET") {
      const { row } = await accessUpload(env.DB, principal, id, capability, capabilities, false);
      return Response.json(uploadStatus(row), { headers: HEADERS });
    }
    if (id && action === "content") {
      const header = request.headers.get("Content-Length");
      if (header === null) return problem(411, "invalid_length");
      if (!/^(0|[1-9][0-9]{0,8})$/.test(header)) return problem(400, "invalid_length");
      const length = Number(header);
      if (length > 95000000) return problem(413, "payload_too_large");
      const { row, authorized } = await accessUpload(
        env.DB,
        principal,
        id,
        capability,
        capabilities,
      );
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
      return Response.json(
        await writeSingleUpload(env, principal, id, capability, capabilities, body, length),
        { headers: HEADERS },
      );
    }
    const body = await jsonBody(request);
    if (id && request.method === "DELETE") {
      if (Object.keys(body).length) return problem(400, "bad_request");
      return Response.json(
        await abortSingleUpload(env.DB, principal, id, capability, capabilities),
        { headers: HEADERS },
      );
    }
    const key = request.headers.get("Idempotency-Key");
    if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
      return problem(400, "bad_request");
    if (id && action === "complete") {
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
      const outcome = await completeSingleUpload(
        env,
        principal,
        id,
        capability,
        capabilities,
        key,
        tokens,
      );
      if (outcome.kind === "commit_unknown") {
        const response = problem(503, "commit_unknown");
        response.headers.set("Operation-Id", outcome.operationId);
        response.headers.set("Retry-After", "1");
        return response;
      }
      if (outcome.operation.state !== "committed") return problem(409, "conflict");
      return Response.json(outcome.operation, { headers: HEADERS });
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
          ].includes(key),
      ) ||
      typeof body.spaceId !== "string" ||
      typeof body.parentId !== "string" ||
      typeof body.name !== "string" ||
      typeof body.declared_size !== "number" ||
      (body.targetId !== undefined && typeof body.targetId !== "string") ||
      (body.targetRevision !== undefined && typeof body.targetRevision !== "number")
    )
      return problem(400, "bad_request");
    if (body.mode === "multipart") return problem(503, "not_ready");
    if (body.mode !== "single") return problem(400, "bad_request");
    const result = await createSingleUpload(
      env.DB,
      {
        principal,
        requestId: key,
        spaceId: body.spaceId,
        parentId: body.parentId,
        name: body.name,
        declaredSize: body.declared_size,
        ...(typeof body.targetId === "string" ? { targetId: body.targetId } : {}),
        ...(typeof body.targetRevision === "number" ? { targetRevision: body.targetRevision } : {}),
      },
      capabilities,
    );
    return Response.json(result, { status: 201, headers: HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/capability|authorization_denied/.test(message)) return problem(403, "forbidden");
    if (message === "upload_not_found") return problem(404, "not_found");
    if (/quota_exceeded/.test(message)) return problem(507, "insufficient_storage");
    if (message === "dav_locked") return problem(423, "locked");
    if (/payload_too_large/.test(message)) return problem(413, "payload_too_large");
    if (/invalid_|size_mismatch|portable|name_/.test(message)) return problem(400, "bad_request");
    if (/conflict|target_changed|not_receiving|content_pending/.test(message))
      return problem(409, "conflict");
    return problem(503, "not_ready");
  }
}
