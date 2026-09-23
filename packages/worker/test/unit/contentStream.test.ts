import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { streamImmutableBlob } from "../../src/services/blobRead";
import { streamLeasedContent } from "../../src/services/contentStream";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const never = () => new Promise<never>(() => {});
const signal = () => new AbortController().signal;

it.each(["abc", ""])(
  "streams exact bytes and clears its lifetime after success (%j)",
  async (text) => {
    const abort = new AbortController();
    const settle = vi.fn(async () => {});
    const response = await streamLeasedContent(
      async () => new Response(text, { status: 206, headers: { "Content-Range": "bytes 0-2/3" } }),
      text.length,
      Date.now() + 1000,
      abort.signal,
      settle,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-2/3");
    expect(await response.text()).toBe(text);
    expect(settle.mock.calls).toEqual([[text.length]]);
    expect(vi.getTimerCount()).toBe(0);
    abort.abort();
    expect(settle).toHaveBeenCalledTimes(1);
  },
);

it.each([200, 304, 416])("settles a body-less %s without leaving a timer", async (status) => {
  const settle = vi.fn(async () => {});
  const original = new Response(null, { status });
  expect(
    await streamLeasedContent(async () => original, 0, Date.now() + 1000, signal(), settle),
  ).toBe(original);
  expect(settle.mock.calls).toEqual([[0]]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["expired", "aborted"])(
  "never dispatches storage for an already %s lease",
  async (kind) => {
    const abort = new AbortController();
    if (kind === "aborted") abort.abort(new Error("request_stopped"));
    const load = vi.fn(async () => new Response("abc"));
    const settle = vi.fn(async () => {});
    await expect(
      streamLeasedContent(
        load,
        3,
        Date.now() + (kind === "expired" ? 0 : 1000),
        abort.signal,
        settle,
      ),
    ).rejects.toThrow(kind === "expired" ? "content_lease_expired" : "request_stopped");
    expect(load).not.toHaveBeenCalled();
    expect(settle.mock.calls).toEqual([[0]]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("ends a pending storage read at the deadline and cancels its eventual body", async () => {
  let resolve!: (response: Response) => void;
  let upstream: AbortSignal | undefined;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const settle = vi.fn(async () => {});
  const cancelled = vi.fn();
  const result = streamLeasedContent(
    async (signal) => {
      upstream = signal;
      return pending;
    },
    3,
    Date.now() + 1000,
    signal(),
    settle,
  );
  const rejected = expect(result).rejects.toThrow("content_lease_expired");
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(upstream?.aborted).toBe(true);
  expect(settle.mock.calls).toEqual([[0]]);
  resolve(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a response that arrives after expiry before the timer callback runs", async () => {
  const cancel = vi.fn();
  const settle = vi.fn(async () => {});
  const deadline = Date.now() + 1000;
  await expect(
    streamLeasedContent(
      async () => {
        vi.setSystemTime(deadline + 1);
        return new Response(new ReadableStream({ cancel }));
      },
      3,
      deadline,
      signal(),
      settle,
    ),
  ).rejects.toThrow("content_lease_expired");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls).toEqual([[0]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("caps delivery at ten minutes even if its supplied lease is longer", async () => {
  const settle = vi.fn(async () => {});
  const response = await streamLeasedContent(
    async () => new Response(new ReadableStream()),
    3,
    Date.now() + 1_000_000,
    signal(),
    settle,
  );
  const result = expect(response.text()).rejects.toThrow("content_lease_expired");
  await vi.advanceTimersByTimeAsync(600_000);
  await result;
  expect(settle.mock.calls).toEqual([[null]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("ends a stalled body even when upstream cancellation never acknowledges", async () => {
  const cancelled = vi.fn(never);
  const settle = vi.fn(async () => {});
  const response = await streamLeasedContent(
    async () => new Response(new ReadableStream({ cancel: cancelled })),
    3,
    Date.now() + 1000,
    signal(),
    settle,
  );
  const result = expect(response.text()).rejects.toThrow("content_lease_expired");
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls).toEqual([[null]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("expires an unread response without pulling or retaining queued data", async () => {
  const pull = vi.fn();
  const cancelled = vi.fn();
  const settle = vi.fn(async () => {});
  const response = await streamLeasedContent(
    async () => new Response(new ReadableStream({ pull, cancel: cancelled }, { highWaterMark: 0 })),
    3,
    Date.now() + 1000,
    signal(),
    settle,
  );
  await vi.advanceTimersByTimeAsync(1000);
  await expect(response.text()).rejects.toThrow("content_lease_expired");
  expect(pull).not.toHaveBeenCalled();
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls).toEqual([[null]]);
});

it("handles request abort during a read with one cancellation and one full charge", async () => {
  const abort = new AbortController();
  const cancelled = vi.fn();
  const settle = vi.fn(async () => {});
  const response = await streamLeasedContent(
    async () => new Response(new ReadableStream({ cancel: cancelled })),
    3,
    Date.now() + 1000,
    abort.signal,
    settle,
  );
  const result = expect(response.text()).rejects.toThrow("request_stopped");
  abort.abort(new Error("request_stopped"));
  await result;
  await vi.advanceTimersByTimeAsync(1000);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls).toEqual([[null]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds cancellation even if the reader and settlement both remain pending", async () => {
  const cancelled = vi.fn(never);
  const settle = vi.fn(never);
  const response = await streamLeasedContent(
    async () => new Response(new ReadableStream({ cancel: cancelled })),
    3,
    Date.now() + 10000,
    signal(),
    settle,
  );
  let done = false;
  const stopped = response.body!.cancel().then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(4999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await stopped;
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls).toEqual([[null]]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([2, 4])("rejects a stream length mismatch against %s reserved bytes", async (bytes) => {
  const settle = vi.fn(async () => {});
  const response = await streamLeasedContent(
    async () => new Response("abc"),
    bytes,
    Date.now() + 1000,
    signal(),
    settle,
  );
  await expect(response.text()).rejects.toThrow("blob_stream_length_mismatch");
  expect(settle.mock.calls).toEqual([[null]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("refunds a known setup failure without replacing the original failure", async () => {
  const settle = vi.fn(async () => {
    throw new Error("settlement_failed");
  });
  await expect(
    streamLeasedContent(
      async () => {
        throw new Error("storage_failed");
      },
      3,
      Date.now() + 1000,
      signal(),
      settle,
    ),
  ).rejects.toThrow("storage_failed");
  expect(settle.mock.calls).toEqual([[0]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the deadline active while the final settlement acknowledgement is pending", async () => {
  const settle = vi.fn(never);
  const response = await streamLeasedContent(
    async () => new Response("abc"),
    3,
    Date.now() + 1000,
    signal(),
    settle,
  );
  const result = expect(response.text()).rejects.toThrow("content_lease_expired");
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(settle.mock.calls).toEqual([[3]]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["head", "get"])(
  "checks the deadline after R2 %s even before a timer callback can run",
  async (stage) => {
    const expiresAt = Date.now() + 1000;
    const cancel = vi.fn();
    const get = vi.fn(async () => {
      if (stage === "get") vi.setSystemTime(expiresAt + 1);
      return { size: 3, etag: "etag", body: new ReadableStream({ cancel }) };
    });
    const bucket = {
      head: async () => {
        if (stage === "head") vi.setSystemTime(expiresAt + 1);
        return { size: 3, etag: "etag" };
      },
      get,
    } as unknown as R2Bucket;
    const settle = vi.fn(async () => {});
    await expect(
      streamLeasedContent(
        (signal, deadline) =>
          streamImmutableBlob(
            bucket,
            {
              key: "u/user/b/blob",
              size: 3,
              r2Etag: "etag",
              contentEtag: '"b-blob"',
              mime: "text/plain",
              name: "test.txt",
            },
            new Request("https://content.invalid/c"),
            { signal, deadline },
          ),
        3,
        expiresAt,
        signal(),
        settle,
      ),
    ).rejects.toThrow("content_lease_expired");
    expect(get).toHaveBeenCalledTimes(stage === "head" ? 0 : 1);
    expect(cancel).toHaveBeenCalledTimes(stage === "head" ? 0 : 1);
    expect(settle.mock.calls).toEqual([[0]]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
