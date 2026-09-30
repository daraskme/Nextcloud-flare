import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { consumeKnownLength, putImmutableProbe } from "../../src/platform/stream";
import { bytesSource, drain } from "../fixtures/streams";

it.each([
  [0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  [3, "9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0"],
])("stores %i bytes with a verified SHA-256", async (size, hash) => {
  const key = `probe/${crypto.randomUUID()}`;
  try {
    const result = await putImmutableProbe(env.BLOBS, key, bytesSource(size).body, size);
    expect(result.sha256).toBe(hash);
    expect(result.bytes).toBe(size);
    expect((await env.BLOBS.head(key))?.size).toBe(size);
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("streams the 95,000,000-byte request limit through R2 and back", async () => {
  const key = `probe/${crypto.randomUUID()}`;
  try {
    const size = 95_000_000;
    const result = await putImmutableProbe(env.BLOBS, key, bytesSource(size).body, size);
    expect(result.value.size).toBe(size);
    const object = await env.BLOBS.get(key);
    expect(object).not.toBeNull();
    if (!object) throw new Error("missing object");
    expect(await drain(object.body)).toBe(size);
  } finally {
    await env.BLOBS.delete(key);
  }
});

it.each([2, 4])("rejects a declared size of 3 for actual size %i", async (size) => {
  await expect(consumeKnownLength(bytesSource(size).body, 3, drain)).rejects.toThrow(
    /invalid_length/,
  );
});

it("does not overwrite an immutable R2 key when onlyIf returns null", async () => {
  const key = `probe/${crypto.randomUUID()}`;
  try {
    await env.BLOBS.put(key, "original");
    await expect(putImmutableProbe(env.BLOBS, key, bytesSource(3).body, 3)).rejects.toThrow(
      /precondition_failed/,
    );
    expect(await (await env.BLOBS.get(key))?.text()).toBe("original");
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("applies backpressure while the consumer is paused", async () => {
  const source = bytesSource(4 * 65_536);
  let resume: () => void = () => {};
  let reached: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const result = consumeKnownLength(source.body, 4 * 65_536, async (body) => {
    const reader = body.getReader();
    let total = 0;
    try {
      const first = await reader.read();
      total += first.value?.byteLength ?? 0;
      reached();
      await gate;
      for (;;) {
        const next = await reader.read();
        if (next.done) return total;
        total += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  });
  await paused;
  try {
    expect(source.produced()).toBeLessThanOrEqual(2 * 65_536);
  } finally {
    resume();
  }
  expect((await result).value).toBe(4 * 65_536);
});

it("cancels the source when the consumer disconnects", async () => {
  let cancelled = false;
  const source = bytesSource(95_000_000, 97, () => {
    cancelled = true;
  });
  await expect(
    consumeKnownLength(source.body, 95_000_000, async (body) => {
      const reader = body.getReader();
      await reader.read();
      await reader.cancel(new Error("client_disconnect"));
      reader.releaseLock();
      throw new Error("client_disconnect");
    }),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(source.produced()).toBeLessThan(95_000_000);
});

it("cancels a stalled upload source and consumer when its lease signal expires", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const pending = consumeKnownLength(body, 3, drain, controller.signal);
  const assertion = expect(pending).rejects.toThrow(/lease_expired/);
  controller.abort(new Error("lease_expired"));
  await assertion;
  expect(cancelled).toBe(true);
});

it("propagates producer failure to the consumer", async () => {
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("source_failure"));
    },
  });
  await expect(consumeKnownLength(source, 10, drain)).rejects.toThrow(/source_failure/);
});
