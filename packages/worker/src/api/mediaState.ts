import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import {
  readPlaybackState,
  readReadingState,
  writePlaybackState,
  writeReadingState,
} from "../services/mediaState";
import { hasEmptyBody } from "./emptyBody";

const PLAYBACK = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/playback-state$/;
const READING = /^\/api\/v1\/library\/([A-Za-z0-9_-]{1,128})\/reading-state$/;
const MAX_BODY = 1024;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function mediaStateRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return ["GET", "PUT"].includes(request.method) && (PLAYBACK.test(path) || READING.test(path));
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_media_state");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_media_state");
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
    throw new Error("invalid_media_state");
  return parsed as Record<string, unknown>;
}

function playbackBody(value: Record<string, unknown>) {
  if (
    Object.keys(value).sort().join(",") !== "blobId,positionMs" ||
    typeof value.blobId !== "string" ||
    typeof value.positionMs !== "number"
  )
    throw new Error("invalid_media_state");
  return { blobId: value.blobId, positionMs: value.positionMs };
}

function readingBody(value: Record<string, unknown>) {
  if (
    Object.keys(value).sort().join(",") !== "blobId,progress,spineIndex" ||
    typeof value.blobId !== "string" ||
    typeof value.spineIndex !== "number" ||
    typeof value.progress !== "number"
  )
    throw new Error("invalid_media_state");
  return {
    blobId: value.blobId,
    position: { spineIndex: value.spineIndex, progress: value.progress },
  };
}

export async function handleMediaStateHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  const playback = PLAYBACK.exec(url.pathname);
  const reading = READING.exec(url.pathname);
  if (
    !mediaStateRoute(request) ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    (!playback && !reading)
  )
    return problem(404, "not_found");
  if (principal.kind !== "user") return problem(404, "not_found");
  const user = {
    kind: "user" as const,
    user_id: principal.user_id,
    credential_id: principal.credential_id,
    epoch: principal.epoch,
  };
  const nodeId = playback?.[1] ?? reading?.[1] ?? "";
  if (request.method === "GET") {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    try {
      return Response.json(
        playback
          ? await readPlaybackState(env.DB, user, nodeId)
          : await readReadingState(env.DB, user, nodeId),
        { headers: HEADERS },
      );
    } catch {
      return problem(404, "not_found");
    }
  }
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: principal.credential_id,
      epoch: principal.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = await body(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    return Response.json(
      playback
        ? await (() => {
            const input = playbackBody(parsed);
            return writePlaybackState(env.DB, user, nodeId, input.blobId, input.positionMs);
          })()
        : await (() => {
            const input = readingBody(parsed);
            return writeReadingState(env.DB, user, nodeId, input.blobId, input.position);
          })(),
      { headers: HEADERS },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_media_state")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "media_state_unavailable")
      return problem(404, "not_found");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
