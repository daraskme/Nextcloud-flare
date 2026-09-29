import { problem } from "@next-cloud-flare/shared/errors";
import { selectedShare } from "../../../shared/src/shares";
import { authorizeNode, type Principal } from "../auth/authorize";
import { primary } from "../db/primary";
import type { Env } from "../env";
import { prepareAuthorizedArchiveRead } from "../services/archiveRead";
import { hasEmptyBody } from "./emptyBody";

const BOOK = /^\/api\/v1\/library\/([A-Za-z0-9_-]{1,128})$/;
export const libraryReadRoute = (r: Request) =>
  r.method === "GET" && BOOK.test(new URL(r.url).pathname);

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
    const spaceId = await primary(env.DB)
      .prepare("SELECT space_id FROM nodes WHERE id=?")
      .bind(nodeId)
      .first<string>("space_id");
    if (!spaceId) return problem(404, "not_found");
    const proof = await authorizeNode(env.DB, principal, {
      operation: "library.read",
      spaceId,
      nodeId,
    });
    const { book } = await prepareAuthorizedArchiveRead(env.DB, proof);
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
