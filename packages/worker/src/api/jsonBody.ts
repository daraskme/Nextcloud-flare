/** Bounded private JSON object; consume no more than one small API request body. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type") !== "application/json" || !request.body)
    throw new Error("invalid_body");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(8192);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) {
        await reader.cancel();
        throw new Error("invalid_body");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  return value as Record<string, unknown>;
}
