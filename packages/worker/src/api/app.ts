import { authenticateAccessUser } from "../auth/httpAuth.js";
import { type AppContext, jsonError, mapError } from "./http.js";

export async function handleAppShell(context: AppContext): Promise<Response> {
  try {
    await authenticateAccessUser(context.env, context.req.raw);
  } catch (error) {
    return mapError(context, error);
  }
  const response = await context.env.ASSETS.fetch(
    new Request(`${context.env.APP_ORIGIN}/index.html`, context.req.raw),
  );
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, headers });
}

export async function handleAppAsset(context: AppContext): Promise<Response> {
  const asset = context.req.param("asset");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u.test(asset)) {
    return jsonError(context, 404, "not_found", "Asset not found");
  }
  const response = await context.env.ASSETS.fetch(
    new Request(`${context.env.APP_ORIGIN}/assets/${asset}`, context.req.raw),
  );
  if (!response.ok) return jsonError(context, 404, "not_found", "Asset not found");
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}
