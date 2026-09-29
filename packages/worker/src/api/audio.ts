import { problem } from "@next-cloud-flare/shared/errors";
import type { PlaybackUpdate } from "../../../shared/src/audio";
import { selectedShare } from "../../../shared/src/shares";
import { AudioCursorTokens } from "../auth/audioCursor";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { listAudio, PlaybackConflict, savePlayback } from "../services/audio";
import { hasEmptyBody } from "./emptyBody";
import { readJsonObject } from "./jsonBody";

const TRACKS = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/tracks$/;
const STATE = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/playback-state$/;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export const audioReadRoute = (r: Request) =>
  r.method === "GET" && TRACKS.test(new URL(r.url).pathname);
export const playbackRoute = (r: Request) =>
  r.method === "PUT" && STATE.test(new URL(r.url).pathname);

export async function handleAudioListHttp(
  request: Request,
  env: Env,
  principal: Principal,
  cursors?: NodeCursorTokens,
  publicRoot?: string,
) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    !(await hasEmptyBody(request))
  )
    return problem(400, "bad_request");
  const allowed = ["cursor", ...(publicRoot ? ["nodeId"] : ["shareId", "shareVersion"])];
  if (
    [...url.searchParams.keys()].some(
      (k) => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1,
    )
  )
    return problem(400, "bad_request");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (!cursor || cursor.length > 4096)) return problem(400, "bad_request");
  if (!cursors) return problem(503, "not_ready");
  try {
    const nodeId = publicRoot
      ? (url.searchParams.get("nodeId") ?? publicRoot)
      : TRACKS.exec(url.pathname)?.[1];
    if (!nodeId || !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId)) return problem(400, "bad_request");
    const shareId = url.searchParams.get("shareId"),
      version = url.searchParams.get("shareVersion");
    if (shareId !== null || version !== null) {
      if (principal.kind !== "user" || !shareId || !version || !/^[1-9][0-9]{0,15}$/.test(version))
        return problem(400, "bad_request");
      principal = {
        ...principal,
        selected_share: selectedShare({ id: shareId, version: Number(version) }),
      };
    }
    return Response.json(
      await listAudio(
        env.DB,
        principal,
        nodeId,
        new AudioCursorTokens(cursors.ring, cursors.now),
        cursor,
      ),
      { headers: HEADERS },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["invalid_audio_cursor", "invalid_share_selection"].includes(error.message)
    )
      return problem(400, "bad_request");
    return problem(404, "not_found");
  }
}

export async function handlePlaybackHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
) {
  const url = new URL(request.url),
    nodeId = STATE.exec(url.pathname)?.[1];
  if (
    request.method !== "PUT" ||
    !nodeId ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    principal.kind !== "user"
  )
    return problem(400, "bad_request");
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
    const body = await readJsonObject(request);
    if (
      Object.keys(body).some(
        (k) => !["blobId", "generator", "positionMs", "previousUpdatedAt", "share"].includes(k),
      )
    )
      return problem(400, "bad_request");
    if (body.share !== undefined)
      principal = { ...principal, selected_share: selectedShare(body.share) };
    const result = await savePlayback(env, principal, nodeId, body as unknown as PlaybackUpdate);
    return Response.json(result, { headers: HEADERS });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      error instanceof SyntaxError ||
      ["invalid_body", "invalid_share_selection", "invalid_playback_update"].includes(code)
    )
      return problem(400, "bad_request");
    if (error instanceof PlaybackConflict) return problem(409, "conflict");
    if (code === "authorization_denied") return problem(404, "not_found");
    const response = problem(503, "not_ready");
    if (error instanceof MutationUnavailableError) response.headers.set("Retry-After", "1");
    return response;
  }
}
