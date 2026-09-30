import { problem } from "@next-cloud-flare/shared/errors";
import type { Principal } from "../auth/authorize";
import type { Env } from "../env";
import { readFolderStats } from "../services/stats";

export function statsRoute(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/api/v1/stats";
}

export async function handleStatsHttp(request: Request, env: Env, principal: Principal) {
  const url = new URL(request.url);
  if (!statsRoute(request) || url.origin !== env.APP_ORIGIN || url.hash || request.body)
    return problem(404, "not_found");
  const scopeId = url.searchParams.get("scopeId") ?? undefined;
  if (
    [...url.searchParams.keys()].some((key) => key !== "scopeId") ||
    url.searchParams.getAll("scopeId").length > 1 ||
    (scopeId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId))
  )
    return problem(400, "bad_request");
  try {
    return Response.json(await readFolderStats(env.DB, principal, scopeId), {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return problem(404, "not_found");
  }
}
