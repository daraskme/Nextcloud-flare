import { problem } from "@next-cloud-flare/shared/errors";
import type { Env } from "../env";
import { publicAssets } from "./publicManifest";

const SHARE = /^\/s(?:\/[A-Za-z0-9_-]{1,128})?$/;
const ASSETS = new Set<string>(publicAssets);

export function publicShareAssetRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return ["GET", "HEAD"].includes(request.method) && (SHARE.test(path) || ASSETS.has(path));
}

export async function servePublicShare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== env.APP_ORIGIN || url.search || url.hash || !publicShareAssetRoute(request))
    return problem(404, "not_found");
  const shell = SHARE.test(url.pathname);
  url.pathname = shell ? "/public-share.html" : url.pathname;
  const resource = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  if (!resource.ok) return problem(404, "not_found");
  const headers = new Headers(resource.headers);
  headers.set("Cache-Control", shell ? "public, no-store" : "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  const contentOrigin = new URL(env.CONTENT_ORIGIN);
  if (
    contentOrigin.origin !== env.CONTENT_ORIGIN ||
    contentOrigin.protocol !== "https:" ||
    contentOrigin.origin === env.APP_ORIGIN
  )
    return problem(503, "not_ready");
  headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${contentOrigin.origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  return new Response(request.method === "HEAD" ? null : resource.body, {
    status: resource.status,
    headers,
  });
}
