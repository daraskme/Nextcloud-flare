import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import type { AccessSession } from "../auth/sessions";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import {
  type CreateShareGroupInput,
  createShareGroup,
  disableShareGroup,
  listShareGroups,
  readShareGroup,
  type UpdateShareGroupInput,
  updateShareGroup,
} from "../services/groups";
import { hasEmptyBody } from "./emptyBody";

const BASE = "/api/v1/groups";
const DETAIL = /^\/api\/v1\/groups\/([A-Za-z0-9_-]{1,128})$/;
const MAX_BODY = 65_536;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function groupRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (path === BASE && ["GET", "POST"].includes(request.method)) ||
    (DETAIL.test(path) && ["GET", "PATCH", "DELETE"].includes(request.method))
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_group_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_group_request");
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
    throw new Error("invalid_group_request");
  return parsed as Record<string, unknown>;
}

function memberEmails(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((email) => typeof email !== "string"))
    throw new Error("invalid_group_request");
  return value as string[];
}

async function createBody(request: Request): Promise<CreateShareGroupInput> {
  const body = await jsonBody(request);
  if (
    Object.keys(body).some((key) => !["name", "memberEmails"].includes(key)) ||
    typeof body.name !== "string" ||
    body.memberEmails === undefined
  )
    throw new Error("invalid_group_request");
  return { name: body.name, memberEmails: memberEmails(body.memberEmails) };
}

async function updateBody(request: Request): Promise<UpdateShareGroupInput> {
  const body = await jsonBody(request);
  if (
    Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => !["name", "memberEmails"].includes(key)) ||
    (body.name !== undefined && typeof body.name !== "string")
  )
    throw new Error("invalid_group_request");
  return {
    ...(body.name === undefined ? {} : { name: body.name as string }),
    ...(body.memberEmails === undefined ? {} : { memberEmails: memberEmails(body.memberEmails) }),
  };
}

export async function handleGroupHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash) return problem(404, "not_found");
  const detail = DETAIL.exec(url.pathname);
  if (url.pathname === BASE && request.method === "GET") {
    try {
      return Response.json(
        { groups: await listShareGroups(env.DB, session) },
        { headers: PRIVATE_HEADERS },
      );
    } catch {
      return problem(503, "not_ready");
    }
  }
  if (detail && request.method === "GET") {
    try {
      return Response.json(await readShareGroup(env.DB, session, detail[1] ?? ""), {
        headers: PRIVATE_HEADERS,
      });
    } catch {
      return problem(404, "not_found");
    }
  }
  const create = url.pathname === BASE && request.method === "POST";
  const update = detail && request.method === "PATCH";
  const disable = detail && request.method === "DELETE";
  if (!create && !update && !disable) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: session.credential_id,
      epoch: session.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  if (disable) {
    if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    try {
      await disableShareGroup(env, session, detail?.[1] ?? "");
      return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
    } catch (error) {
      if (error instanceof MutationUnavailableError) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return error instanceof Error && error.message === "group_not_found"
        ? problem(404, "not_found")
        : problem(503, "not_ready");
    }
  }
  let body: CreateShareGroupInput | UpdateShareGroupInput;
  try {
    body = create ? await createBody(request) : await updateBody(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    const result = create
      ? await createShareGroup(env, session, body as CreateShareGroupInput)
      : await updateShareGroup(env, session, detail?.[1] ?? "", body);
    return Response.json(result, { status: create ? 201 : 200, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof MutationUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    if (error instanceof Error && error.message === "invalid_group_request")
      return problem(400, "bad_request");
    if (
      error instanceof Error &&
      ["group_member_not_found", "group_not_found"].includes(error.message)
    )
      return problem(404, "not_found");
    if (error instanceof Error && ["group_limit", "group_exists"].includes(error.message))
      return problem(409, "conflict");
    return problem(503, "not_ready");
  }
}
