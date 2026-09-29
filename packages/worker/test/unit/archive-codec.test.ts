import { expect, it } from "vitest";
import { decodeArchiveIndex, encodeArchiveIndex } from "../../src/media/archive/codec";
import { inspectArchive } from "../../src/media/archive/index";
import { hex } from "../../src/platform/stream";
import { archiveFixture, memoryArchive } from "../fixtures/archive";

async function fixture() {
  const source = memoryArchive(archiveFixture([{ name: "p2.png" }, { name: "p1.jpg" }]).bytes);
  const original = {
    ownerId: "owner",
    blobId: "blob",
    key: "u/owner/b/blob",
    size: source.size,
    etag: "immutable",
  };
  const index = await inspectArchive(source),
    output = await encodeArchiveIndex(index, original);
  return { original, index, output };
}

it("round-trips a canonical immutable index bound to the original object tuple", async () => {
  const f = await fixture(),
    index = await decodeArchiveIndex(f.output.bytes, f.original, f.output.sha256);
  expect(index).toEqual(f.index);
  expect(Object.isFrozen(index.entries[0])).toBe(true);
  expect(await encodeArchiveIndex(index, f.original)).toEqual(f.output);
});

it.each(["owner", "blob", "size", "etag", "key"])(
  "rejects an index for another original %s",
  async (change) => {
    const f = await fixture(),
      original = { ...f.original };
    if (change === "owner") {
      original.ownerId = "other";
      original.key = "u/other/b/blob";
    }
    if (change === "blob") {
      original.blobId = "other";
      original.key = "u/owner/b/other";
    }
    if (change === "size") original.size++;
    if (change === "etag") original.etag = "changed";
    if (change === "key") original.key = "u/owner/b/other";
    await expect(decodeArchiveIndex(f.output.bytes, original, f.output.sha256)).rejects.toThrow();
  },
);

it("rejects modified bytes and over-limit JSON before parsing", async () => {
  const f = await fixture(),
    bytes = f.output.bytes.slice();
  bytes[10] = bytes[10]! ^ 1;
  await expect(decodeArchiveIndex(bytes, f.original, f.output.sha256)).rejects.toThrow(
    "archive_index_checksum_mismatch",
  );
  await expect(
    decodeArchiveIndex(new Uint8Array(8_388_609), f.original, f.output.sha256),
  ).rejects.toThrow("invalid_archive_index");
});

it.each([
  "unknown",
  "path",
  "rawName",
  "rawUtf8",
  "unsafe",
  "overlap",
  "pages",
  "duplicate",
  "flags",
  "crc",
  "directory",
  "size",
  "version",
])("rejects malformed persisted %s even with a matching checksum", async (change) => {
  const f = await fixture(),
    value = JSON.parse(new TextDecoder().decode(f.output.bytes)),
    entry = value.index.entries[0];
  if (change === "unknown") value.extra = true;
  if (change === "path") entry.path = "../bad.jpg";
  if (change === "rawName") entry.rawName = "not!base64";
  if (change === "rawUtf8") entry.rawName = btoa(String.fromCharCode(0xc0, 0xaf));
  if (change === "unsafe") entry.localOffset = Number.MAX_SAFE_INTEGER + 1;
  if (change === "overlap") entry.endOffset++;
  if (change === "pages") value.index.pages.reverse();
  if (change === "duplicate") value.index.entries[1] = entry;
  if (change === "flags") entry.flags |= 1;
  if (change === "crc") entry.crc32 = 1.5;
  if (change === "directory") entry.directory = true;
  if (change === "size") entry.size = 67_108_865;
  if (change === "version") value.index.version = "future";
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  await expect(
    decodeArchiveIndex(bytes, f.original, hex(await crypto.subtle.digest("SHA-256", bytes))),
  ).rejects.toThrow();
});
