import { problem } from "@next-cloud-flare/shared/errors";
import type { PageReadingUpdate } from "../../../shared/src/library";
import { selectedShare } from "../../../shared/src/shares";
import type { Principal } from "../auth/authorize";
import type { CsrfTokens } from "../auth/csrf";
import type { Env } from "../env";
import { MutationUnavailableError } from "../services/accountMutation";
import { ReadingConflict, readArchiveBook, saveReadingState } from "../services/libraryBook";
import { hasEmptyBody } from "./emptyBody";
import { readJsonObject } from "./jsonBody";

const STATE = /^\/api\/v1\/library\/([A-Za-z0-9_-]{1,128})\/reading-state$/;
export const libraryStateRoute = (r: Request) =>
  r.method === "PUT" && STATE.test(new URL(r.url).pathname);
const BOOK = /^\/api\/v1\/library\/([A-Za-z0-9_-]{1,128})$/;
export const libraryReadRoute = (r: Request) =>
  r.method === "GET" &&
  BOOK.test(new URL(r.url).pathname) &&
  !["/api/v1/library/items", "/api/v1/library/roots"].includes(new URL(r.url).pathname);

/** Metadata requires the same live original/output proofs used for page tickets. */
export async function handleLibraryBookHttp(
  request: Request,
  env: Env,
  principal: Principal,
  publicNode?: string,
) {
  const url = new URL(request.url),
    nodeId = publicNode ?? BOOK.exec(url.pathname)?.[1];
  if (
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    !nodeId ||
    !(await hasEmptyBody(request))
  )
    return problem(400, "bad_request");
  const allowed = publicNode ? [] : ["shareId", "shareVersion"];
  if (
    [...url.searchParams.keys()].some(
      (k) => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1,
    )
  )
    return problem(400, "bad_request");
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
    const book = await readArchiveBook(env.DB, principal, nodeId);
    return Response.json(book, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "archive_not_ready")
      return problem(503, "not_ready");
    return problem(404, "not_found");
  }
}

export async function handleReadingStateHttp(
  request: Request,
  env: Env,
  principal: Principal,
  csrf: Pick<CsrfTokens, "verify">,
) {
  const url = new URL(request.url),
    nodeId = STATE.exec(url.pathname)?.[1];
  if (
    request.method !== "PUT" ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    !nodeId ||
    principal.kind !== "user"
  )
    return problem(400, "bad_request");
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
    const body = await readJsonObject(request);
    if (
      Object.keys(body).some(
        (k) =>
          !["blobId", "generator", "indexHash", "page", "previousUpdatedAt", "share"].includes(k),
      )
    )
      return problem(400, "bad_request");
    if (body.share !== undefined)
      principal = { ...principal, selected_share: selectedShare(body.share) };
    const state = await saveReadingState(
      env,
      principal,
      nodeId,
      body as unknown as PageReadingUpdate,
    );
    return Response.json(state, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (
      error instanceof SyntaxError ||
      ["invalid_body", "invalid_share_selection", "invalid_reading_update"].includes(code)
    )
      return problem(400, "bad_request");
    if (error instanceof ReadingConflict) return problem(409, "conflict");
    if (["authorization_denied", "content_not_available"].includes(code))
      return problem(404, "not_found");
    const response = problem(503, "not_ready");
    if (error instanceof MutationUnavailableError) response.headers.set("Retry-After", "1");
    return response;
  }
}
