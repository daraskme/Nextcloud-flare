const EMPTY_BODY_DEADLINE_MS = 5_000;
const MAX_EMPTY_READS = 16;

/** Transport adapters may supply a stream even when the HTTP body has zero bytes. */
export async function hasEmptyBody(
  request: Pick<Request, "body" | "bodyUsed" | "signal">,
): Promise<boolean> {
  if (request.signal.aborted || request.bodyUsed) return false;
  if (!request.body) return true;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return false;
  }
  let stop!: () => void;
  const stopped = new Promise<null>((resolve) => {
    stop = () => resolve(null);
  });
  const expiresAt = Date.now() + EMPTY_BODY_DEADLINE_MS;
  const timer = setTimeout(stop, EMPTY_BODY_DEADLINE_MS);
  request.signal.addEventListener("abort", stop, { once: true });
  let ended = false;
  try {
    for (let count = 0; count < MAX_EMPTY_READS; count++) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part === null || request.signal.aborted || Date.now() >= expiresAt) return false;
      if (part.done) {
        ended = true;
        return true;
      }
      if (part.value.byteLength !== 0) return false;
    }
    return false; // A producer of endless empty chunks must not keep the request alive.
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", stop);
    // Cancellation of an untrusted source may never settle. Do not wait or buffer its payload.
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
