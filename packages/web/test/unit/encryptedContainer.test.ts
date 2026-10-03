import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRecipientVault, PLAIN_CHUNK_BYTES } from "../../src/lib/cryptoEnvelope";
import {
  authenticateContainerMetadata,
  type ContainerWriterFactory,
  cleanupStaleOpfsContainers,
  createEncryptedContainer,
  decryptContainerPlainRange,
  openContainerHeader,
  parseContainerHeader,
  planContainerPlainRange,
  readContainerHeader,
  readContainerHeaderLength,
} from "../../src/lib/encryptedContainer";

function memoryWriter(): {
  factory: ContainerWriterFactory;
  state: { discarded: boolean; writes: number };
} {
  const state = { discarded: false, writes: 0 };
  const factory: ContainerWriterFactory = async (name) => {
    const pieces: Uint8Array[] = [];
    return {
      async write(bytes) {
        state.writes++;
        pieces.push(new Uint8Array(bytes));
      },
      async close() {
        return new File(
          pieces.map((piece) => new Uint8Array(piece)),
          name,
          { type: "application/octet-stream" },
        );
      },
      async discard() {
        state.discarded = true;
      },
    };
  };
  return { factory, state };
}

describe("self-contained encrypted file container draft", () => {
  let owner: Awaited<ReturnType<typeof createRecipientVault>>;
  let admin: Awaited<ReturnType<typeof createRecipientVault>>;
  beforeAll(async () => {
    owner = await createRecipientVault("owner_user");
    admin = await createRecipientVault("admin_user");
  }, 30_000);

  it("writes only ciphertext and lets owner/admin authenticate metadata and aligned ranges", async () => {
    const plain = new Uint8Array(PLAIN_CHUNK_BYTES + 7);
    plain[0] = 5;
    plain[PLAIN_CHUNK_BYTES - 1] = 17;
    plain[plain.length - 1] = 29;
    const source = new File([plain], "secret-video.mp4", {
      type: "video/mp4",
      lastModified: 12345,
    });
    const writer = memoryWriter();
    const created = await createEncryptedContainer(
      source,
      [owner.unlocked.publicKey, admin.unlocked.publicKey],
      writer.factory,
    );
    expect(created.file.name).toMatch(/^[A-Za-z0-9_-]{22}\.ncf$/);
    expect(created.file.size).toBe(created.header.totalBytes);
    expect(writer.state.writes).toBe(3); // header and two authenticated 4 MiB chunks
    const header = await readContainerHeader(created.file);
    expect(header).toEqual(created.header);
    const originalHeader = new Uint8Array(
      await created.file.slice(0, header.headerEnd).arrayBuffer(),
    );
    expect(new TextDecoder().decode(originalHeader)).not.toContain("secret-video.mp4");
    expect(readContainerHeaderLength(originalHeader.subarray(0, 12))).toBe(header.headerEnd - 12);
    expect(parseContainerHeader(originalHeader)).toEqual(header);
    const openedOwner = await openContainerHeader(header, owner.unlocked);
    const openedAdmin = await openContainerHeader(header, admin.unlocked);
    expect(openedOwner.metadata).toEqual({
      name: "secret-video.mp4",
      mime: "video/mp4",
      lastModified: 12345,
    });
    expect(openedAdmin.metadata).toEqual(openedOwner.metadata);
    expect(await authenticateContainerMetadata(header, openedOwner.cipher)).toEqual(
      openedOwner.metadata,
    );
    const ranges = [...planContainerPlainRange(header, PLAIN_CHUNK_BYTES - 1, 8)];
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.cipherOffset).toBe(header.headerEnd);
    expect(ranges[1]!.cipherOffset).toBe(header.headerEnd + PLAIN_CHUNK_BYTES + 28);
    const pieces = [];
    for await (const piece of decryptContainerPlainRange(
      openedAdmin,
      PLAIN_CHUNK_BYTES - 1,
      8,
      async (range) =>
        new Uint8Array(
          await created.file
            .slice(range.cipherOffset, range.cipherOffset + range.cipherLength)
            .arrayBuffer(),
        ),
    ))
      pieces.push(piece);
    expect([...pieces[0]!, ...pieces[1]!]).toEqual([...plain.subarray(PLAIN_CHUNK_BYTES - 1)]);
    await created.discard();
    expect(writer.state.discarded).toBe(true);
  }, 30_000);

  it("authenticates an empty file and rejects truncated or extended body", async () => {
    const source = new File([], "empty.bin", { type: "application/octet-stream", lastModified: 0 });
    const created = await createEncryptedContainer(
      source,
      [owner.unlocked.publicKey],
      memoryWriter().factory,
    );
    expect(created.file.size).toBe(created.header.headerEnd + 28);
    const opened = await openContainerHeader(created.header, owner.unlocked);
    const parts = [];
    for await (const part of decryptContainerPlainRange(
      opened,
      0,
      0,
      async (range) =>
        new Uint8Array(
          await created.file
            .slice(range.cipherOffset, range.cipherOffset + range.cipherLength)
            .arrayBuffer(),
        ),
    ))
      parts.push(part);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(0);
    await expect(readContainerHeader(created.file.slice(0, -1))).rejects.toThrow();
    await expect(
      readContainerHeader(new Blob([created.file, new Uint8Array([0])])),
    ).rejects.toThrow();
    await expect(
      decryptContainerPlainRange(
        opened,
        0,
        0,
        async (range) =>
          new Uint8Array(
            await created.file
              .slice(range.cipherOffset, range.cipherOffset + range.cipherLength - 1)
              .arrayBuffer(),
          ),
      ).next(),
    ).rejects.toThrow();
  }, 30_000);

  it("normalizes Chromium's M4A audio MIME inside encrypted metadata", async () => {
    for (const mime of ["audio/x-m4a", "audio/m4a"]) {
      const source = new File([Uint8Array.from([1, 2, 3])], "owner-audio.m4a", { type: mime });
      const created = await createEncryptedContainer(
        source,
        [owner.unlocked.publicKey],
        memoryWriter().factory,
      );
      const headerBytes = new Uint8Array(
        await created.file.slice(0, created.header.headerEnd).arrayBuffer(),
      );
      expect(new TextDecoder().decode(headerBytes)).not.toContain("owner-audio.m4a");
      const opened = await openContainerHeader(created.header, owner.unlocked);
      expect(opened.metadata).toMatchObject({ name: "owner-audio.m4a", mime: "audio/mp4" });
    }
  }, 30_000);

  it("rejects header tampering, metadata tampering, unrelated keys, and incomplete writes", async () => {
    const source = new File([Uint8Array.from([1, 2, 3])], "private.txt", {
      type: "text/plain",
      lastModified: 1,
    });
    const created = await createEncryptedContainer(
      source,
      [owner.unlocked.publicKey],
      memoryWriter().factory,
    );
    const headerBytes = new Uint8Array(
      await created.file.slice(0, created.header.headerEnd).arrayBuffer(),
    );
    await expect(openContainerHeader(created.header, admin.unlocked)).rejects.toThrow();
    const badHeader = {
      ...created.header,
      encryptedMetadata: {
        ...created.header.encryptedMetadata,
        data: created.header.encryptedMetadata.data.replace(
          /^./,
          created.header.encryptedMetadata.data[0] === "A" ? "B" : "A",
        ),
      },
    };
    await expect(openContainerHeader(badHeader, owner.unlocked)).rejects.toThrow();
    const changedMagic = headerBytes.slice();
    changedMagic[0] = changedMagic[0]! ^ 1;
    expect(() => parseContainerHeader(changedMagic)).toThrow();
    expect(() => parseContainerHeader(headerBytes.subarray(0, -1))).toThrow();
    const tooLong = headerBytes.slice();
    new DataView(tooLong.buffer).setUint32(8, 16_385, false);
    expect(() => readContainerHeaderLength(tooLong.subarray(0, 12))).toThrow();

    const failed = { discarded: false };
    const factory: ContainerWriterFactory = async () => ({
      async write() {
        throw new Error("storage_failed");
      },
      async close() {
        throw new Error("unexpected_close");
      },
      async discard() {
        failed.discarded = true;
      },
    });
    await expect(
      createEncryptedContainer(source, [owner.unlocked.publicKey], factory),
    ).rejects.toThrow("storage_failed");
    expect(failed.discarded).toBe(true);
    const controller = new AbortController();
    const aborted = { discarded: false };
    const abortFactory: ContainerWriterFactory = async (name) => {
      const pieces: Uint8Array[] = [];
      return {
        async write(bytes) {
          pieces.push(new Uint8Array(bytes));
          controller.abort();
        },
        async close() {
          return new File(
            pieces.map((piece) => new Uint8Array(piece)),
            name,
          );
        },
        async discard() {
          aborted.discarded = true;
        },
      };
    };
    await expect(
      createEncryptedContainer(source, [owner.unlocked.publicKey], abortFactory, controller.signal),
    ).rejects.toThrow();
    expect(aborted.discarded).toBe(true);
  }, 30_000);

  it("reclaims only old unreferenced OPFS ciphertext while holding the cross-tab lock", async () => {
    const now = 200_000_000;
    const names = ["A".repeat(22), "B".repeat(22), "C".repeat(22)].map((id) => `${id}.ncf`);
    const removed: string[] = [];
    let lockHeld = false;
    const directory = {
      async *keys() {
        yield* names;
      },
      async getFileHandle(name: string) {
        return {
          async getFile() {
            return { lastModified: name === names[2] ? now - 1000 : now - 90_000_000 };
          },
        };
      },
      async removeEntry(name: string) {
        expect(lockHeld).toBe(true);
        removed.push(name);
      },
    };
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
      locks: {
        async request(
          _name: string,
          _options: unknown,
          callback: (lock: object) => Promise<number>,
        ) {
          lockHeld = true;
          try {
            return await callback({});
          } finally {
            lockHeld = false;
          }
        },
      },
    });
    try {
      expect(await cleanupStaleOpfsContainers(new Set([names[0]!]), now)).toBe(1);
      expect(removed).toEqual([names[1]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
