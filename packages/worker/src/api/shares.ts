import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import { KdfUnavailableError } from "../auth/kdf";
import type { AccessSession } from "../auth/sessions";
import type { SharePasswordPepperRing } from "../auth/sharePassword";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import {
  type CreateInternalShareInput,
  type CreateShareInput,
  createInternalShare,
  createShare,
  disableShare,
  listSharedWithMe,
  listShares,
  type ResharePolicyInput,
  readShare,
  type UpdateInternalShareInput,
  updateInternalShare,
} from "../services/shares";
import { hasEmptyBody } from "./emptyBody";

const BASE = "/api/v1/shares";
const SHARED_WITH_ME = "/api/v1/shared-with-me";
const DETAIL = /^\/api\/v1\/shares\/([A-Za-z0-9_-]{1,128})$/;
const MAX_BODY = 8192;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function shareRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (path === SHARED_WITH_ME && request.method === "GET") ||
    (path === BASE && ["GET", "POST"].includes(request.method)) ||
    (DETAIL.test(path) && ["GET", "PATCH", "DELETE"].includes(request.method))
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_share_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_share_request");
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
    throw new Error("invalid_share_request");
  return parsed as Record<string, unknown>;
}

async function createBody(
  request: Request,
): Promise<CreateShareInput | ({ kind: "internal" } & CreateInternalShareInput)> {
  const body = await jsonBody(request);
  if (body.kind === "internal") {
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "kind",
            "rootNodeId",
            "spaceId",
            "recipientEmail",
            "recipientGroupId",
            "actions",
            "ttlDays",
            "sourceShareId",
            "resharePolicy",
          ].includes(key),
      ) ||
      typeof body.rootNodeId !== "string" ||
      typeof body.spaceId !== "string" ||
      (body.recipientEmail === undefined) === (body.recipientGroupId === undefined) ||
      (body.recipientEmail !== undefined && typeof body.recipientEmail !== "string") ||
      (body.recipientGroupId !== undefined && typeof body.recipientGroupId !== "string") ||
      !Array.isArray(body.actions) ||
      body.actions.some((action) => typeof action !== "string") ||
      (body.ttlDays !== undefined && typeof body.ttlDays !== "number") ||
      (body.sourceShareId !== undefined && typeof body.sourceShareId !== "string")
    )
      throw new Error("invalid_share_request");
    const resharePolicy =
      body.resharePolicy === undefined ? undefined : policyBody(body.resharePolicy);
    return {
      kind: "internal",
      rootNodeId: body.rootNodeId,
      spaceId: body.spaceId,
      ...(body.recipientEmail === undefined
        ? {}
        : { recipientEmail: body.recipientEmail as string }),
      ...(body.recipientGroupId === undefined
        ? {}
        : { recipientGroupId: body.recipientGroupId as string }),
      actions: body.actions as string[],
      ...(body.ttlDays === undefined ? {} : { ttlDays: body.ttlDays as number }),
      ...(body.sourceShareId === undefined ? {} : { sourceShareId: body.sourceShareId as string }),
      ...(resharePolicy === undefined ? {} : { resharePolicy }),
    };
  }
  if (
    Object.keys(body).some(
      (key) =>
        !["rootNodeId", "spaceId", "kind", "ttlDays", "password", "reservationLimitBytes"].includes(
          key,
        ),
    ) ||
    typeof body.rootNodeId !== "string" ||
    typeof body.spaceId !== "string" ||
    (body.kind !== undefined && !["link", "upload_only"].includes(String(body.kind))) ||
    (body.ttlDays !== undefined && typeof body.ttlDays !== "number") ||
    (body.password !== undefined && typeof body.password !== "string") ||
    (body.reservationLimitBytes !== undefined && typeof body.reservationLimitBytes !== "number")
  )
    throw new Error("invalid_share_request");
  return {
    rootNodeId: body.rootNodeId,
    spaceId: body.spaceId,
    ...(body.kind === undefined
      ? {}
      : { kind: body.kind as NonNullable<CreateShareInput["kind"]> }),
    ...(body.ttlDays === undefined ? {} : { ttlDays: body.ttlDays as number }),
    ...(body.password === undefined ? {} : { password: body.password as string }),
    ...(body.reservationLimitBytes === undefined
      ? {}
      : { reservationLimitBytes: body.reservationLimitBytes as number }),
  };
}

function policyBody(value: unknown): ResharePolicyInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_share_request");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) => !["enabled", "actions", "maxDepth", "maxFanout", "ttlDays"].includes(key),
    ) ||
    typeof body.enabled !== "boolean" ||
    !Array.isArray(body.actions) ||
    body.actions.some((action) => typeof action !== "string") ||
    typeof body.maxDepth !== "number" ||
    typeof body.maxFanout !== "number" ||
    (body.ttlDays !== undefined && typeof body.ttlDays !== "number")
  )
    throw new Error("invalid_share_request");
  return {
    enabled: body.enabled,
    actions: body.actions as string[],
    maxDepth: body.maxDepth,
    maxFanout: body.maxFanout,
    ...(body.ttlDays === undefined ? {} : { ttlDays: body.ttlDays as number }),
  };
}

async function updateBody(request: Request): Promise<UpdateInternalShareInput> {
  const body = await jsonBody(request);
  if (
    Object.keys(body).some((key) => !["actions", "resharePolicy"].includes(key)) ||
    (body.actions === undefined && body.resharePolicy === undefined) ||
    (body.actions !== undefined &&
      (!Array.isArray(body.actions) || body.actions.some((action) => typeof action !== "string")))
  )
    throw new Error("invalid_share_request");
  return {
    ...(body.actions === undefined ? {} : { actions: body.actions as string[] }),
    ...(body.resharePolicy === undefined ? {} : { resharePolicy: policyBody(body.resharePolicy) }),
  };
}

export async function handleShareHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
  passwordRing?: SharePasswordPepperRing,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash) return problem(404, "not_found");
  const detail = DETAIL.exec(url.pathname);
  if (url.pathname === SHARED_WITH_ME && request.method === "GET") {
    try {
      return Response.json(
        { shares: await listSharedWithMe(env.DB, session) },
        { headers: PRIVATE_HEADERS },
      );
    } catch {
      return problem(503, "not_ready");
    }
  }
  if (url.pathname === BASE && request.method === "GET") {
    try {
      return Response.json(
        { shares: await listShares(env.DB, session) },
        { headers: PRIVATE_HEADERS },
      );
    } catch {
      return problem(503, "not_ready");
    }
  }
  if (detail && request.method === "GET") {
    try {
      return Response.json(await readShare(env.DB, session, detail[1] ?? ""), {
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
      await disableShare(env, session, detail?.[1] ?? "");
      return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
    } catch (error) {
      if (error instanceof MutationUnavailableError) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      return error instanceof Error && error.message === "share_not_found"
        ? problem(404, "not_found")
        : problem(503, "not_ready");
    }
  }
  if (update) {
    let body: UpdateInternalShareInput;
    try {
      body = await updateBody(request);
    } catch {
      return problem(400, "bad_request");
    }
    try {
      return Response.json(await updateInternalShare(env, session, detail?.[1] ?? "", body), {
        headers: PRIVATE_HEADERS,
      });
    } catch (error) {
      if (error instanceof MutationUnavailableError) {
        const response = problem(503, "not_ready");
        response.headers.set("Retry-After", "1");
        return response;
      }
      if (error instanceof Error && error.message === "invalid_share_request")
        return problem(400, "bad_request");
      if (error instanceof Error && error.message === "share_not_found")
        return problem(404, "not_found");
      if (error instanceof Error && error.message === "share_authority_exceeded")
        return problem(403, "forbidden");
      return problem(503, "not_ready");
    }
  }
  let body: CreateShareInput | ({ kind: "internal" } & CreateInternalShareInput);
  try {
    body = await createBody(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    if ("kind" in body && body.kind === "internal") {
      const idempotencyKey =
        body.sourceShareId === undefined
          ? undefined
          : (request.headers.get("Idempotency-Key") ?? undefined);
      if (body.sourceShareId !== undefined && !idempotencyKey) return problem(400, "bad_request");
      const created = await createInternalShare(env, session, {
        ...body,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      return Response.json(created, { status: 201, headers: PRIVATE_HEADERS });
    }
    const created = await createShare(env, session, body, passwordRing, request.signal);
    return Response.json(
      {
        ...created,
        shareUrl: `${env.APP_ORIGIN}/s/${created.id}#${created.secret}`,
      },
      { status: 201, headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MutationUnavailableError || error instanceof KdfUnavailableError) {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    if (
      error instanceof Error &&
      ["invalid_share_request", "invalid_share_password"].includes(error.message)
    )
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "share_root_not_found")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "share_recipient_not_found")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "share_source_not_found")
      return problem(404, "not_found");
    if (error instanceof Error && error.message === "share_authority_exceeded")
      return problem(403, "forbidden");
    if (error instanceof Error && error.message === "invalid_idempotency_key")
      return problem(400, "bad_request");
    if (error instanceof Error && error.message === "idempotency_conflict")
      return problem(409, "conflict");
    if (error instanceof Error && error.message === "share_limit") return problem(409, "conflict");
    if (error instanceof Error && error.message === "share_exists") return problem(409, "conflict");
    if (error instanceof Error && error.message === "share_password_unavailable") {
      const response = problem(503, "not_ready");
      response.headers.set("Retry-After", "1");
      return response;
    }
    return problem(503, "not_ready");
  }
}
