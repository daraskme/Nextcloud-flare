import { problem } from "@next-cloud-flare/shared/errors";
import { selectedShare } from "../../../shared/src/shares";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import { LibraryCursorTokens } from "../auth/libraryCursor";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";
import { listLibrary } from "../services/libraryList";
import { listLibraryRoots, updateLibraryRoot } from "../services/libraryRoots";
import { hasEmptyBody } from "./emptyBody";
import { readJsonObject } from "./jsonBody";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const ROOT = /^\/api\/v1\/library\/roots\/([A-Za-z0-9_-]{1,128})$/;
export function libraryShelfRoute(request: Request) {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" && path === "/api/v1/library/items") ||
    (["GET", "POST"].includes(request.method) && path === "/api/v1/library/roots") ||
    (request.method === "DELETE" && ROOT.test(path))
  );
}
export async function handleLibraryListHttp(
  request: Request,
  env: Env,
  principal: Principal,
  cursors?: NodeCursorTokens,
  publicRoot?: string,
) {
  const url = new URL(request.url),
    allowed = ["cursor", ...(publicRoot ? ["nodeId"] : ["scopeRoot", "shareId", "shareVersion"])];
  if (
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    !(await hasEmptyBody(request)) ||
    [...url.searchParams.keys()].some(
      (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    return problem(400, "bad_request");
  const nodeId = publicRoot
      ? (url.searchParams.get("nodeId") ?? publicRoot)
      : url.searchParams.get("scopeRoot"),
    cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !nodeId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId) ||
    (cursor !== undefined && (!cursor || cursor.length > 4096))
  )
    return problem(400, "bad_request");
  if (!cursors) return problem(503, "not_ready");
  try {
    const shareId = url.searchParams.get("shareId"),
      version = url.searchParams.get("shareVersion");
    if (shareId !== null || version !== null) {
      if (principal.kind !== "user" || !shareId || !version || !/^[1-9][0-9]{0,15}$/.test(version))
        return problem(400, "bad_request");
      principal = {
        ...principal,
        selected_share: selectedShare({ id: shareId, version: Number(version) }),
      };
    }
    return Response.json(
      await listLibrary(
        env.DB,
        principal,
        nodeId,
        new LibraryCursorTokens(cursors.ring, cursors.now),
        cursor,
      ),
      { headers: HEADERS },
    );
  } catch (error) {
    return problem(
      error instanceof Error &&
        ["invalid_library_cursor", "invalid_share_selection"].includes(error.message)
        ? 400
        : 404,
      error instanceof Error &&
        ["invalid_library_cursor", "invalid_share_selection"].includes(error.message)
        ? "bad_request"
        : "not_found",
    );
  }
}
export async function handleLibraryRootsHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
) {
  const url = new URL(request.url);
  if (
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    principal.kind !== "user" ||
    !libraryShelfRoute(request)
  )
    return problem(400, "bad_request");
  if (request.method !== "GET") {
    try {
      await csrf.verify(env.DB, request, {
        kind: "access",
        credentialId: principal.credential_id,
        epoch: principal.epoch,
      });
    } catch {
      return problem(403, "forbidden");
    }
  }
  try {
    if (request.method === "GET") {
      if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
      return Response.json(await listLibraryRoots(env.DB, principal), { headers: HEADERS });
    }
    let id = ROOT.exec(url.pathname)?.[1];
    if (request.method === "POST") {
      const body = await readJsonObject(request);
      if (Object.keys(body).join(",") !== "nodeId" || typeof body.nodeId !== "string")
        return problem(400, "bad_request");
      id = body.nodeId;
    } else if (!(await hasEmptyBody(request))) return problem(400, "bad_request");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return problem(400, "bad_request");
    await updateLibraryRoot(env, principal, id, request.method === "POST");
    return Response.json(
      { nodeId: id, registered: request.method === "POST" },
      { headers: HEADERS },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (error instanceof SyntaxError || code === "invalid_body") return problem(400, "bad_request");
    if (code === "authorization_denied") return problem(404, "not_found");
    if (code === "library_roots_limit") return problem(409, "conflict");
    return problem(503, "not_ready");
  }
}
