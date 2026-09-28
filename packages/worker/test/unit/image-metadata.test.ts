import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { imageExif } from "../../src/media/images/exif";
import { inspectImage, pngCrc } from "../../src/media/images/inspect";
import { imageObjectSource } from "../../src/media/images/r2Source";
import { IMAGE_METADATA_LIMITS, ImageReader } from "../../src/media/images/reader";

const file = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url)));
const source = (bytes: Uint8Array) => ({
  size: bytes.length,
  read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)),
});
const inspect = (bytes: Uint8Array) => inspectImage(source(bytes));
const text = (value: string) => new TextEncoder().encode(value);
const join = (...chunks: Uint8Array[]) => new Uint8Array(Buffer.concat(chunks));
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const u16 = (n: number) => new Uint8Array([n >>> 8, n & 255]);
const box = (name: string, ...payload: Uint8Array[]) => {
  const bytes = join(...payload);
  return join(u32(bytes.length + 8), text(name), bytes);
};
function chunk(name: string, bytes: Uint8Array) {
  const data = join(text(name), bytes);
  return join(u32(bytes.length), data, u32(pngCrc(data)));
}

it.each([
  ["red.png", "image/png", false],
  ["red.jpg", "image/jpeg", false],
  ["red.webp", "image/webp", false],
  ["red.avif", "image/avif", false],
  ["blue-10bit.avif", "image/avif", false],
  ["sequence.avif", "image/avif", true],
])("extracts dimensions from a real encoded %s", async (name, mime, animated) => {
  expect(await inspect(file(name as string))).toMatchObject({
    mime,
    width: 16,
    height: 12,
    animated,
  });
});
it.each(["red.png", "red.jpg", "red.webp", "red.avif", "blue-10bit.avif", "sequence.avif"])(
  "rejects truncated structural headers in %s",
  async (name) => {
    const bytes = file(name);
    for (let n = 0; n < 60; n++) expect(await inspect(bytes.slice(0, n))).toBeNull();
  },
);
it.each([
  "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
  "<!DOCTYPE html><script>alert(1)</script>",
  "this is named photo.avif but is text",
])("does not classify arbitrary text as an image: %s", async (value) => {
  expect(await inspect(text(value))).toBeNull();
});
it("checks PNG header and metadata CRC, bit depth, dimensions and terminator", async () => {
  const png = file("red.png");
  for (const offset of [16, 24, 26, 29, png.length - 1]) {
    const broken = png.slice();
    broken[offset] = broken[offset]! ^ 1;
    expect(await inspect(broken)).toBeNull();
  }
  const empty = png.slice();
  empty.fill(0, 16, 20);
  new DataView(empty.buffer).setUint32(29, pngCrc(empty.subarray(12, 29)));
  expect(await inspect(empty)).toBeNull();
});
it("marks APNG metadata and refuses duplicate animation controls", async () => {
  const png = file("red.png"),
    control = chunk("acTL", join(u32(2), u32(0)));
  expect(await inspect(join(png.subarray(0, 33), control, png.subarray(33)))).toMatchObject({
    animated: true,
  });
  expect(await inspect(join(png.subarray(0, 33), control, control, png.subarray(33)))).toBeNull();
});
it("skips oversized optional EXIF without losing PNG dimensions", async () => {
  const png = file("red.png");
  const largeExif = chunk("eXIf", new Uint8Array(65537));
  expect(await inspect(join(png.slice(0, 33), largeExif, png.slice(33)))).toEqual({
    mime: "image/png",
    width: 16,
    height: 12,
    animated: false,
  });
});
it("skips a large PNG payload by offset without buffering the file", async () => {
  const header = file("red.png").slice(0, 33),
    payloadSize = 20_000_000;
  const start = join(header, u32(payloadSize), text("IDAT")),
    end = join(u32(0), chunk("IEND", new Uint8Array()));
  const size = start.length + payloadSize + end.length;
  const read = vi.fn(async (offset: number, length: number) => {
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const at = offset + i;
      result[i] =
        at < start.length ? start[at]! : at >= size - end.length ? end[at - size + end.length]! : 0;
    }
    return result;
  });
  expect(await inspectImage({ size, read })).toMatchObject({ mime: "image/png", width: 16 });
  expect(read.mock.calls.length).toBeLessThanOrEqual(2);
  expect(read.mock.calls.reduce((n, [, bytes]) => n + bytes, 0)).toBeLessThan(65537);
});
it("does not use AVIF brands alone or an unrelated item's ispe", async () => {
  const avif = file("red.avif"),
    bytes = Buffer.from(avif);
  const pitm = bytes.indexOf("pitm"),
    ispe = bytes.indexOf("ispe");
  expect(pitm).toBeGreaterThan(0);
  expect(ispe).toBeGreaterThan(0);
  const wrong = avif.slice();
  new DataView(wrong.buffer).setUint16(pitm + 8, 999);
  expect(await inspect(wrong)).toBeNull();
  expect(await inspect(avif.slice(0, new DataView(avif.buffer).getUint32(0)))).toBeNull();
});
function avifHeader(rotation = 0, mirror?: number, grid = false, association = 2) {
  const infe = (id: number, type: string) =>
    box("infe", new Uint8Array([2, 0, 0, 0]), u16(id), u16(0), text(type + "\0"));
  const primaryProps = new Uint8Array([
    association,
    ...(grid ? [] : [3]),
    4,
    ...(mirror === undefined ? [] : [5]),
  ]);
  const associations = box(
    "ipma",
    u32(0),
    u32(grid ? 2 : 1),
    u16(1),
    new Uint8Array([primaryProps.length]),
    primaryProps,
    ...(grid ? [u16(2), new Uint8Array([2, 1, 3])] : []),
  );
  return join(
    box("ftyp", text("avif"), u32(0), text("avifmif1")),
    box(
      "meta",
      u32(0),
      box("pitm", u32(0), u16(1)),
      box(
        "iinf",
        u32(0),
        u16(grid ? 2 : 1),
        infe(1, grid ? "grid" : "av01"),
        ...(grid ? [infe(2, "av01")] : []),
      ),
      box(
        "iprp",
        box(
          "ipco",
          box("ispe", u32(0), u32(1), u32(1)),
          box("ispe", u32(0), u32(120), u32(80)),
          box("av1C", new Uint8Array([0x81, 0, 0x0c, 0])),
          box("irot", new Uint8Array([rotation])),
          ...(mirror === undefined ? [] : [box("imir", new Uint8Array([mirror]))]),
        ),
        associations,
      ),
      ...(grid ? [box("iref", u32(0), box("dimg", u16(1), u16(1), u16(2)))] : []),
    ),
  );
}
it.each([
  [0, 1],
  [1, 8],
  [2, 3],
  [3, 6],
])("reads primary AVIF properties and rotation %s", async (rotation, orientation) => {
  expect(await inspect(avifHeader(rotation))).toMatchObject({
    width: 120,
    height: 80,
    orientation,
  });
});
it.each([
  [0, 2],
  [1, 4],
])("maps the AVIF mirror axis %s", async (axis, orientation) => {
  expect(await inspect(avifHeader(0, axis))).toMatchObject({ width: 120, height: 80, orientation });
});
it("validates a grid's AV1 inputs and uses its own canvas size", async () => {
  expect(await inspect(avifHeader(0, undefined, true))).toMatchObject({ width: 120, height: 80 });
  const wrong = avifHeader(0, undefined, true),
    marker = Buffer.from(wrong).lastIndexOf("av01");
  wrong.set(text("jpeg"), marker);
  expect(await inspect(wrong)).toBeNull();
});
it("rejects out-of-range property references and invalid transformations", async () => {
  expect(await inspect(avifHeader(0, undefined, false, 120))).toBeNull();
  expect(await inspect(avifHeader(4))).toBeNull();
  expect(await inspect(avifHeader(0, 2))).toBeNull();
});
it.each([7, 0xffffffff, 1])("refuses an invalid AVIF box length %s", async (length) => {
  const bytes = file("red.avif"),
    at = Buffer.from(bytes).indexOf("meta") - 4;
  new DataView(bytes.buffer).setUint32(at, length);
  expect(await inspect(bytes)).toBeNull();
});
it("rejects a forged WebP RIFF length or reserved configuration", async () => {
  const bytes = file("red.webp");
  bytes[4] = bytes[4]! ^ 1;
  expect(await inspect(bytes)).toBeNull();
  const avif = file("red.avif"),
    at = Buffer.from(avif).indexOf("av1C") + 4;
  avif[at] = 1;
  expect(await inspect(avif)).toBeNull();
});

function exif(little = true, offset = "+09:00") {
  const bytes = new Uint8Array(256),
    d = new DataView(bytes.buffer);
  bytes.set(text(little ? "II" : "MM"));
  const u16 = (at: number, value: number) => d.setUint16(at, value, little);
  const u32 = (at: number, value: number) => d.setUint32(at, value, little);
  u16(2, 42);
  u32(4, 8);
  u16(8, 5);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    u16(at, tag);
    u16(at + 2, type);
    u32(at + 4, count);
    if (type === 3) u16(at + 8, value);
    else u32(at + 8, value);
  };
  entry(10, 0x112, 3, 1, 6);
  entry(22, 0x10f, 2, 6, 160);
  bytes.set(text("Maker\0"), 160);
  entry(34, 0x110, 2, 7, 168);
  bytes.set(text("Camera\0"), 168);
  entry(46, 0x8769, 4, 1, 80);
  entry(58, 0x8825, 4, 1, 0xffffffff); // Deliberately invalid GPS pointer is never followed.
  u32(70, 0xffffffff); // Neither is the next IFD (embedded thumbnail).
  u16(80, 3);
  entry(82, 0x9003, 2, 20, 184);
  bytes.set(text("2026:09:29 12:34:56\0"), 184);
  entry(94, 0x9011, 2, offset.length + 1, 208);
  bytes.set(text(offset + "\0"), 208);
  entry(106, 0x927c, 7, 0xffffffff, 0xffffffff); // MakerNote is never read.
  return bytes;
}
it.each([true, false])("only retains whitelisted EXIF fields (little endian=%s)", (little) => {
  const parsed = imageExif(exif(little));
  expect(parsed).toEqual({
    orientation: 6,
    cameraMake: "Maker",
    cameraModel: "Camera",
    takenAt: Date.parse("2026-09-29T03:34:56Z"),
  });
  expect(Object.keys(parsed).sort()).toEqual([
    "cameraMake",
    "cameraModel",
    "orientation",
    "takenAt",
  ]);
});
it.each(["", "+99:00", "+14:01", "09:00"])("does not invent a timezone from %s", (offset) => {
  expect(imageExif(exif(true, offset)).takenAt).toBeUndefined();
});
it("drops cyclic, out-of-bounds and oversized EXIF fields", () => {
  const loop = exif();
  new DataView(loop.buffer).setUint32(54, 8, true);
  expect(imageExif(loop)).toEqual({});
  const huge = exif();
  new DataView(huge.buffer).setUint32(26, 0xffffffff, true);
  expect(imageExif(huge)).toEqual({});
  const outside = exif();
  new DataView(outside.buffer).setUint32(30, 0xffffffff, true);
  expect(imageExif(outside)).toEqual({});
  const short = exif().slice(0, 30);
  expect(imageExif(short)).toEqual({});
});
it("extracts the same EXIF whitelist from PNG and JPEG without changing the original", async () => {
  const tags = exif(),
    png = file("red.png"),
    jpg = file("red.jpg");
  const jpegSegment = join(
    new Uint8Array([255, 225, (tags.length + 8) >>> 8, (tags.length + 8) & 255]),
    text("Exif\0\0"),
    tags,
  );
  for (const bytes of [
    join(png.slice(0, 33), chunk("eXIf", tags), png.slice(33)),
    join(jpg.slice(0, 2), jpegSegment, jpg.slice(2)),
  ]) {
    expect(await inspect(bytes)).toMatchObject({ orientation: 6, cameraMake: "Maker", width: 16 });
  }
});
it("keeps storage and native failures retryable, even if a provider throws RangeError", async () => {
  await expect(
    inspectImage({
      size: 100,
      read: async () => {
        throw new RangeError("native failed");
      },
    }),
  ).rejects.toThrow("image_source_unavailable");
  await expect(inspectImage({ size: 100, read: async () => new Uint8Array(99) })).rejects.toThrow(
    "image_source_length_mismatch",
  );
});
it("bounds cache, reads, and parser structure work", async () => {
  const read = vi.fn(async (_: number, n: number) => new Uint8Array(n));
  const r = new ImageReader({ size: 4 * 1024 * 1024, read });
  for (let i = 0; i < 64; i++) await r.read(i * 32768, 1);
  await expect(r.read(64 * 32768, 1)).rejects.toThrow("image_metadata_unavailable");
  expect(read).toHaveBeenCalledTimes(64);
  for (let i = 0; i < IMAGE_METADATA_LIMITS.structures; i++) r.step();
  expect(() => r.step()).toThrow("image_metadata_unavailable");
});

function native(overrides: Record<string, unknown> = {}, body = new Blob(["abcdef"]).stream()) {
  const object = { key: "u/a/b/b", size: 6, etag: "etag" };
  const get = vi.fn(async () => ({
    ...object,
    range: { offset: 0, length: 6 },
    body,
    ...overrides,
  }));
  const controller = new AbortController(),
    authorize = vi.fn(async () => {}),
    budget = { reads: 0, bytes: 0 };
  const source = imageObjectSource(
    { get } as unknown as R2Bucket,
    object,
    controller.signal,
    authorize,
    budget,
  );
  return { source, object, controller, authorize, budget, get };
}
it("conditionally reads and reauthorizes exact native ranges", async () => {
  const t = native();
  expect(await t.source.read(0, 6)).toEqual(text("abcdef"));
  expect(t.get).toHaveBeenCalledWith(t.object.key, {
    onlyIf: { etagMatches: "etag" },
    range: { offset: 0, length: 6 },
  });
  expect(t.authorize).toHaveBeenCalledTimes(2);
  expect(t.budget).toEqual({ reads: 1, bytes: 6 });
});
it.each([
  { key: "wrong" },
  { size: 7 },
  { etag: "changed" },
  { range: { offset: 1, length: 6 } },
  { range: { offset: 0, length: 5 } },
  { range: undefined },
])("rejects a changed native object or range %j", async (overrides) => {
  await expect(native(overrides).source.read(0, 6)).rejects.toThrow("image_source_changed");
});
it.each(["short", "too long"])("rejects a %s native body", async (value) => {
  await expect(native({}, new Blob([value]).stream()).source.read(0, 6)).rejects.toThrow(
    "image_source_length_mismatch",
  );
});
it("stops before dispatch when authority fails or the shared invocation budget is exhausted", async () => {
  const t = native();
  t.authorize.mockRejectedValueOnce(new Error("revoked"));
  await expect(t.source.read(0, 6)).rejects.toThrow("revoked");
  expect(t.get).not.toHaveBeenCalled();
  t.budget.bytes = IMAGE_METADATA_LIMITS.bytes;
  await expect(t.source.read(0, 6)).rejects.toThrow("image_invocation_budget_exceeded");
  expect(t.get).not.toHaveBeenCalled();
});
it("cancels a late native body after deadline without publishing its bytes", async () => {
  const t = native();
  let release!: (value: Awaited<ReturnType<typeof t.get>>) => void;
  t.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = t.source.read(0, 6);
  const rejected = expect(pending).rejects.toThrow("expired");
  await vi.waitFor(() => expect(t.get).toHaveBeenCalled());
  t.controller.abort(new Error("expired"));
  await rejected;
  const cancel = vi.fn();
  release({ ...t.object, range: { offset: 0, length: 6 }, body: new ReadableStream({ cancel }) });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  expect(t.authorize).toHaveBeenCalledTimes(1);
});
