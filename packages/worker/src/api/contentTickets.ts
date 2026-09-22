import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { ContentTokens } from "../auth/contentTokens";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { type ContentTicketTarget, issueContentTicket } from "../services/contentTicket";
import { cancelContentTicket } from "../services/contentTicketCancel";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PURPOSES = new Set(["content", "thumb", "page", "zip", "track"]);
const MAX_BODY = 524_288;

async function readRequest(request: Request): Promise<{
  targets: ContentTicketTarget[];
  purpose: "content" | "thumb" | "page" | "zip" | "track";
  ttlSeconds: number;
  share?: { id: string; version: number };
}> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_ticket_body");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_ticket_body");
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_ticket_body");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !["targets", "purpose", "ttlSeconds", "share"].includes(key)) ||
    !Array.isArray(body.targets) ||
    body.targets.length < 1 ||
    body.targets.length > 1_000 ||
    typeof body.purpose !== "string" ||
    !PURPOSES.has(body.purpose) ||
    !Number.isSafeInteger(body.ttlSeconds) ||
    (body.ttlSeconds as number) < 1 ||
    (body.ttlSeconds as number) > 600
  )
    throw new Error("invalid_ticket_body");
  const targets = body.targets.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("invalid_ticket_body");
    const target = entry as Record<string, unknown>;
    if (
      Object.keys(target).sort().join(",") !== "nodeId,spaceId" ||
      typeof target.nodeId !== "string" ||
      !ID.test(target.nodeId) ||
      typeof target.spaceId !== "string" ||
      !ID.test(target.spaceId)
    )
      throw new Error("invalid_ticket_body");
    return { nodeId: target.nodeId, spaceId: target.spaceId };
  });
  let share: { id: string; version: number } | undefined;
  if (body.share !== undefined) {
    if (!body.share || typeof body.share !== "object" || Array.isArray(body.share))
      throw new Error("invalid_ticket_body");
    const selected = body.share as Record<string, unknown>;
    if (
      Object.keys(selected).sort().join(",") !== "id,version" ||
      typeof selected.id !== "string" ||
      !ID.test(selected.id) ||
      !Number.isSafeInteger(selected.version) ||
      (selected.version as number) < 1
    )
      throw new Error("invalid_ticket_body");
    share = { id: selected.id, version: selected.version as number };
  }
  return {
    targets,
    purpose: body.purpose as "content" | "thumb" | "page" | "zip" | "track",
    ttlSeconds: body.ttlSeconds as number,
    ...(share ? { share } : {}),
  };
}

/** Private content ticket routes; caller must first verify Access and admit the current epoch. */
export async function handlePrivateContentTicketHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
  tokens: ContentTokens,
  credentialExpiresAt = Number.MAX_SAFE_INTEGER,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash || principal.kind !== "user")
    return problem(404, "not_found");
  const create = url.pathname === "/api/v1/content-session" && request.method === "POST";
  const cancel = /^\/api\/v1\/tickets\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
  if (!create && !(cancel && request.method === "DELETE")) return problem(404, "not_found");
  try {
    await csrf.verify(env.DB, request, {
      kind: "access",
      credentialId: principal.credential_id,
      epoch: principal.epoch,
    });
  } catch {
    return problem(403, "forbidden");
  }
  if (cancel) {
    if (request.body) return problem(400, "bad_request");
    try {
      await cancelContentTicket(env.DB, principal, cancel[1] ?? "");
      return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof Error && error.message === "ticket_cancel_commit_unknown")
        return problem(503, "not_ready");
      return problem(404, "not_found");
    }
  }
  let body: Awaited<ReturnType<typeof readRequest>>;
  try {
    body = await readRequest(request);
  } catch {
    return problem(400, "bad_request");
  }
  try {
    const issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      body.targets,
      body.purpose,
      Math.min(Date.now() + body.ttlSeconds * 1000, credentialExpiresAt),
      body.share,
    );
    return Response.json(issued, {
      status: 201,
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "content_ticket_commit_unknown")
      return problem(503, "not_ready");
    return problem(404, "not_found");
  }
}
