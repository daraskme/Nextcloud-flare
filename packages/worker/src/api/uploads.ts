import { createUploadBodySchema, LIMITS } from "@ncf/shared";

import { authenticateAccessUser } from "../auth/httpAuth.js";
import { abortUpload } from "../services/uploads/abort.js";
import { completeUpload, getUploadStatus } from "../services/uploads/complete.js";
import { createUpload } from "../services/uploads/create.js";
import { putMultipartPart, putSingleContent } from "../services/uploads/transfer.js";
import { type AppContext, jsonError, mapError } from "./http.js";

function capability(context: AppContext): string | undefined {
  return context.req.header("Upload-Capability");
}

function contentLength(context: AppContext): number | null {
  const header = context.req.header("Content-Length");
  if (header === undefined) return null;
  const length = Number(header);
  return Number.isSafeInteger(length) && length >= 0 && length <= LIMITS.maxRequestBytes
    ? length
    : null;
}

function bodyStream(context: AppContext): ReadableStream<Uint8Array> {
  return (
    context.req.raw.body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    })
  );
}

export async function handleCreateUpload(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    const body = createUploadBodySchema.parse(await context.req.json());
    const upload = await createUpload(context.env, user, {
      parentId: body.parentId,
      ...(body.targetNodeId === undefined ? {} : { targetNodeId: body.targetNodeId }),
      name: body.name,
      declaredSize: body.declaredSize,
      mode: body.mode,
    });
    return context.json(upload, 201);
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleGetUpload(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(
      await getUploadStatus(context.env, user, context.req.param("uploadId"), capability(context)),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleSingleContent(context: AppContext): Promise<Response> {
  try {
    const length = contentLength(context);
    if (length === null)
      return jsonError(context, 411, "length_required", "A valid Content-Length is required");
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(
      await putSingleContent(
        context.env,
        user,
        context.req.param("uploadId"),
        capability(context),
        bodyStream(context),
        length,
      ),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleUploadPart(context: AppContext): Promise<Response> {
  try {
    const length = contentLength(context);
    if (length === null)
      return jsonError(context, 411, "length_required", "A valid Content-Length is required");
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(
      await putMultipartPart(
        context.env,
        user,
        context.req.param("uploadId"),
        capability(context),
        Number(context.req.param("partNumber")),
        bodyStream(context),
        length,
      ),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleCompleteUpload(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    return context.json(
      await completeUpload(context.env, user, context.req.param("uploadId"), capability(context)),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleAbortUpload(context: AppContext): Promise<Response> {
  try {
    const user = await authenticateAccessUser(context.env, context.req.raw);
    await abortUpload(context.env, user, context.req.param("uploadId"), capability(context));
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}
