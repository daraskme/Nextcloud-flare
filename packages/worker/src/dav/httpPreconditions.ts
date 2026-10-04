const MAX_HEADER_BYTES = 8192;
const MAX_TAGS = 16;

type Tag = { readonly value: string; readonly weak: boolean };

function parseTags(raw: string): "*" | readonly Tag[] {
  if (new TextEncoder().encode(raw).byteLength > MAX_HEADER_BYTES)
    throw new Error("invalid_dav_precondition");
  if (raw.trim() === "*") return "*";
  const tags: Tag[] = [];
  let offset = 0;
  while (offset < raw.length) {
    while (raw[offset] === " " || raw[offset] === "\t") offset++;
    const weak = raw.startsWith("W/", offset);
    if (weak) offset += 2;
    if (raw[offset++] !== '"') throw new Error("invalid_dav_precondition");
    const start = offset;
    while (offset < raw.length && raw[offset] !== '"') {
      const code = raw.charCodeAt(offset++);
      if (code < 0x21 || code === 0x7f) throw new Error("invalid_dav_precondition");
    }
    if (offset >= raw.length) throw new Error("invalid_dav_precondition");
    tags.push({ value: raw.slice(start, offset++), weak });
    if (tags.length > MAX_TAGS) throw new Error("invalid_dav_precondition");
    while (raw[offset] === " " || raw[offset] === "\t") offset++;
    if (offset === raw.length) break;
    if (raw[offset++] !== "," || offset === raw.length) throw new Error("invalid_dav_precondition");
  }
  if (!tags.length || /,\s*$/.test(raw)) throw new Error("invalid_dav_precondition");
  return tags;
}

/** Evaluate HTTP validators before a DAV PUT starts streaming its body. */
export function evaluateDavPutHttpPreconditions(
  headers: Headers,
  currentEtag: string | null,
): void {
  const current = currentEtag === null ? null : currentEtag.slice(1, -1);
  const ifMatch = headers.get("If-Match");
  if (ifMatch !== null) {
    const parsed = parseTags(ifMatch);
    if (
      current === null ||
      (parsed !== "*" && !parsed.some((tag) => !tag.weak && tag.value === current))
    )
      throw new Error("dav_precondition_failed");
  }
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    const parsed = parseTags(ifNoneMatch);
    if (current !== null && (parsed === "*" || parsed.some((tag) => tag.value === current)))
      throw new Error("dav_precondition_failed");
  }
}
