import { problem } from "@next-cloud-flare/shared/errors";
import type { AudioMetadataUpdate } from "../../../shared/src/audio";
import { selectedShare } from "../../../shared/src/shares";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { AudioMetadataConflict, editAudioMetadata } from "../services/audioMetadata";
import { readJsonObject } from "./jsonBody";

const PATH = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/audio$/;
export const audioMetadataRoute = (r: Request) =>
  r.method === "PATCH" && PATH.test(new URL(r.url).pathname);
export async function handleAudioMetadataHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
) {
  const url = new URL(request.url),
    nodeId = PATH.exec(url.pathname)?.[1];
  if (
    !audioMetadataRoute(request) ||
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
        (k) =>
          !["blobId", "generator", "revision", "title", "artist", "album", "share"].includes(k),
      )
    )
      return problem(400, "bad_request");
    if (body.share !== undefined)
      principal = { ...principal, selected_share: selectedShare(body.share) };
    const outcome = await editAudioMetadata(
      env,
      principal,
      nodeId,
      request.headers.get("Idempotency-Key") ?? "",
      body as unknown as AudioMetadataUpdate,
    );
    if (outcome.kind === "commit_unknown") {
      const response = problem(503, "commit_unknown");
      response.headers.set("Operation-Id", outcome.operationId);
      return response;
    }
    if (outcome.operation.state !== "committed") return problem(409, "conflict");
    return Response.json(outcome.operation.result, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Operation-Id": outcome.operation.id,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      error instanceof SyntaxError ||
      [
        "invalid_audio_metadata",
        "invalid_body",
        "invalid_share_selection",
        "invalid_idempotency_key",
      ].includes(code)
    )
      return problem(400, "bad_request");
    if (
      error instanceof AudioMetadataConflict ||
      ["idempotency_conflict", "lock_intent_conflict"].includes(code)
    )
      return problem(409, "conflict");
    if (code === "authorization_denied") return problem(404, "not_found");
    if (code === "dav_locked") return problem(423, "locked");
    return problem(503, "not_ready");
  }
}
