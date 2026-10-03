import { parseRange } from "./range";

export const MEDIA_RANGE_BYTES = 4 * 1024 * 1024;

/** Bound native players' open-ended reads before reserving and streaming bytes.
 * RFC 9110 §15.3.7 permits a self-describing subset of a requested range.
 * A canceled seek must not reserve the remainder of a multi-gigabyte movie.
 */
export function boundedMediaRequest(
  request: Request,
  representation: { readonly mime: string; readonly size: number; readonly contentEtag: string },
): Request {
  const header = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (
    request.method !== "GET" ||
    !/^(?:audio|video)\//.test(representation.mime) ||
    !/^bytes=\d+-$/.test(header ?? "") ||
    (ifRange !== null && ifRange !== representation.contentEtag)
  )
    return request;
  const range = parseRange(header, representation.size);
  if (range.kind !== "range" || range.length <= MEDIA_RANGE_BYTES) return request;
  const headers = new Headers(request.headers);
  headers.set("Range", `bytes=${range.offset}-${range.offset + MEDIA_RANGE_BYTES - 1}`);
  return new Request(request, { headers });
}
