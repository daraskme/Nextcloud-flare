export const EPUB_XHTML_LIMIT = 2 * 1024 * 1024;
export const EPUB_TOTAL_XHTML_LIMIT = 20 * 1024 * 1024;
export const EPUB_ENTRY_LIMIT = 500;
export const EPUB_INNER_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:";

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizePublicationXhtml(bytes: Uint8Array, title: string): string {
  if (bytes.byteLength > EPUB_XHTML_LIMIT) throw new Error("epub_xhtml_too_large");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("epub_xhtml_invalid");
  }
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/iu.test(source)) {
    throw new Error("epub_xhtml_unsafe");
  }
  const text = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const safeTitle = escape(title.slice(0, 1024));
  const safeText = escape(text.slice(0, EPUB_XHTML_LIMIT));
  return `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="${EPUB_INNER_CSP}"/><meta name="referrer" content="no-referrer"/><title>${safeTitle}</title></head><body><main><h1>${safeTitle}</h1><p>${safeText}</p></main></body></html>`;
}

export function epubDerivativeKey(
  ownerId: string,
  blobId: string,
  generatorVersion: string,
  entryId: string,
  claimToken: string,
): string {
  for (const value of [ownerId, blobId, generatorVersion, entryId, claimToken]) {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("epub_derivative_identity_invalid");
  }
  return `u/${ownerId}/d/${blobId}/${generatorVersion}/epub/${entryId}/${claimToken}.xhtml`;
}
