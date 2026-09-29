import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { openArchiveEntry } from "../../src/media/archive/entry";
import { ARCHIVE_LIMITS, crc32 } from "../../src/media/archive/format";
import { inspectArchive } from "../../src/media/archive/index";
import { archiveObjectSource } from "../../src/media/archive/r2Source";
import { storeZip } from "../../src/platform/storeZip";
import { archiveFixture, archiveText } from "../fixtures/archive";

async function saved(bytes: Uint8Array, authorize: () => Promise<void> = async () => {}) {
  const key = `archive-test/${crypto.randomUUID()}`,
    object = await env.BLOBS.put(key, bytes);
  if (!object) throw new Error("fixture_put_failed");
  const abort = new AbortController();
  const budget = { reads: 0, bytes: 0, maxReads: 30, maxBytes: 100_000_000 };
  const checkpoint = async () => {
    abort.signal.throwIfAborted();
    await authorize();
    abort.signal.throwIfAborted();
  };
  const source = archiveObjectSource(env.BLOBS, object, abort.signal, authorize, budget);
  return { key, source, budget, abort, checkpoint };
}

it.each([0, 8])(
  "reads method %i with native R2 ranges and native decompression",
  async (method) => {
    const fixture = archiveFixture(
        [{ method, zip64: true, descriptor: "signed", name: "書籍/1.avif" }],
        true,
      ),
      s = await saved(fixture.bytes);
    try {
      const index = await inspectArchive(s.source),
        body = await openArchiveEntry(s.source, index, 0, s.checkpoint);
      expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(archiveText);
      expect(index.entries[0]!.path).toBe("書籍/1.avif");
      expect(s.budget.reads).toBe(6); // EOCD, local header/name, descriptor + signature, data.
    } finally {
      await env.BLOBS.delete(s.key);
    }
  },
);

it("opens this application's streaming STORE export with descriptors", async () => {
  const zip = storeZip([
    {
      name: "書籍/1.jpg",
      size: archiveText.length,
      open: async () => new Response(archiveText).body!,
    },
  ]);
  const s = await saved(new Uint8Array(await new Response(zip.body).arrayBuffer()));
  try {
    const index = await inspectArchive(s.source);
    expect(
      new Uint8Array(
        await new Response(await openArchiveEntry(s.source, index, 0, s.checkpoint)).arrayBuffer(),
      ),
    ).toEqual(archiveText);
  } finally {
    await env.BLOBS.delete(s.key);
  }
});

it("enforces the full 64 MiB output boundary in native DEFLATE with bounded delivery", async () => {
  const content = new Uint8Array(ARCHIVE_LIMITS.entryBytes),
    fixture = archiveFixture([{ method: 8, content }]),
    s = await saved(fixture.bytes);
  try {
    const index = await inspectArchive(s.source),
      reader = (await openArchiveEntry(s.source, index, 0, s.checkpoint)).getReader();
    let count = 0,
      crc = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.length).toBeLessThanOrEqual(65536);
      count += next.value.length;
      crc = crc32(next.value, crc);
    }
    expect(count).toBe(ARCHIVE_LIMITS.entryBytes);
    expect(crc).toBe(index.entries[0]!.crc32);
    expect(s.budget.bytes).toBeLessThan(1_000_000);
  } finally {
    await env.BLOBS.delete(s.key);
  }
});

it.each(["crc", "bomb", "truncated", "trailing"])(
  "errors the native stream for %s corruption",
  async (kind) => {
    const compressed =
      kind === "truncated"
        ? new Uint8Array([3])
        : kind === "trailing"
          ? new Uint8Array([3, 0, 0])
          : undefined;
    const fixture = archiveFixture([
      {
        method: 8,
        ...(kind === "crc" ? { crc: 1 } : {}),
        ...(kind === "bomb" ? { content: new Uint8Array(1_048_576), size: 1 } : {}),
        ...(compressed ? { compressed, content: new Uint8Array() } : {}),
      },
    ]);
    const s = await saved(fixture.bytes);
    try {
      const index = await inspectArchive(s.source),
        stream = await openArchiveEntry(s.source, index, 0, s.checkpoint);
      await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
    } finally {
      await env.BLOBS.delete(s.key);
    }
  },
);

it("rejects a changed original using native R2 conditional Range", async () => {
  const s = await saved(archiveFixture().bytes);
  try {
    const index = await inspectArchive(s.source);
    await env.BLOBS.put(s.key, archiveFixture([{ name: "different.jpg" }]).bytes);
    await expect(openArchiveEntry(s.source, index, 0, s.checkpoint)).rejects.toThrow(
      "archive_source_changed",
    );
  } finally {
    await env.BLOBS.delete(s.key);
  }
});

it("stops native decoder output after current authority is revoked", async () => {
  let authorized = true;
  const s = await saved(
    archiveFixture([{ method: 8, content: new Uint8Array(1_048_576) }]).bytes,
    async () => {
      if (!authorized) throw new Error("revoked");
    },
  );
  try {
    const index = await inspectArchive(s.source),
      reader = (await openArchiveEntry(s.source, index, 0, s.checkpoint)).getReader();
    expect((await reader.read()).done).toBe(false);
    authorized = false;
    await expect(reader.read()).rejects.toThrow("revoked");
  } finally {
    await env.BLOBS.delete(s.key);
  }
});

it("stops buffered native output when the caller aborts the operation", async () => {
  const s = await saved(archiveFixture([{ method: 8, content: new Uint8Array(1_048_576) }]).bytes);
  try {
    const index = await inspectArchive(s.source),
      reader = (await openArchiveEntry(s.source, index, 0, s.checkpoint)).getReader();
    expect((await reader.read()).done).toBe(false);
    s.abort.abort(new Error("deadline"));
    await expect(reader.read()).rejects.toThrow("deadline");
  } finally {
    await env.BLOBS.delete(s.key);
  }
});
