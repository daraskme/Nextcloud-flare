import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { Env } from "../env";
import { readPrivateEpub } from "../services/library";

const LIBRARY = /^\/api\/v1\/library\/([A-Za-z0-9_-]{1,128})$/;

export function libraryRoute(request: Request): boolean {
  return request.method === "GET" && LIBRARY.test(new URL(request.url).pathname);
}

export async function handleLibraryHttp(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const url = new URL(request.url);
  const match = LIBRARY.exec(url.pathname);
  if (
    !match ||
    request.method !== "GET" ||
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    url.hash ||
    request.body
  )
    return problem(404, "not_found");
  try {
    const publication = await readPrivateEpub(env.DB, env.BLOBS, principal, match[1] ?? "");
    return Response.json(
      {
        ...publication,
        ticketPurpose: "page",
        contentBaseUrl: `${env.CONTENT_ORIGIN}/c/${publication.nodeId}/${publication.blobId}/entries/`,
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    return problem(404, "not_found");
  }
}
