import { afterEach, expect, it, vi } from "vitest";
import { hasEmptyBody } from "../../src/api/emptyBody";

const input = (body: ReadableStream<Uint8Array> | null, signal = new AbortController().signal) => ({
  body,
  bodyUsed: false,
  signal,
});
afterEach(() => vi.useRealTimers());

it("accepts absent bodies and closed zero-byte transport streams", async () => {
  expect(await hasEmptyBody(input(null))).toBe(true);
  const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  expect(await hasEmptyBody(input(body))).toBe(true);
  expect(body.locked).toBe(false);
});

it("accepts zero-length chunks only after reaching EOF", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array());
      controller.enqueue(new Uint8Array());
      controller.close();
    },
  });
  expect(await hasEmptyBody(input(body))).toBe(true);
  expect(body.locked).toBe(false);
});

it.each([" ", "\0", "{}"])(
  "rejects payload bytes without draining the rest (%j)",
  async (payload) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(payload)),
      cancel,
    });
    expect(await hasEmptyBody(input(body))).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  },
);

it("rejects a failed source and does not retain its reader", async () => {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.error(new Error("disconnected")),
  });
  expect(await hasEmptyBody(input(body))).toBe(false);
  expect(body.locked).toBe(false);
});

it("rejects a locked stream without releasing someone else's reader", async () => {
  const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = body.getReader();
  try {
    expect(await hasEmptyBody(input(body))).toBe(false);
    expect(body.locked).toBe(true);
  } finally {
    reader.releaseLock();
  }
});

it("does not mistake an already consumed payload for an empty request", async () => {
  const request = new Request("https://app.invalid", { method: "DELETE", body: "{}" });
  expect(await request.text()).toBe("{}");
  expect(await hasEmptyBody(request)).toBe(false);
});

it("rejects an already aborted request even if its body is absent", async () => {
  const abort = new AbortController();
  abort.abort();
  expect(await hasEmptyBody(input(null, abort.signal))).toBe(false);
});

it("stops a pending read on cancellation and releases all local resources", async () => {
  vi.useFakeTimers();
  const abort = new AbortController(),
    cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const result = hasEmptyBody(input(body, abort.signal));
  abort.abort();
  expect(await result).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("times out a stalled source even if its cancellation never settles", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => undefined));
  const body = new ReadableStream<Uint8Array>({ cancel });
  const result = hasEmptyBody(input(body));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects late EOF even if the timer callback has not run yet", async () => {
  vi.useFakeTimers();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      source = controller;
    },
  });
  const result = hasEmptyBody(input(body));
  vi.setSystemTime(Date.now() + 5_000);
  source.close();
  expect(await result).toBe(false);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a flood of empty chunks instead of starving the event loop", async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls === 1_000) controller.error(new Error("unbounded reader"));
      else controller.enqueue(new Uint8Array());
    },
    cancel,
  });
  expect(await hasEmptyBody(input(body))).toBe(false);
  expect(pulls).toBeLessThan(100);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
