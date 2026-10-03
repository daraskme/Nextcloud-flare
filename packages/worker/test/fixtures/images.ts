function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function tinyPng(): Uint8Array {
  return decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );
}

export function animatedPngPrefix(): Uint8Array {
  const png = tinyPng();
  const iend = png.length - 12;
  const chunk = new Uint8Array(20);
  new DataView(chunk.buffer).setUint32(0, 8);
  chunk.set(new TextEncoder().encode("acTL"), 4);
  const result = new Uint8Array(png.length + chunk.length);
  result.set(png.subarray(0, iend));
  result.set(chunk, iend);
  result.set(png.subarray(iend), iend + chunk.length);
  return result;
}

/** Byte-for-byte copy of the checked-in 16×12 still fixture for workerd tests. */
export function stillAvif(): Uint8Array {
  return decode(
    "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAADAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoGGAz+2wCAMhEcgAAAWAAAQKPPoquW6wqVKA==",
  );
}

/** Preserve the AVIF bitstream while placing an MPEG-like sync in a valid BMFF free box. */
export function stillAvifWithMpegNoise(): Uint8Array {
  const original = stillAvif();
  const bytes = new Uint8Array(original.length + 12);
  bytes.set(original);
  bytes.set([0, 0, 0, 12, 102, 114, 101, 101, 0xff, 0xfb, 0x90, 0x64], original.length);
  return bytes;
}
