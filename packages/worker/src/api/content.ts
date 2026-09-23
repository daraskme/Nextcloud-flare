import { problem } from "@next-cloud-flare/shared/errors";
import { acceptContentTicket } from "../auth/contentAccept";
import type { ContentTokens } from "../auth/contentTokens";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { streamBudgetedContentBlob } from "../services/blobRead";

const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function cors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function ticketBody(request: Request): Promise<string> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_content_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 4096) throw new Error("invalid_content_request");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "ticket" ||
    typeof (value as { ticket: unknown }).ticket !== "string"
  )
    throw new Error("invalid_content_request");
  return (value as { ticket: string }).ticket;
}

/** The content surface is called only after ControlDO and its D1 mirror admit the epoch. */
export async function handleContentHttp(
  request: Request,
  env: Env,
  tokens: ContentTokens,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.CONTENT_ORIGIN) return problem(404, "not_found");
  if (url.search || url.hash) return problem(404, "not_found");
  const origin = request.headers.get("Origin");
  if (url.pathname === "/session") {
    if (request.method !== "OPTIONS" && request.method !== "POST") return problem(404, "not_found");
    if (origin !== env.APP_ORIGIN) return problem(403, "forbidden");
    if (request.method === "OPTIONS") {
      if (
        request.headers.get("Access-Control-Request-Method") !== "POST" ||
        !/^content-type$/i.test(request.headers.get("Access-Control-Request-Headers") ?? "")
      )
        return problem(403, "forbidden");
      return cors(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
            "Cache-Control": "private, no-store",
          },
        }),
        env.APP_ORIGIN,
      );
    }
    try {
      const ticket = await ticketBody(request);
      const accepted = await acceptContentTicket(env.DB, tokens, ticket);
      return cors(
        Response.json(
          { expiresAt: accepted.expiresAt },
          {
            status: 201,
            headers: {
              "Set-Cookie": accepted.setCookie,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        ),
        env.APP_ORIGIN,
      );
    } catch {
      return cors(problem(400, "bad_request"), env.APP_ORIGIN);
    }
  }
  const match = /^\/c\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || (request.method !== "GET" && request.method !== "HEAD"))
    return problem(404, "not_found");
  const [, nodeId, blobId] = match;
  if (!nodeId || !blobId || !NODE_ID.test(nodeId) || !NODE_ID.test(blobId))
    return problem(404, "not_found");
  if (origin !== null && origin !== env.APP_ORIGIN) return problem(403, "forbidden");
  const reply = (response: Response) =>
    origin === env.APP_ORIGIN ? cors(response, env.APP_ORIGIN) : response;
  try {
    const node = await primary(env.DB)
      .prepare("SELECT space_id AS spaceId FROM nodes WHERE id=? AND current_blob_id=?")
      .bind(nodeId, blobId)
      .first<{ spaceId: string }>();
    if (!node) return reply(problem(404, "not_found"));
    const response = await streamBudgetedContentBlob(
      env.DB,
      env.BLOBS,
      env.BUDGETS,
      tokens,
      request.headers.get("Cookie"),
      node.spaceId,
      nodeId,
      "content",
      request,
    );
    return reply(response);
  } catch (error) {
    if (error instanceof Error && error.message === "budget_exceeded")
      return reply(problem(429, "budget_exceeded"));
    if (error instanceof Error && error.message === "blob_storage_mismatch")
      return reply(problem(503, "not_ready"));
    return reply(problem(404, "not_found"));
  }
}
