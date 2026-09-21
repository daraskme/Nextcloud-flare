import { createUploadBodySchema, LIMITS } from "@ncf/shared";

import { authenticateShare } from "../auth/share.js";
import {
  abortShareUpload,
  completeShareUpload,
  createShareUpload,
  getShareUploadStatus,
  putShareUpload,
} from "../services/shareUploads.js";
import { type AppContext, jsonError, mapError } from "./http.js";

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

export async function handleCreateShareUpload(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    const body = createUploadBodySchema.parse(await context.req.json());
    return context.json(
      await createShareUpload(context.env, authentication, {
        name: body.name,
        declaredSize: body.declaredSize,
        mode: body.mode,
      }),
      201,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleGetShareUpload(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json(
      await getShareUploadStatus(context.env, authentication, context.req.param("uploadId")),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handlePutShareUpload(context: AppContext): Promise<Response> {
  try {
    const header = context.req.header("Content-Length");
    const size = header === undefined ? Number.NaN : Number(header);
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.maxRequestBytes) {
      return jsonError(context, 411, "length_required", "A valid Content-Length is required");
    }
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json(
      await putShareUpload(
        context.env,
        authentication,
        context.req.param("uploadId"),
        bodyStream(context),
        size,
      ),
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export function handleUnsupportedSharePart(context: AppContext): Response {
  return jsonError(
    context,
    400,
    "multipart_unavailable",
    "Public upload-only links use bounded single uploads",
  );
}

export async function handleCompleteShareUpload(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    return context.json(
      await completeShareUpload(context.env, authentication, context.req.param("uploadId")),
      201,
    );
  } catch (error) {
    return mapError(context, error);
  }
}

export async function handleAbortShareUpload(context: AppContext): Promise<Response> {
  try {
    const authentication = await authenticateShare(
      context.env,
      context.req.raw,
      context.req.param("shareId"),
    );
    await abortShareUpload(context.env, authentication, context.req.param("uploadId"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return mapError(context, error);
  }
}
