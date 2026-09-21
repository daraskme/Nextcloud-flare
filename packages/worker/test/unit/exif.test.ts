import { describe, expect, it } from "vitest";

import { extractExif } from "../../src/media/images/exif.js";

function fixture(): Uint8Array {
  const bytes = new Uint8Array(72);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe1]);
  view.setUint16(4, 66, false);
  bytes.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  bytes.set([0x49, 0x49], 12);
  view.setUint16(14, 42, true);
  view.setUint32(16, 8, true);
  view.setUint16(20, 2, true);
  view.setUint16(22, 0x0112, true);
  view.setUint16(24, 3, true);
  view.setUint32(26, 1, true);
  view.setUint16(30, 6, true);
  view.setUint16(34, 0x0132, true);
  view.setUint16(36, 2, true);
  view.setUint32(38, 20, true);
  view.setUint32(42, 38, true);
  bytes.set(new TextEncoder().encode("2024:01:02 03:04:05\0"), 50);
  bytes.set([0xff, 0xd9], 70);
  return bytes;
}

describe("bounded EXIF extraction", () => {
  it("extracts only approved image metadata", () => {
    expect(extractExif(fixture())).toEqual({
      takenAt: Date.UTC(2024, 0, 2, 3, 4, 5),
      orientation: 6,
      cameraMake: null,
      cameraModel: null,
    });
  });

  it("fails closed on malformed input", () => {
    expect(extractExif(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({
      takenAt: null,
      orientation: null,
      cameraMake: null,
      cameraModel: null,
    });
  });
});
