import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { cancelCopyJob, readCopyJob } from "../jobs/copyLifecycle";
import { readJsonObject } from "./jsonBody";

const JOB = /^\/api\/v1\/jobs\/(copy_[a-f0-9]{64})(\/cancel)?$/;
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
  const id = JOB.exec(url.pathname)![1]!;
  const cancel = request.method === "POST";
  if (cancel) {
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
  try {
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
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
