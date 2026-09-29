export const TRANSFER_MAX_NODES = 1_000;

/** Same canonical bytes as the historical intent hash, with a separate bounded ID-list budget. */
export async function transferManifestDigest(ids: readonly string[]): Promise<string> {
  if (
    !Array.isArray(ids) ||
    ids.length > TRANSFER_MAX_NODES ||
    [...ids].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new Error("invalid_transfer_manifest");
  // At most 131,001 ASCII bytes. The public operation body keeps its existing 16 KiB budget.
  const bytes = new TextEncoder().encode(JSON.stringify(ids));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
