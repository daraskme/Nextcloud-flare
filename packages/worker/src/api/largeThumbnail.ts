import { problem } from "@next-cloud-flare/shared/errors";
import { selectedShare } from "../../../shared/src/shares";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { requestLargeThumbnail } from "../services/requestLargeThumbnail";
import { readJsonObject } from "./jsonBody";

export async function handleLargeThumbnailHttp(
  request: Request,
  env: Env,
  principal: Principal,
  nodeId: string,
  csrf: Pick<CsrfTokens, "verify">,
) {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    !["user", "link_share"].includes(principal.kind)
  )
    return problem(400, "bad_request");
  try {
    await csrf.verify(
      env.DB,
      request,
      principal.kind === "link_share"
        ? {
            kind: "share",
            credentialId: principal.credential_id,
            epoch: principal.epoch,
            shareId: principal.share_id,
          }
        : { kind: "access", credentialId: principal.credential_id, epoch: principal.epoch },
    );
  } catch {
    return problem(403, "forbidden");
  }
  try {
    const body = await readJsonObject(request);
    const key = request.headers.get("Idempotency-Key");
    if (
      Object.keys(body).some((key) => !["blobId", "variant", "share"].includes(key)) ||
      typeof body.blobId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.blobId) ||
      body.variant !== "lg" ||
      !key ||
      !/^[\x21-\x7e]{1,200}$/.test(key)
    )
      return problem(400, "bad_request");
    if (body.share !== undefined) {
      if (principal.kind !== "user") return problem(400, "bad_request");
      principal = { ...principal, selected_share: selectedShare(body.share) };
    }
    const receipt = await requestLargeThumbnail(env, principal, nodeId, body.blobId, key);
    return Response.json(receipt, {
      status: receipt.state === "pending" ? 202 : 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(receipt.state === "pending" ? { "Retry-After": "2" } : {}),
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      error instanceof SyntaxError ||
      [
        "invalid_body",
        "invalid_share_selection",
        "invalid_image_request",
        "invalid_idempotency_key",
      ].includes(code)
    )
      return problem(400, "bad_request");
    if (code === "idempotency_conflict") return problem(409, "conflict");
    if (code === "authorization_denied") return problem(404, "not_found");
    return problem(503, "not_ready");
  }
}
