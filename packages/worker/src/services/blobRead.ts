import { parseRange } from "../platform/range";

/** The caller must check node, blob, purpose, session and budget before constructing this plan. */
export interface BlobReadPlan {
  readonly key: string;
  readonly size: number;
  readonly r2Etag: string;
  readonly contentEtag: string;
  readonly mime: string;
  readonly name: string;
}

function validate(plan: BlobReadPlan, request: Request): void {
  if (
    !["GET", "HEAD"].includes(request.method) ||
    !/^u\/[A-Za-z0-9_-]{1,128}\/b\/[A-Za-z0-9_-]{1,128}$/.test(plan.key) ||
    plan.key.length > 1024 ||
    !Number.isSafeInteger(plan.size) ||
    plan.size < 0 ||
    !plan.r2Etag ||
    plan.r2Etag.length > 256 ||
    !/^"[A-Za-z0-9._:-]{1,200}"$/.test(plan.contentEtag) ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(plan.mime) ||
    !plan.name ||
    new TextEncoder().encode(plan.name).byteLength > 255
  )
    throw new Error("invalid_blob_read");
}

function ifNoneMatch(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}

function safeInline(mime: string): boolean {
  return (
    (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf"
  );
}

function responseHeaders(plan: BlobReadPlan): Headers {
  const disposition = safeInline(plan.mime) ? "inline" : "attachment";
  const encodedName = encodeURIComponent(plan.name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
    "Content-Type": plan.mime,
    ETag: plan.contentEtag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

/** Streaming primitive; caller must prove current D1 authority and reserve the content budget. */
export async function streamImmutableBlob(
  bucket: R2Bucket,
  plan: BlobReadPlan,
  request: Request,
): Promise<Response> {
  validate(plan, request);
  const object = await bucket.head(plan.key);
  if (!object || object.size !== plan.size || object.etag !== plan.r2Etag)
    throw new Error("blob_storage_mismatch");
  const headers = responseHeaders(plan);
  if (ifNoneMatch(request.headers.get("If-None-Match"), plan.contentEtag))
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(plan.size));
    return new Response(null, { status: 200, headers });
  }
  const ifRange = request.headers.get("If-Range");
  const range = parseRange(
    ifRange === null || ifRange === plan.contentEtag ? request.headers.get("Range") : null,
    plan.size,
  );
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${plan.size}`);
    return new Response(null, { status: 416, headers });
  }
  const body = await bucket.get(
    plan.key,
    range.kind === "range" ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!body || body.etag !== plan.r2Etag || body.size !== plan.size)
    throw new Error("blob_storage_mismatch");
  if (range.kind === "range") {
    if (
      !body.range ||
      !("offset" in body.range) ||
      !("length" in body.range) ||
      body.range.offset !== range.offset ||
      body.range.length !== range.length
    )
      throw new Error("blob_range_mismatch");
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${plan.size}`,
    );
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(plan.size));
  }
  return new Response(body.body, { status: range.kind === "range" ? 206 : 200, headers });
}
