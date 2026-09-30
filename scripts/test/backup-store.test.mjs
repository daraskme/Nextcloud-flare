import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_BYTES,
  digest,
  manifestKey,
  partKey,
  S3BackupStore,
} from "../backup/objectStore.mjs";

const config = {
  R2_BACKUP_ACCOUNT_ID: "a".repeat(32),
  R2_BACKUP_BUCKET: "private-backups",
  R2_BACKUP_ACCESS_KEY_ID: "testkey1234567890",
  R2_BACKUP_SECRET_ACCESS_KEY: "secret".repeat(8),
};
const id = "12345678-1234-1234-1234-123456789012",
  key = manifestKey(id);
describe("R2 backup S3 transport", () => {
  it("signs exact conditional PUT bytes with private endpoint, length and checksums", async () => {
    const bytes = Buffer.from("export"),
      fetch = vi.fn(async (request) => {
        expect(request.url).toBe(
          `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-backups/${key}`,
        );
        expect(request.method).toBe("PUT");
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("if-none-match")).toBe("*");
        expect(request.headers.get("content-length")).toBe("6");
        expect(request.headers.get("x-amz-content-sha256")).toBe(digest(bytes));
        expect(request.headers.get("authorization")).toMatch(/Credential=testkey1234567890\//);
        expect(Buffer.from(await request.arrayBuffer())).toEqual(bytes);
        return new Response("");
      });
    expect(await new S3BackupStore(config, { fetch }).put(key, bytes)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 403, 429, 500, 503])(
    "rejects HTTP %i without following or retrying",
    async (status) => {
      const cancel = vi.fn(),
        fetch = vi.fn(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              status,
              headers: { Location: "https://attacker.invalid" },
            }),
        );
      await expect(new S3BackupStore(config, { fetch }).get(key, 1024)).rejects.toThrow(
        `backup_store_http_${status}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it("distinguishes only GET404 as absence and PUT412 as a conditional conflict", async () => {
    expect(
      await new S3BackupStore(config, {
        fetch: async () => new Response(null, { status: 404 }),
      }).get(key, 1),
    ).toBeNull();
    expect(
      await new S3BackupStore(config, {
        fetch: async () => new Response(null, { status: 412 }),
      }).put(key, Buffer.from("x")),
    ).toBe(false);
    await expect(
      new S3BackupStore(config, { fetch: async () => new Response(null, { status: 404 }) }).put(
        key,
        Buffer.from("x"),
      ),
    ).rejects.toThrow("backup_store_http_404");
  });
  it("redacts credentials and upstream transport messages", async () => {
    const store = new S3BackupStore(config, {
      fetch: async () => {
        throw new Error(config.R2_BACKUP_SECRET_ACCESS_KEY);
      },
    });
    await expect(store.get(key, 1)).rejects.toThrow(/^backup_store_unavailable$/);
  });
  it.each([
    "sys/epoch/1.json",
    "sys/backups/v1/../manifest.json",
    key + "?secret=x",
    "https://attacker.invalid/",
    `sys/backups/v1/${id}/parts/131072-${"a".repeat(64)}.bin`,
  ])("does not dispatch to a key outside the protocol: %s", async (invalid) => {
    const fetch = vi.fn(),
      store = new S3BackupStore(config, { fetch });
    await expect(store.get(invalid, 1)).rejects.toThrow("backup_invalid_object_key");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects missing configuration and invalid part identities", () => {
    expect(() => new S3BackupStore({})).toThrow("backup_store_unconfigured");
    expect(() => partKey(id, -1, "a".repeat(64))).toThrow();
    expect(() => partKey(id, 0, "../bad")).toThrow();
  });
  it("rejects an oversized part before dispatch while preserving the larger manifest limit", async () => {
    const fetch = vi.fn(async () => new Response(null)),
      store = new S3BackupStore(config, { fetch }),
      bytes = Buffer.alloc(CHUNK_BYTES + 1);
    expect(() => store.put(partKey(id, 0, digest(bytes)), bytes)).toThrow("backup_object_size");
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.put(key, bytes)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["declared", "streamed", "truncated"])("bounds %s object bodies", async (kind) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        if (kind === "streamed") controller.enqueue(Buffer.from("too big"));
        if (kind === "truncated") controller.close();
      },
      cancel,
    });
    const fetch = async () =>
      new Response(stream, {
        headers:
          kind === "streamed" ? {} : { "Content-Length": kind === "declared" ? "1025" : "1" },
      });
    await expect(new S3BackupStore(config, { fetch }).get(key, 2)).rejects.toThrow(
      "backup_object_size",
    );
    if (kind !== "truncated") expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("aborts a dispatched request at its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let start, signal;
      const pending = new Promise((resolve) => {
        start = resolve;
      });
      const fetch = vi.fn((request) => {
        signal = request.signal;
        start();
        return new Promise(() => {});
      });
      const rejected = expect(
        new S3BackupStore(config, { fetch, timeoutMs: 20 }).get(key, 1),
      ).rejects.toThrow("backup_store_timeout");
      await pending;
      await vi.advanceTimersByTimeAsync(19);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels a stalled GET body at the same deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let reading;
      const pending = new Promise((resolve) => {
          reading = resolve;
        }),
        cancel = vi.fn();
      const fetch = async () =>
        new Response(new ReadableStream({ pull: reading, cancel }, { highWaterMark: 0 }));
      const rejected = expect(
        new S3BackupStore(config, { fetch, timeoutMs: 20 }).get(key, 1),
      ).rejects.toThrow("backup_store_timeout");
      await pending;
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
