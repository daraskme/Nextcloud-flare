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
