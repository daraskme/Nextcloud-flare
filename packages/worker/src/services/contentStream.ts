const MAX_LEASE_MS = 600_000;
const SETTLEMENT_WAIT_MS = 5_000;

/** Bound setup and delivery by one lease, including an unread or stalled response. */
export async function streamLeasedContent(
  load: (signal: AbortSignal, deadline: number) => Promise<Response>,
  bytes: number,
  expiresAt: number,
  signal: AbortSignal,
  settle: (deliveredBytes: number | null) => Promise<unknown>,
): Promise<Response> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(expiresAt))
    throw new Error("invalid_content_lease");
  const deadline = Math.min(expiresAt, Date.now() + MAX_LEASE_MS);
  const lifetime = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let loaded: Response | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let deliveryStarted = false;
  let ended = false;
  let delivered = 0;
  let settlement: Promise<unknown> | undefined;
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
  });
  void stopped.catch(() => undefined);
  const settleOnce = (value: number | null) => {
    settlement ??= Promise.resolve().then(() => settle(value));
    void settlement.catch(() => undefined);
    return settlement;
  };
  const dispose = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  };
  const stop = (reason: unknown) => {
    if (ended) return;
    ended = true;
    dispose();
    lifetime.abort(reason);
    rejectStopped(reason);
    output?.error(reason);
    // Reader cancellation and remote accounting may not acknowledge. Neither can
    // keep bytes flowing or delay the deadline; unacknowledged leases stay charged.
    void reader?.cancel(reason).catch(() => undefined);
    if (!reader) void loaded?.body?.cancel(reason).catch(() => undefined);
    void settleOnce(deliveryStarted ? null : 0);
  };
  const check = () => {
    if (!ended && Date.now() >= deadline) stop(new Error("content_lease_expired"));
    lifetime.signal.throwIfAborted();
  };
  const onAbort = () => stop(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const timer = setTimeout(
    () => stop(new Error("content_lease_expired")),
    Math.max(0, deadline - Date.now()),
  );
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    check();
    const loading = Promise.resolve()
      .then(() => {
        check();
        return load(lifetime.signal, deadline);
      })
      .then((response) => {
        loaded = response;
        if (ended) {
          void response.body?.cancel(lifetime.signal.reason).catch(() => undefined);
          lifetime.signal.throwIfAborted();
        }
        return response;
      });
    const response = await Promise.race([loading, stopped]);
    check();
    if (!response.body) {
      await Promise.race([settleOnce(0), stopped]);
      check();
      ended = true;
      dispose();
      return response;
    }
    reader = response.body.getReader();
    deliveryStarted = true;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
        },
        async pull(controller) {
          if (ended) return;
          try {
            check();
            const next = await Promise.race([reader!.read(), stopped]);
            check();
            if (next.done) {
              if (delivered !== bytes) throw new Error("blob_stream_length_mismatch");
              await Promise.race([settleOnce(delivered), stopped]);
              check();
              ended = true;
              dispose();
              reader!.releaseLock();
              controller.close();
              return;
            }
            if (delivered + next.value.byteLength > bytes)
              throw new Error("blob_stream_length_mismatch");
            delivered += next.value.byteLength;
            controller.enqueue(next.value);
          } catch (error) {
            stop(error);
          }
        },
        async cancel(reason) {
          output = undefined;
          stop(reason ?? new DOMException("Cancelled", "AbortError"));
          // Give explicit settlement a bounded opportunity to acknowledge cancellation.
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              settleOnce(null).catch(() => undefined),
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, SETTLEMENT_WAIT_MS);
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    stop(error);
    throw error;
  }
}
