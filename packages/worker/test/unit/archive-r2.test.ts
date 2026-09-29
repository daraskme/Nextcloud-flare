import { expect, it, vi } from "vitest";
import { archiveObjectSource } from "../../src/media/archive/r2Source";

const object = { key: "original", size: 1_000_000, etag: "immutable" };
const budget = () => ({ reads: 0, bytes: 0, maxReads: 4, maxBytes: 500_000 });

function setup(
  options: { bytes?: Uint8Array; override?: Record<string, unknown>; stalled?: boolean } = {},
) {
  const cancelled = vi.fn(),
    authorize = vi.fn(async () => {}),
    abort = new AbortController();
  const get = vi.fn(async (_key: string, request: R2GetOptions) => ({
    ...object,
    range: request.range,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (!options.stalled) {
          controller.enqueue(
            options.bytes ?? new Uint8Array((request.range as { length: number }).length),
          );
          controller.close();
        }
      },
      cancel: cancelled,
    }),
    ...options.override,
  }));
  const allowance = budget();
  const source = archiveObjectSource(
    { get } as unknown as R2Bucket,
    object,
    abort.signal,
    authorize,
    allowance,
  );
  return { source, cancelled, authorize, abort, get, allowance };
}

it("uses a fixed ETag and exact Range, charges before GET and verifies authority", async () => {
  const s = setup();
  expect((await s.source.read(5, 12)).length).toBe(12);
  expect(s.get).toHaveBeenCalledWith("original", {
    onlyIf: { etagMatches: "immutable" },
    range: { offset: 5, length: 12 },
  });
  expect(s.allowance).toMatchObject({ reads: 1, bytes: 12 });
  expect(s.authorize.mock.calls.length).toBeGreaterThanOrEqual(4);
});

it.each([
  { etag: "changed" },
  { size: object.size - 1 },
  { key: "other" },
  { range: { offset: 6, length: 12 } },
  { range: undefined },
  { range: { offset: 5, length: 13 } },
])("rejects changed R2 response %j", async (override) => {
  const s = setup({ override, stalled: true });
  await expect(s.source.read(5, 12)).rejects.toThrow("archive_source_changed");
  expect(s.cancelled).toHaveBeenCalledOnce();
});

it.each([11, 13])("rejects actual body length %i against the requested 12", async (length) => {
  const s = setup({ bytes: new Uint8Array(length) });
  await expect(s.source.read(0, 12)).rejects.toThrow("archive_source_length_mismatch");
});

it("does not issue a GET after the invocation byte or read budget is exhausted", async () => {
  const s = setup();
  s.allowance.bytes = s.allowance.maxBytes - 1;
  await expect(s.source.read(0, 2)).rejects.toThrow("archive_read_budget_exceeded");
  s.allowance.bytes = 0;
  s.allowance.reads = s.allowance.maxReads;
  await expect(s.source.read(0, 1)).rejects.toThrow("archive_read_budget_exceeded");
  expect(s.get).not.toHaveBeenCalled();
});

it.each([
  [0, 0],
  [-1, 5],
  [0, 1.5],
  [Number.MAX_SAFE_INTEGER, 2],
  [999999, 2],
])("rejects invalid range %i/%i without R2 I/O", async (offset, length) => {
  const s = setup();
  await expect(s.source.open(offset, length)).rejects.toThrow();
  expect(s.get).not.toHaveBeenCalled();
});

it("checks authority again after R2 resolves and discards revoked bodies", async () => {
  const s = setup({ stalled: true });
  s.authorize.mockResolvedValueOnce().mockRejectedValue(new Error("revoked"));
  await expect(s.source.read(0, 12)).rejects.toThrow("revoked");
  expect(s.cancelled).toHaveBeenCalledOnce();
});

it("cancels a stalled body at the caller deadline", async () => {
  const s = setup({ stalled: true }),
    body = await s.source.open(0, 12),
    reader = body.getReader();
  const reading = reader.read();
  s.abort.abort(new Error("deadline"));
  await expect(reading).rejects.toThrow("deadline");
  expect(s.cancelled).toHaveBeenCalledOnce();
});

it("rejects a stalled GET promptly and cancels its late response", async () => {
  let resolve!: (value: unknown) => void;
  const get = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
    abort = new AbortController(),
    cancelled = vi.fn();
  const source = archiveObjectSource(
    { get } as unknown as R2Bucket,
    object,
    abort.signal,
    async () => {},
    budget(),
  );
  const reading = source.read(0, 12);
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  abort.abort(new Error("deadline"));
  await expect(reading).rejects.toThrow("deadline");
  resolve({
    ...object,
    range: { offset: 0, length: 12 },
    body: new ReadableStream({ cancel: cancelled }),
  });
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});

it("checks authority between bounded slices of a large native chunk", async () => {
  const s = setup(),
    body = await s.source.open(0, 131072),
    reader = body.getReader();
  expect((await reader.read()).value?.length).toBe(65536);
  s.authorize.mockRejectedValue(new Error("revoked"));
  await expect(reader.read()).rejects.toThrow("revoked");
});

it("supports consumer cancellation while a body read is pending", async () => {
  const s = setup({ stalled: true }),
    body = await s.source.open(0, 12),
    reader = body.getReader();
  const reading = reader.read();
  await reader.cancel("closed");
  expect(await reading).toEqual({ done: true, value: undefined });
  expect(s.cancelled).toHaveBeenCalledWith("closed");
});
