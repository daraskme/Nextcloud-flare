import { expect, it, vi } from "vitest";
import {
  type BackupPublication,
  parseBackupPublication,
} from "../../../shared/src/backupPublication";
import { sha256, verifyPublicationPart } from "../../src/backup/publication";
import { publicationFixture } from "../fixtures/backupPublication";

const id = "12345678-1234-1234-1234-123456789012";
const fixture = () =>
  publicationFixture({ id, epoch: 1, token: id, createdAt: 1, watermark: null });
const bytes = (p: BackupPublication) => new TextEncoder().encode(JSON.stringify(p));
it("accepts the shared immutable publication shape", async () => {
  const p = await fixture();
  expect(parseBackupPublication(bytes(p), id)).toEqual(p);
});
it.each(["format", "token", "time", "hash", "rows", "tables", "migrations", "size", "extra"])(
  "rejects malformed %s metadata before any storage request",
  async (kind) => {
    const p = await fixture();
    if (kind === "format") Object.assign(p.manifest, { format: "unknown" });
    if (kind === "token") p.manifest.generation.token = "bad";
    if (kind === "time") p.manifest.capturedAt = 0;
    if (kind === "hash") p.manifest.data.sha256 = "x".repeat(64);
    if (kind === "rows") p.manifest.tables[0]!.rows = -1;
    if (kind === "tables") p.manifest.tables.push(p.manifest.tables[0]!);
    if (kind === "migrations") p.manifest.schema.migrations.push(p.manifest.schema.migrations[0]!);
    if (kind === "size") p.parts[0]!.bytes++;
    if (kind === "extra") Object.assign(p.parts[0]!, { key: "sys/epoch/1.json" });
    expect(() => parseBackupPublication(bytes(p), id)).toThrow();
  },
);
it("rejects invalid UTF-8 instead of replacing malformed bytes", () => {
  expect(() => parseBackupPublication(new Uint8Array([0xff]), id)).toThrow(
    "backup_invalid_publication",
  );
});
it.each(["oversize", "truncated", "overflow"])(
  "bounds R2 %s bodies and leaves no verification proof",
  async (kind) => {
    const p = await fixture(),
      raw = bytes(p),
      cancel = vi.fn();
    const bucket = {
      get: async () => ({
        size: kind === "oversize" ? 16 * 1024 * 1024 + 1 : raw.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            if (kind === "truncated") controller.close();
            if (kind === "overflow") controller.enqueue(new Uint8Array(raw.length + 1));
          },
          cancel,
        }),
      }),
    } as unknown as R2Bucket;
    await expect(
      verifyPublicationPart(bucket, p.manifest.generation, await sha256(raw), 0),
    ).rejects.toThrow("backup_publication_unavailable");
    if (kind !== "truncated") expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it.each(["request", "body"])("cancels a stalled R2 %s at the fixed deadline", async (stage) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const p = await fixture(),
      raw = bytes(p),
      hash = await sha256(raw),
      cancel = vi.fn();
    let entered!: () => void;
    const pending = new Promise<void>((r) => {
      entered = r;
    });
    const get = vi.fn(async () => {
      if (stage === "request") {
        entered();
        return new Promise(() => {});
      }
      return {
        size: raw.length,
        body: new ReadableStream<Uint8Array>({ pull: entered, cancel }, { highWaterMark: 0 }),
      };
    });
    const rejected = expect(
      verifyPublicationPart({ get } as unknown as R2Bucket, p.manifest.generation, hash, 0),
    ).rejects.toThrow("backup_read_timeout");
    await pending;
    await vi.advanceTimersByTimeAsync(9999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(get).toHaveBeenCalledTimes(1);
    if (stage === "body") expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
