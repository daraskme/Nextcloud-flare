import type { Env } from "../env.js";
import { isEffectiveLive } from "./effectiveLive.js";

export interface ContentDescriptor {
  nodeId: string;
  blobId: string;
  ownerId: string;
  rootId: string;
  key: string;
  size: number;
  etag: string;
  mime: string;
  name: string;
}

interface ByteRange {
  offset: number;
  length: number;
}

function parseRange(value: string, size: number): ByteRange | "multiple" | null {
  if (!value.startsWith("bytes=")) {
    return null;
  }
  const ranges = value.slice(6).split(",");
  if (ranges.length !== 1) {
    return "multiple";
  }
  const match = /^(\d*)-(\d*)$/u.exec(ranges[0]?.trim() ?? "");
  if (match === null || (match[1] === "" && match[2] === "")) {
    return null;
  }
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return null;
    }
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

function contentDisposition(name: string, attachment: boolean): string {
  const fallback =
    Array.from(name, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code <= 126 && character !== '"' && character !== "\\" ? character : "_";
    }).join("") || "download";
  return `${attachment ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function getContentDescriptor(env: Env, nodeId: string): Promise<ContentDescriptor> {
  const row = await env.DB.prepare(
    "SELECT n.id nodeId,n.owner_id ownerId,n.name,n.current_blob_id blobId,b.r2_key key,b.size,b.content_etag etag,COALESCE(b.mime_sniffed,'application/octet-stream') mime,s.root_node_id rootId FROM nodes n JOIN blobs b ON b.id=n.current_blob_id JOIN spaces s ON s.id=n.space_id WHERE n.id=?1 AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(nodeId)
    .first<ContentDescriptor>();
  if (row === null || !(await isEffectiveLive(env, nodeId, row.rootId))) {
    throw new Error("node_not_found");
  }
  return row;
}

export async function serveNodeContentById(
  env: Env,
  nodeId: string,
  request: Request,
): Promise<Response> {
  const item = await getContentDescriptor(env, nodeId);
  const commonHeaders = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(
      item.name,
      new URL(request.url).searchParams.get("download") === "1",
    ),
    "Content-Type": item.mime,
    ETag: item.etag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.headers.get("if-none-match") === item.etag) {
    return new Response(null, { status: 304, headers: commonHeaders });
  }
  if (request.method === "HEAD") {
    const object = await env.BLOBS.head(item.key);
    if (object === null || object.size !== item.size) {
      return Response.json(
        { error: { code: "content_inconsistent", message: "Committed content is unavailable" } },
        { status: 503, headers: commonHeaders },
      );
    }
    commonHeaders.set("Content-Length", String(item.size));
    return new Response(null, { headers: commonHeaders });
  }
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader === null ? undefined : parseRange(rangeHeader, item.size);
  if (range === null) {
    commonHeaders.set("Content-Range", `bytes */${item.size}`);
    return new Response(null, { status: 416, headers: commonHeaders });
  }
  if (range !== undefined && range !== "multiple") {
    const object = await env.BLOBS.get(item.key, { range });
    if (object === null || object.size !== item.size) {
      return Response.json(
        { error: { code: "content_inconsistent", message: "Committed content is unavailable" } },
        { status: 503, headers: commonHeaders },
      );
    }
    commonHeaders.set("Content-Length", String(range.length));
    commonHeaders.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${item.size}`,
    );
    return new Response(object.body, { status: 206, headers: commonHeaders });
  }
  const object = await env.BLOBS.get(item.key);
  if (object === null) {
    return Response.json(
      { error: { code: "content_inconsistent", message: "Committed content is unavailable" } },
      { status: 503, headers: commonHeaders },
    );
  }
  commonHeaders.set("Content-Length", String(item.size));
  return new Response(object.body, { headers: commonHeaders });
}

export async function serveNodeContent(
  env: Env,
  userId: string,
  nodeId: string,
  request: Request,
): Promise<Response> {
  const item = await getContentDescriptor(env, nodeId);
  if (item.ownerId !== userId) throw new Error("node_not_found");
  return serveNodeContentById(env, nodeId, request);
}
