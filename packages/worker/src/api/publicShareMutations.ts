import { problem } from "@next-cloud-flare/shared/errors";
import type { Env } from "../env";
import { lookupOperation } from "../jobs/operations";
import { createFolder } from "../services/createFolder";
import { renameNode } from "../services/renameNode";
import type { ShareSession } from "../services/shareUnlock";
import { trashNode } from "../services/trashNode";
import { hasEmptyBody } from "./emptyBody";
import { publicPrincipal } from "./publicShareRead";
import { readShareBody } from "./shares";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export const PUBLIC_OPERATION = /^\/api\/v1\/operations\/(op_[a-f0-9]{64})$/;
export const publicOperationRoute = (request: Request) =>
  request.method === "GET" &&
  PUBLIC_OPERATION.test(new URL(request.url).pathname) &&
  request.headers.has("X-Share-Id");

/** Explicit share selection never falls back to an Access credential or another share cookie. */
export async function publicShareOperation(
  request: Request,
  env: Env,
  session: ShareSession,
  id: string,
) {
  if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
  const operation = await lookupOperation(env.DB, publicPrincipal(session), id);
  return operation ? Response.json(operation, { headers: HEADERS }) : problem(404, "not_found");
}

/** Space, owner and credential come only from the current share session. */
export async function publicShareMutation(
  request: Request,
  env: Env,
  session: ShareSession,
  action: string,
) {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.includes(",") || !/^[\x21-\x7e]{1,200}$/.test(key))
    return problem(400, "bad_request");
  try {
    const body = (await readShareBody(request)) as Record<string, unknown>;
    const folder = action === "nodes";
    const remove = request.method === "DELETE";
    if (
      remove
        ? Object.keys(body).some((k) => k !== "revision") ||
          !Number.isSafeInteger(body.revision) ||
          (body.revision as number) < 1
        : Object.keys(body).some(
            (k) => !(folder ? ["kind", "parentId", "name"] : ["name"]).includes(k),
          ) ||
          typeof body.name !== "string" ||
          (folder &&
            (body.kind !== "folder" ||
              typeof body.parentId !== "string" ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(body.parentId)))
    )
      return problem(400, "bad_request");
    const common = {
      principal: publicPrincipal(session),
      spaceId: session.spaceId,
      idempotencyKey: key,
      name: body.name as string,
      // Anonymous links cannot own or impersonate a DAV lock creator.
      lockTokens: [],
    };
    const outcome = remove
      ? await trashNode(env, {
          principal: common.principal,
          spaceId: common.spaceId,
          requestId: key,
          nodeId: action.slice(6),
          expectedRevision: body.revision as number,
          lockTokens: [],
        })
      : folder
        ? await createFolder(env, { ...common, parentId: body.parentId as string })
        : await renameNode(env, { ...common, nodeId: action.slice(6) });
    if (outcome.kind === "commit_unknown" || outcome.operation.state === "claimed") {
      const response = problem(503, "commit_unknown");
      response.headers.set(
        "Operation-Id",
        outcome.kind === "commit_unknown" ? outcome.operationId : outcome.operation.id,
      );
      response.headers.set("Retry-After", "1");
      return response;
    }
    return Response.json(outcome.operation, {
      status: outcome.operation.state === "committed" ? (folder ? 201 : 200) : 409,
      headers: HEADERS,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (["invalid_share_request", "invalid_name", "name_too_long", "reserved_name"].includes(code))
      return problem(400, "bad_request");
    if (code === "authorization_denied") return problem(404, "not_found");
    if (code === "precondition_failed") return problem(412, "precondition_failed");
    if (code === "dav_delete_too_large") return problem(413, "payload_too_large");
    if (code === "dav_locked") return problem(423, "locked");
    if (["idempotency_conflict", "name_conflict"].includes(code)) return problem(409, "conflict");
    const response = problem(503, "not_ready");
    response.headers.set("Retry-After", "1");
    return response;
  }
}
