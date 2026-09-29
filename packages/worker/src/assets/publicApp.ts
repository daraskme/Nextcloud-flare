import { problem } from "@next-cloud-flare/shared/errors";
import type { Env } from "../env";
import { publicManifest } from "./publicManifest";

const PAGE = /^\/s\/[A-Za-z0-9_-]{1,128}$/;
const assets = new Map<string, { integrity: string; bytes: number; auth: string }>(
  publicManifest.assets.map((a) => [a.path, a]),
);
export function publicAssetRoute(request: Request) {
  const path = new URL(request.url).pathname;
  return ["GET", "HEAD"].includes(request.method) && (PAGE.test(path) || assets.has(path));
}
async function verifiedBytes(response: Response, record: { bytes: number; integrity: string }) {
  if (response.status !== 200 || !response.body || record.bytes < 1 || record.bytes > 524288)
    throw new Error("public_asset_unavailable");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0,
    done = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        done = true;
        break;
      }
      size += part.value.byteLength;
      if (size > record.bytes) throw new Error("public_asset_unavailable");
      parts.push(part.value);
    }
    if (size !== record.bytes) throw new Error("public_asset_unavailable");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
    if (`sha384-${btoa(String.fromCharCode(...digest))}` !== record.integrity)
      throw new Error("public_asset_unavailable");
    return bytes;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Exact public graph only; verify static bytes before serving them without Access. */
export async function servePublicApp(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!publicAssetRoute(request) || url.origin !== env.APP_ORIGIN || url.search)
    return problem(404, "not_found");
  try {
    const content = new URL(env.CONTENT_ORIGIN);
    if (content.protocol !== "https:" || content.origin !== env.CONTENT_ORIGIN) throw new Error();
    const page = PAGE.test(url.pathname),
      record = page ? publicManifest.page : assets.get(url.pathname)!;
    if (!page && assets.get(url.pathname)?.auth !== "public") throw new Error();
    url.pathname = page ? "/public.html" : url.pathname;
    const bytes = await verifiedBytes(
      await env.ASSETS.fetch(new Request(url, { method: "GET" })),
      record,
    );
    return new Response(request.method === "HEAD" ? null : bytes, {
      headers: {
        "Content-Type": page
          ? "text/html; charset=utf-8"
          : url.pathname.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Cache-Control": page ? "private, no-store" : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: ${content.origin}; media-src 'self' ${content.origin}; connect-src 'self' ${content.origin}; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`,
      },
    });
  } catch {
    return problem(503, "not_ready");
  }
}
