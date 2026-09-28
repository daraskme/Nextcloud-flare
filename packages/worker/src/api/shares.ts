import { problem } from "@next-cloud-flare/shared/errors";
import type { CsrfTokens } from "../auth/csrf";
import type { ListCursorTokens } from "../auth/listCursor";
import type { AccessSession } from "../auth/sessions";
import type { SharePasswordRing } from "../auth/shareSecrets";
import type { Env } from "../env";
import { listInternalShares, readInternalShare } from "../services/internalShareRead";
import { createInternalShare, updateInternalShare } from "../services/internalShares";
import { listLinkShares, readLinkShare, readUploadOnlyShare } from "../services/linkShareRead";
import { createLinkShare, updateLinkShare } from "../services/linkShares";
import { hasEmptyBody } from "./emptyBody";

const DETAIL = /^\/api\/v1\/shares\/([A-Za-z0-9_-]{1,128})$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export function shareRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (path === "/api/v1/shares" && ["GET", "POST"].includes(request.method)) ||
    (path === "/api/v1/shared-with-me" && request.method === "GET") ||
    (DETAIL.test(path) && ["GET", "PATCH", "DELETE"].includes(request.method))
  );
}
export async function readShareBody(request: Request, maxBytes = 8192): Promise<unknown> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_share_request");
  const reader = request.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0,
    done = false;
  const stop = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const abort = () => rejectStop(new Error("invalid_share_request"));
  stop.addEventListener("abort", abort, { once: true });
  try {
    stop.throwIfAborted();
    for (let n = 0; n < 256; n++) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) {
        done = true;
        break;
      }
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("invalid_share_request");
      parts.push(part.value);
    }
    if (!done) throw new Error("invalid_share_request");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid_share_request");
    return parsed;
  } catch {
    throw new Error("invalid_share_request");
  } finally {
    stop.removeEventListener("abort", abort);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function handleShareHttp(
  request: Request,
  env: Env,
  session: AccessSession,
  csrf: Pick<CsrfTokens, "verify">,
  tokens?: ListCursorTokens,
  passwords?: SharePasswordRing,
): Promise<Response> {
  const url = new URL(request.url),
    match = DETAIL.exec(url.pathname);
  if (!shareRoute(request) || url.origin !== env.APP_ORIGIN || url.hash)
    return problem(404, "not_found");
  try {
    if (request.method === "GET") {
      if (!(await hasEmptyBody(request))) throw new Error("invalid_share_request");
      if (match) {
        if (url.search) throw new Error("invalid_share_request");
        const share = await readInternalShare(env.DB, session, match[1]!, true).catch((error) => {
          if (!(error instanceof Error) || error.message !== "share_unavailable") throw error;
          return readLinkShare(env.DB, session, match[1]!).catch((error) => {
            if (!(error instanceof Error) || error.message !== "share_unavailable") throw error;
            return readUploadOnlyShare(env.DB, session, match[1]!);
          });
        });
        return Response.json(share, { headers: { ...HEADERS, ETag: `"share-${share.version}"` } });
      }
      const received = url.pathname === "/api/v1/shared-with-me";
      const kind = url.searchParams.get("kind");
      if (kind !== null && (received || !["link", "internal", "upload_only"].includes(kind)))
        throw new Error("invalid_share_request");
      if (
        [...url.searchParams.keys()].some(
          (key) => !["cursor", ...(received ? [] : ["rootNodeId", "kind"])].includes(key),
        ) ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
      )
        throw new Error("invalid_share_request");
      const cursor = url.searchParams.get("cursor") ?? undefined,
        rootNodeId = url.searchParams.get("rootNodeId") ?? undefined;
      if (cursor !== undefined && (!cursor || cursor.length > 4096))
        throw new Error("invalid_list_cursor");
      if (!tokens) return problem(503, "not_ready");
      return Response.json(
        kind === "link" || kind === "upload_only"
          ? await listLinkShares(
              env.DB,
              session,
              tokens,
              {
                ...(rootNodeId === undefined ? {} : { rootNodeId }),
                ...(cursor === undefined ? {} : { cursor }),
              },
              kind,
            )
          : await listInternalShares(env.DB, session, tokens, {
              received,
              ...(rootNodeId === undefined ? {} : { rootNodeId }),
              ...(cursor === undefined ? {} : { cursor }),
            }),
        { headers: HEADERS },
      );
    }
    if (url.search) throw new Error("invalid_share_request");
    try {
      await csrf.verify(env.DB, request, {
        kind: "access",
        credentialId: session.credential_id,
        epoch: session.epoch,
      });
    } catch {
      return problem(403, "forbidden");
    }
    if (!match) {
      const input = await readShareBody(request);
      const saved = ["link", "upload_only"].includes((input as { kind?: unknown }).kind as string)
        ? await createLinkShare(env, session, input, passwords, request.signal)
        : await createInternalShare(env, session, input);
      return Response.json(saved, {
        status: 201,
        headers: { ...HEADERS, Location: `/api/v1/shares/${saved.id}`, ETag: '"share-1"' },
      });
    }
    const version = /^"share-([1-9][0-9]{0,15})"$/.exec(request.headers.get("If-Match") ?? "");
    if (!version) return problem(428, "precondition_required");
    let value: unknown | null;
    if (request.method === "DELETE") {
      if (!(await hasEmptyBody(request))) throw new Error("invalid_share_request");
      value = null;
    } else value = await readShareBody(request);
    const kind =
      value === null
        ? await env.DB.prepare("SELECT kind FROM shares WHERE id=? AND owner_id=?")
            .bind(match[1]!, session.user_id)
            .first<string>("kind")
        : (value as { kind?: unknown }).kind;
    const saved =
      kind === "link" || kind === "upload_only"
        ? await updateLinkShare(
            env,
            session,
            match[1]!,
            Number(version[1]),
            value,
            passwords,
            request.signal,
          )
        : await updateInternalShare(env, session, match[1]!, Number(version[1]), value);
    return Response.json(saved, { headers: { ...HEADERS, ETag: `"share-${saved.version}"` } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      code === "invalid_share_request" ||
      code === "invalid_list_cursor" ||
      error instanceof SyntaxError
    )
      return problem(400, "bad_request");
    if (code === "share_recipient_unavailable") return problem(400, "share_recipient_unavailable");
    if (code === "share_unavailable" || code === "authorization_denied")
      return problem(404, "not_found");
    if (code === "share_version_conflict") return problem(412, "precondition_failed");
    return problem(503, "not_ready");
  }
}
