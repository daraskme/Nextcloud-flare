import { problem } from "@next-cloud-flare/shared/errors";
import { selectedShare } from "../../../shared/src/shares";
import type { Principal } from "../auth/authorize";
import { GalleryCursorTokens } from "../auth/galleryCursor";
import type { NodeCursorTokens } from "../auth/nodeCursor";
import type { Env } from "../env";
import { listGallery } from "../services/gallery";
import { hasEmptyBody } from "./emptyBody";

const PATH = /^\/api\/v1\/nodes\/([A-Za-z0-9_-]{1,128})\/gallery$/;
export const galleryRoute = (request: Request) =>
  request.method === "GET" && PATH.test(new URL(request.url).pathname);

export async function handleGalleryHttp(
  request: Request,
  env: Env,
  principal: Principal,
  cursors?: NodeCursorTokens,
  publicRoot?: string,
) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    !(await hasEmptyBody(request))
  )
    return problem(400, "bad_request");
  const allowed = [
    "recursive",
    "cursor",
    ...(publicRoot ? ["nodeId"] : ["shareId", "shareVersion"]),
  ];
  if (
    [...url.searchParams.keys()].some(
      (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    return problem(400, "bad_request");
  const recursive = url.searchParams.get("recursive") ?? "0",
    cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !["0", "1"].includes(recursive) ||
    (cursor !== undefined && (!cursor || cursor.length > 4096))
  )
    return problem(400, "bad_request");
  if (!cursors) return problem(503, "not_ready");
  try {
    const id = publicRoot
      ? (url.searchParams.get("nodeId") ?? publicRoot)
      : PATH.exec(url.pathname)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return problem(400, "bad_request");
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
    const result = await listGallery(
      env.DB,
      principal,
      id,
      recursive === "1",
      new GalleryCursorTokens(cursors.ring, cursors.now),
      cursor,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ["invalid_gallery_cursor", "invalid_share_selection"].includes(error.message)
    )
      return problem(400, "bad_request");
    return problem(404, "not_found");
  }
}
