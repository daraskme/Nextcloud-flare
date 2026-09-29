/** Only a small, verified WebP thumbnail is materialized in browser memory. */
export async function readGalleryThumbnail(
  path: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  const response = await fetch(path, {
    headers,
    signal,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
  const declared = response.headers.get("Content-Length");
  const size = declared === null ? null : Number(declared);
  if (
    !response.ok ||
    response.headers.get("Content-Type") !== "image/webp" ||
    (size !== null && (!Number.isSafeInteger(size) || size < 1 || size > 12582912)) ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("thumbnail_unavailable");
  }
  const reader = response.body.getReader(),
    parts: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > (size ?? 12582912)) throw new Error("thumbnail_size_mismatch");
      parts.push(new Uint8Array(next.value));
    }
    signal.throwIfAborted();
    if (received < 1 || (size !== null && received !== size))
      throw new Error("thumbnail_size_mismatch");
    return new Blob(parts, { type: "image/webp" });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function galleryOriginal(
  origin: string,
  ticket: string,
  node: { id: string; currentBlobId: string },
  signal: AbortSignal,
) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    ![node.id, node.currentBlobId].every((x) => /^[A-Za-z0-9_-]{1,128}$/.test(x))
  )
    throw new Error("invalid_content_target");
  const response = await fetch(`${origin}/session`, {
    method: "POST",
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  signal.throwIfAborted();
  if (!response.ok) throw new Error("original_unavailable");
  return `${origin}/c/${node.id}/${node.currentBlobId}`;
}
