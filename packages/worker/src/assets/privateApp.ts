import { problem } from "@next-cloud-flare/shared/errors";
import { privateAppDependencies } from "../api/privateAppConfig";
import { AccessAuthenticationError } from "../auth/access";
import { loginAccessUser } from "../auth/login";
import type { Env } from "../env";
import { privateAssets } from "./privateManifest";

const assets = new Set<string>(privateAssets);
const pages = /^(?:\/|\/files(?:\/[A-Za-z0-9_-]{1,128})?|\/trash)$/;

export function privateAssetRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return ["GET", "HEAD"].includes(request.method) && (pages.test(path) || assets.has(path));
}

/** Exact private build graph only. Public/service/unknown paths never receive an SPA fallback. */
export async function servePrivateApp(
  request: Request,
  env: Env,
  epoch: number,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || !privateAssetRoute(request))
    return problem(404, "not_found");
  try {
    const { verifier, bootstrap } = await privateAppDependencies(env);
    await loginAccessUser(env.DB, verifier, request, epoch, bootstrap);
  } catch (error) {
    return problem(error instanceof AccessAuthenticationError ? 401 : 403, "unauthorized");
  }
  const page = pages.test(url.pathname);
  url.pathname = page ? "/index.html" : url.pathname;
  url.search = "";
  const resource = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  const headers = new Headers(resource.headers);
  const contentOrigin = new URL(env.CONTENT_ORIGIN);
  if (contentOrigin.protocol !== "https:" || contentOrigin.origin !== env.CONTENT_ORIGIN)
    return problem(503, "not_ready");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${contentOrigin.origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  return new Response(request.method === "HEAD" ? null : resource.body, {
    status: resource.status,
    headers,
  });
}
