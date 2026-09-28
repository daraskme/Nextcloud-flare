/** Small synthetic IFD0 for privacy/orientation tests, attached to an actual JPEG. */
export function withJpegExif(jpeg: Uint8Array, orientation = 1) {
  const make = new TextEncoder().encode("PRIVATE-CAMERA\0"),
    tiff = new Uint8Array(38 + make.length),
    data = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  data.setUint16(8, 2, true);
  data.setUint16(10, 0x112, true);
  data.setUint16(12, 3, true);
  data.setUint32(14, 1, true);
  data.setUint16(18, orientation, true);
  data.setUint16(22, 0x10f, true);
  data.setUint16(24, 2, true);
  data.setUint32(26, make.length, true);
  data.setUint32(30, 38, true);
  tiff.set(make, 38);
  const bytes = new Uint8Array(jpeg.length + 10 + tiff.length);
  bytes.set(jpeg.subarray(0, 2));
  bytes.set([255, 225, 0, tiff.length + 8, 69, 120, 105, 102, 0, 0], 2);
  bytes.set(tiff, 12);
  bytes.set(jpeg.subarray(2), 12 + tiff.length);
  return bytes;
}
