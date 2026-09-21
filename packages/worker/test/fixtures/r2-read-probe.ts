import { parseRange } from "../../src/platform/range";

// This is a runtime feasibility fixture, never part of the production router.
export async function readProbe(
  bucket: R2Bucket,
  key: string,
  request: Request,
): Promise<Response> {
  const object = await bucket.head(key);
  if (!object) return new Response(null, { status: 404 });
  const headers = new Headers({
    ETag: object.httpEtag,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  });
  // Probe uses R2 validators; Phase 2 uses the D1 content ETag after EffectiveLive authorization.
  if (request.headers.get("If-None-Match") === object.httpEtag)
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(object.size));
    return new Response(null, { headers });
  }
  const range = parseRange(request.headers.get("Range"), object.size);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  const body = await bucket.get(
    key,
    range.kind === "range" ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!body) throw new Error("object_disappeared");
  if (range.kind === "range") {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(object.size));
  }
  return new Response(body.body, { status: range.kind === "range" ? 206 : 200, headers });
}
