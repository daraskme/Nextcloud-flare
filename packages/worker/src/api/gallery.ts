import { problem } from "@next-cloud-flare/shared/errors";
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
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.hash ||
    !(await hasEmptyBody(request))
  )
    return problem(400, "bad_request");
  if (
    [...url.searchParams.keys()].some(
      (key) => !["recursive", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    return problem(400, "bad_request");
  const recursive = url.searchParams.get("recursive") ?? "0";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !["0", "1"].includes(recursive) ||
    (cursor !== undefined && (!cursor || cursor.length > 4096))
  )
    return problem(400, "bad_request");
  if (!cursors) return problem(503, "not_ready");
  const rootId = PATH.exec(url.pathname)?.[1];
  if (!rootId) return problem(400, "bad_request");
  try {
    return Response.json(
      await listGallery(
        env.DB,
        principal,
        rootId,
        recursive === "1",
        new GalleryCursorTokens(cursors.ring, cursors.now),
        cursor,
      ),
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_gallery_cursor")
      return problem(400, "bad_request");
    return problem(404, "not_found");
  }
}
