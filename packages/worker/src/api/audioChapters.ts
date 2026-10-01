import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import {
  type AudioChapter,
  readAudioChapters,
  writeAudioChapters,
} from "../services/audioChapters";
import { hasEmptyBody } from "./emptyBody";

const ROUTE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/audio-chapters$/;
const MAX_BODY = 128 * 1024;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function audioChaptersRoute(request: Request): boolean {
  return ["GET", "PUT"].includes(request.method) && ROUTE.test(new URL(request.url).pathname);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_audio_chapters");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_audio_chapters");
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("invalid_audio_chapters");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_audio_chapters");
  return parsed as Record<string, unknown>;
}

function input(value: Record<string, unknown>) {
  if (
    Object.keys(value).sort().join(",") !== "blobId,chapters,expectedRevision" ||
    typeof value.blobId !== "string" ||
    typeof value.expectedRevision !== "number" ||
    !Array.isArray(value.chapters)
  )
    throw new Error("invalid_audio_chapters");
  const chapters = value.chapters.map((chapter) => {
    if (!chapter || typeof chapter !== "object" || Array.isArray(chapter))
      throw new Error("invalid_audio_chapters");
    const item = chapter as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !== "id,positionMs,title" ||
      typeof item.id !== "string" ||
      typeof item.positionMs !== "number" ||
      typeof item.title !== "string"
    )
      throw new Error("invalid_audio_chapters");
    return { id: item.id, positionMs: item.positionMs, title: item.title } satisfies AudioChapter;
  });
  return {
    blobId: value.blobId,
    expectedRevision: value.expectedRevision,
    chapters,
  };
}

export async function handleAudioChaptersHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  const matched = ROUTE.exec(url.pathname);
  if (
    !matched ||
    !audioChaptersRoute(request) ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    principal.kind !== "user"
  )
    return problem(404, "not_found");
  const user = {
    kind: "user" as const,
    user_id: principal.user_id,
    credential_id: principal.credential_id,
    epoch: principal.epoch,
  };
  if (request.method === "GET") {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    try {
      return Response.json(await readAudioChapters(env.DB, user, matched[1]!), {
        headers: HEADERS,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "audio_chapters_unavailable")
        return problem(404, "not_found");
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
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
  try {
    const parsed = input(await body(request));
    return Response.json(
      await writeAudioChapters(
        env.DB,
        user,
        matched[1]!,
        parsed.blobId,
        parsed.expectedRevision,
        parsed.chapters,
      ),
      { headers: HEADERS },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_audio_chapters")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "audio_chapters_conflict")
      return problem(409, "conflict");
    if (error instanceof Error && error.message === "audio_chapters_unavailable")
      return problem(404, "not_found");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
