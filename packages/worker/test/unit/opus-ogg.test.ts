import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { parseOpusOgg } from "../../src/media/audio/opusOgg";

const fixture = new Uint8Array(
  readFileSync(new URL("../fixtures/browser-e2e-opus.ogg", import.meta.url)),
);
const head = () => fixture.slice(28, 47);

// Bitwise fixture checksum, separate from the parser's lookup-table algorithm.
function checksum(bytes: Uint8Array) {
  bytes.fill(0, 22, 26);
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(22, crc >>> 0, true);
  return bytes;
}

function page(packet = head()) {
  const lacing = [...Array(Math.floor(packet.length / 255)).fill(255), packet.length % 255];
  const bytes = new Uint8Array(27 + lacing.length + packet.length);
  bytes.set([79, 103, 103, 83, 0, 2]);
  bytes[26] = lacing.length;
  bytes.set(lacing, 27);
  bytes.set(packet, 27 + lacing.length);
  return checksum(bytes);
}

it("identifies a real encoded Ogg Opus file and a bounded prefix", () => {
  expect(() => parseOpusOgg(fixture)).not.toThrow();
  expect(() => parseOpusOgg(fixture.subarray(0, 47))).not.toThrow();
  const offsetBuffer = new Uint8Array(fixture.length + 5);
  offsetBuffer.set(fixture, 5);
  expect(() => parseOpusOgg(offsetBuffer.subarray(5))).not.toThrow();
});

it("rejects every truncated identification page and an oversized input", () => {
  for (let length = 0; length < 47; length++)
    expect(() => parseOpusOgg(fixture.subarray(0, length))).toThrow();
  expect(() => parseOpusOgg(new Uint8Array(4 * 1024 * 1024 + 1))).toThrow();
});

it("rejects corrupted CRC, non-BOS, continued, EOS, granule and sequence fields", () => {
  const corrupt = page();
  corrupt[32] = corrupt[32]! ^ 1;
  expect(() => parseOpusOgg(corrupt)).toThrow();
  for (const [offset, value] of [
    [4, 1],
    [5, 0],
    [5, 3],
    [5, 6],
    [6, 1],
    [18, 1],
  ]) {
    const bytes = page();
    bytes[offset!] = value!;
    expect(() => parseOpusOgg(checksum(bytes))).toThrow();
  }
});

it("requires a complete single packet rather than a magic string or container alone", () => {
  const bytes = page();
  bytes[27] = 255;
  expect(() => parseOpusOgg(checksum(bytes))).toThrow();
  const twoPackets = new Uint8Array(48);
  twoPackets.set(page().subarray(0, 27));
  twoPackets[26] = 2;
  twoPackets.set([10, 9], 27);
  twoPackets.set(head(), 29);
  expect(() => parseOpusOgg(checksum(twoPackets))).toThrow();
  const wrongMagic = head();
  wrongMagic[0] = 0;
  expect(() => parseOpusOgg(page(wrongMagic))).toThrow();
});

it("validates Opus version, channels and supported channel mappings", () => {
  for (const channels of [1, 2]) {
    const packet = head();
    packet[9] = channels;
    expect(() => parseOpusOgg(page(packet))).not.toThrow();
  }
  for (const [offset, value] of [
    [8, 16],
    [9, 0],
    [9, 3],
    [18, 2],
  ]) {
    const packet = head();
    packet[offset!] = value!;
    expect(() => parseOpusOgg(page(packet))).toThrow();
  }
  const surround = new Uint8Array(27);
  surround.set(head());
  surround[9] = 6;
  surround.set([1, 4, 2, 0, 4, 1, 2, 3, 5], 18);
  expect(() => parseOpusOgg(page(surround))).not.toThrow();
  for (const [offset, value] of [
    [19, 0],
    [20, 5],
    [21, 6],
  ]) {
    const packet = surround.slice();
    packet[offset!] = value!;
    expect(() => parseOpusOgg(page(packet))).toThrow();
  }
  expect(() => parseOpusOgg(page(surround.subarray(0, 26)))).toThrow();
});

it("accepts compatible future minor versions with complete extended headers", () => {
  const extended = new Uint8Array(300);
  extended.set(head());
  extended[8] = 15;
  expect(() => parseOpusOgg(page(extended))).not.toThrow();
  extended[8] = 1;
  expect(() => parseOpusOgg(page(extended))).toThrow();
});
