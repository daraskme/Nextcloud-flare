export interface DavEtagNode {
  readonly id: string;
  readonly kind: "root" | "folder" | "file";
  readonly revision: number;
  readonly current_blob_id: string | null;
}

/** Stable DAV validator shared by GET/HEAD, PROPFIND and If evaluation. */
export function davEtag(node: DavEtagNode): string {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(node.id) ||
    !Number.isSafeInteger(node.revision) ||
    node.revision < 1
  )
    throw new Error("invalid_dav_etag");
  if (node.kind === "file") {
    if (!node.current_blob_id || !/^[A-Za-z0-9_-]{1,128}$/.test(node.current_blob_id))
      throw new Error("invalid_dav_etag");
    return `"b-${node.current_blob_id}"`;
  }
  if (node.current_blob_id !== null) throw new Error("invalid_dav_etag");
  return `"c-${node.id}-${node.revision}"`;
}

/** HTTP entity-tag conditions are independent of the DAV If header. */
export function assertDavPutConditions(headers: Headers, etag: string | null) {
  for (const name of ["If-Match", "If-None-Match"]) {
    const raw = headers.get(name);
    if (raw === null) continue;
    if (raw.length > 8192) throw new Error("invalid_dav_if");
    const value = raw.trim();
    const tags = value === "*" ? [] : value.match(/(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g);
    if (
      value !== "*" &&
      (!tags ||
        tags.length === 0 ||
        tags.length > 16 ||
        !/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"(?:[ \t]*,[ \t]*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")*$/.test(
          value,
        ))
    )
      throw new Error("invalid_dav_if");
    const matches =
      value === "*"
        ? etag !== null
        : !!etag &&
          tags!.some((tag) => (name === "If-Match" ? tag : tag.replace(/^W\//, "")) === etag);
    if (name === "If-Match" ? !matches : matches) throw new Error("dav_precondition_failed");
  }
}
