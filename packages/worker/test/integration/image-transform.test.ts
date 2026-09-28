import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { inspectImage } from "../../src/media/images/inspect";
import { openImageObject } from "../../src/media/images/objectStream";
import { imageObjectSource } from "../../src/media/images/r2Source";
import { planImageTransform, transformImage } from "../../src/media/images/transform";
import { imageBytes } from "../fixtures/images/encoded";
import { withJpegExif } from "../fixtures/images/metadata";

async function fixture(bytes: Uint8Array) {
  const key = `test-images/${crypto.randomUUID()}`;
  const stored = await env.BLOBS.put(key, bytes);
  if (!stored) throw new Error("fixture_image_missing");
  const object = { key, etag: stored.etag, size: stored.size };
  const controller = new AbortController();
  const authorize = async () => {};
  const source = imageObjectSource(env.BLOBS, object, controller.signal, authorize, {
    reads: 0,
    bytes: 0,
  });
  return { object, controller, authorize, source };
}

it.each(["red.png", "red.jpg", "red.webp", "red.avif", "blue-10bit.avif"] as const)(
  "encodes actual %s bytes through conditional R2 and the offline Images binding",
  async (name) => {
    const original = imageBytes(name),
      f = await fixture(original);
    const plan = await planImageTransform(f.source, "sm");
    const input = await openImageObject(env.BLOBS, f.object, f.controller.signal, f.authorize);
    const output = await transformImage(env.IMAGES, plan, input, f.controller.signal);
    expect(output).toMatchObject({ mime: "image/webp", width: 16, height: 12 });
    expect(await env.IMAGES.info(new Blob([output.bytes]).stream())).toMatchObject({
      format: "image/webp",
      width: 16,
      height: 12,
    });
    // Metadata parsing, native decode and a byte-for-byte original check are independent observations.
    expect(
      await inspectImage({
        size: output.bytes.length,
        read: async (offset, length) => output.bytes.slice(offset, offset + length),
      }),
    ).toEqual({ mime: "image/webp", width: 16, height: 12, animated: false });
    expect(new Uint8Array(await (await env.BLOBS.get(f.object.key))!.arrayBuffer())).toEqual(
      original,
    );
  },
);
it.each([
  ["sm", 256, 144],
  ["md", 768, 432],
  ["lg", 1600, 900],
] as const)("actually resizes a 1920×1080 image to %s", async (variant, width, height) => {
  const f = await fixture(imageBytes("pattern.png"));
  const plan = await planImageTransform(f.source, variant);
  const input = await openImageObject(env.BLOBS, f.object, f.controller.signal, f.authorize);
  const output = await transformImage(env.IMAGES, plan, input, f.controller.signal);
  expect(await env.IMAGES.info(new Blob([output.bytes]).stream())).toMatchObject({
    format: "image/webp",
    width,
    height,
  });
  expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it("rejects an animated AVIF before native transformation", async () => {
  const f = await fixture(imageBytes("sequence.avif"));
  await expect(planImageTransform(f.source, "sm")).rejects.toThrow("unsupported_animation");
});
it("does not adopt bytes replaced between inspection and native input", async () => {
  const f = await fixture(imageBytes("red.png"));
  await planImageTransform(f.source, "sm");
  await env.BLOBS.put(f.object.key, imageBytes("red.jpg"));
  await expect(
    openImageObject(env.BLOBS, f.object, f.controller.signal, f.authorize),
  ).rejects.toThrow("image_source_changed");
});
it("supports an alpha channel without exposing optional metadata", async () => {
  const bytes = imageBytes("alpha.png");
  const f = await fixture(bytes),
    plan = await planImageTransform(f.source, "sm");
  const input = await openImageObject(env.BLOBS, f.object, f.controller.signal, f.authorize);
  const output = await transformImage(env.IMAGES, plan, input, f.controller.signal);
  expect(output).toMatchObject({ width: 16, height: 12, mime: "image/webp" });
  expect(new TextDecoder().decode(output.bytes.subarray(12, 16))).toBe("VP8X");
  expect(output.bytes[20]! & 0x10).toBe(0x10);
  expect(new TextDecoder().decode(output.bytes)).toContain("ALPH");
});

it("re-encodes a real JPEG containing private EXIF without retaining it", async () => {
  const f = await fixture(withJpegExif(imageBytes("red.jpg")));
  const plan = await planImageTransform(f.source, "sm");
  expect(plan.source.cameraMake).toBe("PRIVATE-CAMERA");
  const input = await openImageObject(env.BLOBS, f.object, f.controller.signal, f.authorize);
  const output = await transformImage(env.IMAGES, plan, input, f.controller.signal);
  expect(new TextDecoder().decode(output.bytes)).not.toContain("PRIVATE-CAMERA");
  expect(
    await inspectImage({
      size: output.bytes.length,
      read: async (offset, length) => output.bytes.slice(offset, offset + length),
    }),
  ).toEqual({ mime: "image/webp", width: 16, height: 12, animated: false });
});
