import { describe, expect, it, vi } from "vitest";
import { inspectAudioObject } from "../../src/media/audio";
import { inspectImage } from "../../src/media/images/metadata";
import { inspectOpusObject, inspectVideoObject } from "../../src/media/video";

describe("encrypted container media isolation", () => {
  it("does not interpret an ID3-looking ciphertext tail as plaintext metadata", async () => {
    const bytes = new Uint8Array(256);
    bytes.set(new TextEncoder().encode("NCFENC1\0"));
    bytes.set(new TextEncoder().encode("TAGciphertext is not a title"), 128);
    const bucket = {
      get: async () => ({
        size: bytes.length,
        etag: "cipher-etag",
        arrayBuffer: async () => bytes.buffer,
      }),
    } as unknown as R2Bucket;
    expect(
      (
        await inspectAudioObject(
          bucket,
          { key: "opaque", size: bytes.length, r2Etag: "cipher-etag" },
          Date.now() + 10_000,
        )
      ).kind,
    ).toBe("unsupported");
  });
  it("does not project encrypted bytes as image, audio, or video", async () => {
    const bytes = new Uint8Array(128);
    bytes.set(new TextEncoder().encode("NCFENC1\0"));
    crypto.getRandomValues(bytes.subarray(12));
    const info = vi.fn();
    expect(await inspectImage({ info } as unknown as ImagesBinding, bytes)).toBeNull();
    expect(info).not.toHaveBeenCalled();

    const get = vi.fn(
      async (_key: string, options?: { range?: { offset: number; length: number } }) => {
        const offset = options?.range?.offset ?? 0;
        const length = options?.range?.length ?? bytes.length;
        return {
          size: bytes.length,
          etag: "cipher-etag",
          arrayBuffer: async () => bytes.slice(offset, offset + length).buffer,
        };
      },
    );
    const bucket = { get } as unknown as R2Bucket;
    const source = { key: "ciphertext", size: bytes.length, r2Etag: "cipher-etag" };
    const deadline = Date.now() + 10_000;
    expect((await inspectAudioObject(bucket, source, deadline)).kind).toBe("unsupported");
    expect((await inspectOpusObject(bucket, source, deadline)).kind).toBe("unsupported");
    expect((await inspectVideoObject(bucket, source, deadline)).kind).toBe("not-video");
  });
});
