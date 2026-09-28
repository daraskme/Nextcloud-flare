import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { cancelCopyJob, readCopyJob } from "../jobs/copyLifecycle";
import { retryCopyJob } from "../services/retryCopyJob";
import { readJsonObject } from "./jsonBody";

const JOB = /^\/api\/v1\/jobs\/(copy_[a-f0-9]{64})(\/(?:cancel|retry))?$/;
export function copyJobRoute(request: Request): boolean {
  const match = JOB.exec(new URL(request.url).pathname);
  return !!match && request.method === (match[2] ? "POST" : "GET");
}

/** Job IDs are references; the saved actor, credential and both selections authorize each call. */
export async function handleCopyJobHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    principal.kind !== "user" ||
    !copyJobRoute(request)
  )
    return problem(404, "not_found");
  const match = JOB.exec(url.pathname)!,
    id = match[1]!;
  const cancel = match[2] === "/cancel",
    retry = match[2] === "/retry";
  if (cancel || retry) {
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
      if (Object.keys(await readJsonObject(request)).length) throw new Error("invalid_body");
    } catch {
      return problem(400, "bad_request");
    }
  }
  const key = request.headers.get("Idempotency-Key");
  if (retry && (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key)))
    return problem(400, "bad_request");
  try {
    if (retry) {
      const outcome = await retryCopyJob(env, principal, id, key!);
      if (outcome.kind === "commit_unknown" || outcome.operation.state === "claimed") {
        const response = problem(503, "commit_unknown");
        response.headers.set(
          "Operation-Id",
          outcome.kind === "commit_unknown" ? outcome.operationId : outcome.operation.id,
        );
        response.headers.set("Retry-After", "1");
        return response;
      }
      const operation = outcome.operation;
      return Response.json(operation, {
        status: operation.state === "committed" ? 202 : 409,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Operation-Id": operation.id,
          ...(operation.result?.jobId
            ? { Location: `/api/v1/jobs/${operation.result.jobId}` }
            : {}),
        },
      });
    }
    const status = cancel
      ? await cancelCopyJob(env, principal, id)
      : await readCopyJob(env.DB, principal, id);
    return Response.json(status, {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "authorization_denied")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "copy_already_completed")
      return problem(409, "conflict");
    if (error instanceof Error && error.message === "copy_retry_not_stopped")
      return problem(409, "conflict");
    if (error instanceof Error && error.message === "copy_retry_cleanup_pending")
      return problem(409, "copy_retry_cleanup_pending");
    if (error instanceof Error && error.message === "idempotency_conflict")
      return problem(409, "conflict");
    if (error instanceof Error && error.message === "dav_locked") return problem(423, "locked");
    if (error instanceof Error && error.message === "copy_manifest_too_large")
      return problem(413, "payload_too_large");
    if (
      error instanceof Error &&
      ["name_conflict", "copy_source_unavailable", "invalid_copy_overwrite"].includes(error.message)
    )
      return problem(409, "conflict");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
