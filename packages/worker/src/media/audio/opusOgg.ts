// RFC 7845 §§3, 5.1: identify Opus from its complete first Ogg page, never
// from a filename or an OpusHead string found at an arbitrary byte offset.
// This is bounded metadata validation, not a full audio-stream decoder.
const MAX_PREFIX_BYTES = 4 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

function malformed(): never {
  throw new Error("malformed_opus_ogg");
}

export function parseOpusOgg(prefix: Uint8Array): void {
  if (prefix.byteLength < 28 || prefix.byteLength > MAX_PREFIX_BYTES) malformed();
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  // Ogg version 0, beginning-of-stream only, zero granule and page sequence.
  if (
    view.getUint32(0) !== 0x4f676753 ||
    prefix[4] !== 0 ||
    prefix[5] !== 2 ||
    view.getUint32(6) !== 0 ||
    view.getUint32(10) !== 0 ||
    view.getUint32(18) !== 0
  )
    malformed();
  const segments = prefix[26]!;
  const start = 27 + segments;
  if (segments === 0 || start > prefix.length) malformed();
  let size = 0;
  for (let index = 0; index < segments; index++) {
    const length = prefix[27 + index]!;
    // Exactly one packet must complete on the identification page.
    if (index < segments - 1 ? length !== 255 : length === 255) malformed();
    size += length;
  }
  const end = start + size;
  if (size < 19 || end > prefix.length) malformed();
  let crc = 0;
  for (let index = 0; index < end; index++) {
    const value = index >= 22 && index < 26 ? 0 : prefix[index]!;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ value) & 255]!) >>> 0;
  }
  if (crc !== view.getUint32(22, true)) malformed();
  parseOpusHead(prefix.subarray(start, end));
}

/** Shared by Ogg identification pages and WebM Opus CodecPrivate data. */
export function parseOpusHead(packet: Uint8Array): void {
  const size = packet.byteLength;
  if (size < 19 || size > 65_025) malformed();
  if (
    ![0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64].every(
      (value, index) => packet[index] === value,
    ) ||
    packet[8]! > 15 ||
    packet[9] === 0
  )
    malformed();
  const version = packet[8]!;
  const channels = packet[9]!;
  const family = packet[18]!;
  if (family === 0) {
    if (channels > 2 || (version <= 1 && size !== 19)) malformed();
    return;
  }
  // Mapping families with no supported speaker interpretation are not offered
  // for native playback. Mono/stereo and standard surround are supported.
  if (family !== 1) throw new Error("unsupported_opus_ogg");
  if (channels > 8 || size < 21 + channels || (version <= 1 && size !== 21 + channels)) malformed();
  const streams = packet[19]!;
  const coupled = packet[20]!;
  if (streams === 0 || coupled > streams || streams + coupled > 255) malformed();
  for (const index of packet.subarray(21, 21 + channels))
    if (index !== 255 && index >= streams + coupled) malformed();
}
