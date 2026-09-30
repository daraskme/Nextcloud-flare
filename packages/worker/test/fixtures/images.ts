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
