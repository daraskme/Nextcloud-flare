import type { Env } from "../../env.js";
import { getContentDescriptor } from "../../services/content.js";
import { galleryGeneratorVersion } from "../../services/gallery.js";
import { enqueueMediaJob } from "../../jobs/media.js";

export type ImageVariant = "sm256" | "md768" | "lg1600";

const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><rect width="640" height="400" fill="#111827"/><path d="M96 304l112-112 72 72 72-72 192 192H96z" fill="#334155"/><circle cx="432" cy="120" r="40" fill="#475569"/></svg>`;

function placeholderResponse(head: boolean): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-NCF-Placeholder": "1",
  });
  headers.set("Content-Length", String(new TextEncoder().encode(placeholder).byteLength));
  return new Response(head ? null : placeholder, { status: 200, headers });
}

export async function serveThumbnail(
  env: Env,
  userId: string,
  nodeId: string,
  variant: ImageVariant,
  head: boolean,
): Promise<Response> {
  const descriptor = await getContentDescriptor(env, nodeId);
  if (descriptor.ownerId !== userId) throw new Error("node_not_found");
  if (descriptor.mime.toLowerCase().startsWith("video/")) return placeholderResponse(head);
  if (
    !descriptor.mime.toLowerCase().startsWith("image/") ||
    descriptor.mime.toLowerCase() === "image/svg+xml"
  ) {
    throw new Error("node_not_found");
  }
  const row = await env.DB.prepare(
    "SELECT r2_key r2Key FROM derivative_results WHERE kind='image-thumbnail' AND blob_id=?1 AND variant=?2 AND generator_version=?3 AND state='published' AND r2_key IS NOT NULL",
  )
    .bind(descriptor.blobId, variant, galleryGeneratorVersion)
    .first<{ r2Key: string }>();
  if (row === null) {
    if (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") {
      await enqueueMediaJob(env, nodeId, variant === "lg1600" ? "lg1600" : "metadata").catch(
        () => undefined,
      );
    }
    return placeholderResponse(head);
  }
  const object = head ? await env.BLOBS.head(row.r2Key) : await env.BLOBS.get(row.r2Key);
  if (object === null) throw new Error("derivative_inconsistent");
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    "Content-Type": "image/webp",
    ETag: `"d-${descriptor.blobId}-${variant}-${galleryGeneratorVersion}"`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(head ? null : (object as R2ObjectBody).body, { headers });
}
