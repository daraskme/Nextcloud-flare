import { expect, it, vi } from "vitest";
import { pngCrc } from "../../src/media/images/inspect";
import { openImageObject } from "../../src/media/images/objectStream";
import {
  IMAGE_OUTPUT_BYTES,
  type ImageTransformPlan,
  planImageTransform,
  transformImage,
  validateImageOutput,
} from "../../src/media/images/transform";
import { imageBytes } from "../fixtures/images/encoded";
import { withJpegExif } from "../fixtures/images/metadata";

const source = (bytes: Uint8Array) => ({
  size: bytes.length,
  read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)),
});
const stream = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]).stream();
const signal = () => new AbortController().signal;
const plan = () => planImageTransform(source(imageBytes("red.png")), "sm");
const consume = async (input: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(input).arrayBuffer());
const result = (bytes = imageBytes("red.webp"), mime = "image/webp") => ({
  image: () => stream(bytes),
  contentType: () => mime,
});
function binding(output: (input: ReadableStream<Uint8Array>) => Promise<unknown>) {
  const options = vi.fn(),
    transforms = vi.fn(),
    input = vi.fn((body: ReadableStream<Uint8Array>) => ({
      transform(value: unknown) {
        transforms(value);
        return {
          output(value: unknown) {
            options(value);
            return output(body);
          },
        };
      },
    }));
  return { native: { input } as unknown as ImagesBinding, input, options, transforms };
}
const object = { key: "u/owner/b/immutable", size: 99, etag: "stored-etag" };
const body = (bytes = imageBytes("red.png"), extra = {}) => ({
  ...object,
  body: stream(bytes),
  ...extra,
});
const bucket = (get: (...args: unknown[]) => Promise<unknown>) => ({ get }) as R2Bucket;

it.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "plans display dimensions for EXIF orientation %s",
  async (orientation) => {
    expect(
      await planImageTransform(source(withJpegExif(imageBytes("red.jpg"), orientation)), "sm"),
    ).toMatchObject({
      width: orientation < 5 ? 16 : 12,
      height: orientation < 5 ? 12 : 16,
      source: { orientation, cameraMake: "PRIVATE-CAMERA" },
    });
  },
);

it.each(["sm", "md", "lg"] as const)("does not upscale a small %s image", async (variant) => {
  expect(await planImageTransform(source(imageBytes("red.png")), variant)).toMatchObject({
    width: 16,
    height: 12,
    variant,
  });
});
it.each([
  ["sm", 256, 144],
  ["md", 768, 432],
  ["lg", 1600, 900],
] as const)("plans %s with the source aspect ratio", async (variant, width, height) => {
  expect(await planImageTransform(source(imageBytes("pattern.png")), variant)).toMatchObject({
    width,
    height,
  });
});
it.each([0, -1, 20_000_001, NaN, Infinity, 1.5])("rejects size %s before I/O", async (size) => {
  const read = vi.fn();
  await expect(planImageTransform({ size, read }, "sm")).rejects.toThrow("unsupported_size");
  expect(read).not.toHaveBeenCalled();
});
it.each([
  [12001, 1],
  [10000, 4001],
])("rejects dimensions %s × %s before transforming", async (width, height) => {
  const bytes = imageBytes("red.png"),
    view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, pngCrc(bytes.subarray(12, 29)));
  await expect(planImageTransform(source(bytes), "sm")).rejects.toThrow("unsupported_size");
});
it("rejects animation and spoofed image contents, without excluding static AVIF", async () => {
  await expect(planImageTransform(source(imageBytes("sequence.avif")), "sm")).rejects.toThrow(
    "unsupported_animation",
  );
  await expect(
    planImageTransform(source(new TextEncoder().encode("<svg>hello</svg>")), "sm"),
  ).rejects.toThrow("unsupported_format");
  expect(await planImageTransform(source(imageBytes("red.avif")), "md")).toMatchObject({
    source: { mime: "image/avif" },
  });
  await expect(
    planImageTransform(source(imageBytes("red.png")), "constructor" as "sm"),
  ).rejects.toThrow("invalid_image_variant");
});
it("transforms once to WebP, fixes options and hashes only the validated output", async () => {
  const p = await plan();
  const b = binding(async (input) => {
    expect(await consume(input)).toEqual(imageBytes("red.png"));
    return result();
  });
  const output = await transformImage(b.native, p, stream(imageBytes("red.png")), signal());
  expect(output).toMatchObject({ mime: "image/webp", width: 16, height: 12 });
  expect(output.bytes).toEqual(imageBytes("red.webp"));
  expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(b.input).toHaveBeenCalledTimes(1);
  expect(b.transforms).toHaveBeenCalledWith({ width: 16, height: 12, fit: "contain" });
  expect(b.options).toHaveBeenCalledWith({ format: "image/webp", quality: 85, anim: false });
});
it.each([-1, 1])("rejects an input length difference of %s", async (delta) => {
  const b = binding(async (input) => {
    await consume(input);
    return result();
  });
  await expect(
    transformImage(b.native, await plan(), stream(new Uint8Array(99 + delta)), signal()),
  ).rejects.toThrow("image_source_length_mismatch");
  expect(b.input).toHaveBeenCalledTimes(1);
});
it("does not accept an output when the binding skipped its input", async () => {
  const b = binding(async () => result());
  await expect(
    transformImage(b.native, await plan(), stream(imageBytes("red.png")), signal()),
  ).rejects.toThrow("image_source_not_consumed");
});
it("does not retry a native failure or mistake it for format unsupported", async () => {
  const failure = new Error("service unavailable");
  const b = binding(async (input) => {
    await consume(input);
    throw failure;
  });
  await expect(
    transformImage(b.native, await plan(), stream(imageBytes("red.png")), signal()),
  ).rejects.toBe(failure);
  expect(b.input).toHaveBeenCalledTimes(1);
});
it.each(["EXIF", "XMP ", "ICCP", "ANIM", "JUNK"])("rejects an output %s chunk", async (name) => {
  const original = imageBytes("red.webp"),
    bytes = new Uint8Array(original.length + 10);
  bytes.set(original);
  bytes.set(new TextEncoder().encode(name), original.length);
  new DataView(bytes.buffer).setUint32(original.length + 4, 2, true);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  await expect(validateImageOutput(bytes, await plan())).rejects.toThrow("output_metadata");
});
it("rejects wrong dimensions, truncated output and non-WebP output", async () => {
  const p = await plan();
  await expect(validateImageOutput(imageBytes("red.webp"), { ...p, width: 17 })).rejects.toThrow(
    "output_dimensions",
  );
  await expect(validateImageOutput(imageBytes("red.webp").slice(0, -1), p)).rejects.toThrow();
  await expect(validateImageOutput(imageBytes("red.png"), p)).rejects.toThrow("output_format");
});
it("bounds native output bytes and cancels its reader", async () => {
  const cancelled = vi.fn();
  const b = binding(async (input) => {
    await consume(input);
    return {
      contentType: () => "image/webp",
      image: () =>
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(IMAGE_OUTPUT_BYTES + 1));
          },
          cancel: cancelled,
        }),
    };
  });
  await expect(
    transformImage(b.native, await plan(), stream(imageBytes("red.png")), signal()),
  ).rejects.toThrow("output_size");
  expect(cancelled).toHaveBeenCalledTimes(1);
});
it("rejects an already aborted transform without a native invocation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("expired"));
  const b = binding(async () => result());
  await expect(
    transformImage(b.native, await plan(), stream(imageBytes("red.png")), controller.signal),
  ).rejects.toThrow("expired");
  expect(b.input).not.toHaveBeenCalled();
});
it("returns at the deadline and cancels a late native response without replay", async () => {
  const controller = new AbortController(),
    cancelled = vi.fn();
  let finish!: (value: unknown) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const b = binding(async (input) => {
    await consume(input);
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = transformImage(
    b.native,
    await plan(),
    stream(imageBytes("red.png")),
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow("expired");
  await dispatched;
  controller.abort(new Error("expired"));
  await rejected;
  finish({
    contentType: () => "image/webp",
    image: () => new ReadableStream({ cancel: cancelled }),
  });
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  expect(b.input).toHaveBeenCalledTimes(1);
});

it("uses a conditional full R2 stream and rechecks current authority", async () => {
  const get = vi.fn(async () => body()),
    authorize = vi.fn(async () => {});
  expect(await consume(await openImageObject(bucket(get), object, signal(), authorize))).toEqual(
    imageBytes("red.png"),
  );
  expect(get).toHaveBeenCalledWith(object.key, { onlyIf: { etagMatches: object.etag } });
  expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(5);
});
it.each([
  { etag: "different" },
  { key: "other" },
  { size: 100 },
  { range: { offset: 0, length: 98 } },
])("rejects mismatched R2 identity %j", async (extra) => {
  await expect(
    openImageObject(
      bucket(async () => body(undefined, extra)),
      object,
      signal(),
      async () => {},
    ),
  ).rejects.toThrow("image_source_changed");
});
it.each([-1, 1])("rejects truncated/excess R2 bytes %s", async (delta) => {
  const input = await openImageObject(
    bucket(async () => body(new Uint8Array(99 + delta))),
    object,
    signal(),
    async () => {},
  );
  await expect(consume(input)).rejects.toThrow("image_source_length_mismatch");
});
it("stops R2 delivery when authorization is revoked during a read", async () => {
  let authorized = true;
  const input = await openImageObject(
    bucket(async () => body()),
    object,
    signal(),
    async () => {
      if (!authorized) throw new Error("revoked");
    },
  );
  authorized = false;
  await expect(consume(input)).rejects.toThrow("revoked");
});
it("does not read ahead and bounds a large native chunk to 64 KiB", async () => {
  const reads = vi.fn(),
    bytes = new Uint8Array(150000);
  const input = await openImageObject(
    bucket(async () =>
      body(bytes, {
        size: bytes.length,
        body: new ReadableStream(
          {
            pull(controller) {
              reads();
              controller.enqueue(bytes);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      }),
    ),
    { ...object, size: bytes.length },
    signal(),
    async () => {},
  );
  expect(reads).not.toHaveBeenCalled();
  const reader = input.getReader();
  expect((await reader.read()).value?.length).toBe(65536);
  expect((await reader.read()).value?.length).toBe(65536);
  expect((await reader.read()).value?.length).toBe(18928);
  expect((await reader.read()).done).toBe(true);
  expect(reads).toHaveBeenCalledTimes(1);
});
it("cancels a late R2 response after the caller has timed out", async () => {
  let finish!: (value: unknown) => void;
  const controller = new AbortController(),
    cancelled = vi.fn();
  const get = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = openImageObject(bucket(get), object, controller.signal, async () => {});
  const rejected = expect(pending).rejects.toThrow("expired");
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  controller.abort(new Error("expired"));
  await rejected;
  finish(body(undefined, { body: new ReadableStream({ cancel: cancelled }) }));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
});

it("aborts a pending R2 body read, without waiting for another chunk", async () => {
  const controller = new AbortController(),
    cancelled = vi.fn();
  const input = await openImageObject(
    bucket(async () =>
      body(undefined, {
        body: new ReadableStream({ cancel: cancelled }),
      }),
    ),
    object,
    controller.signal,
    async () => {},
  );
  const reader = input.getReader(),
    pending = reader.read();
  const rejected = expect(pending).rejects.toThrow("expired");
  controller.abort(new Error("expired"));
  await rejected;
  expect(cancelled).toHaveBeenCalledTimes(1);
});
it("bounds an empty-chunk native output without buffering an unbounded list", async () => {
  const b = binding(async (input) => {
    await consume(input);
    return {
      contentType: () => "image/webp",
      image: () =>
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
        }),
    };
  });
  await expect(
    transformImage(b.native, await plan(), stream(imageBytes("red.png")), signal()),
  ).rejects.toThrow("output_chunk_limit");
});
it("bounds empty chunks in the original stream", async () => {
  const b = binding(async (input) => {
    await consume(input);
    return result();
  });
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array());
    },
  });
  await expect(transformImage(b.native, await plan(), input, signal())).rejects.toThrow(
    "image_source_chunk_limit",
  );
});
it("does not hide an unavailable R2 response as an unsupported image", async () => {
  const failure = new Error("R2 unavailable");
  await expect(
    openImageObject(
      bucket(async () => {
        throw failure;
      }),
      object,
      signal(),
      async () => {},
    ),
  ).rejects.toBe(failure);
});
