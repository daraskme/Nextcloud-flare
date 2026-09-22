import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { type BlobReadPlan, streamImmutableBlob } from "../../src/services/blobRead";

it("streams exact R2 bytes with D1 content validators and safe response headers", async () => {
  const key = `u/${crypto.randomUUID()}/b/${crypto.randomUUID()}`;
  const stored = await env.BLOBS.put(key, "0123456789");
  if (!stored) throw new Error("fixture_r2_put_failed");
  const plan: BlobReadPlan = {
    key,
    size: 10,
    r2Etag: stored.etag,
    contentEtag: '"content-v1"',
    mime: "audio/ogg",
    name: "音声.ogg",
  };
  const request = (headers: HeadersInit = {}, method = "GET") =>
    new Request("https://content.invalid/c", { method, headers });
  try {
    const range = await streamImmutableBlob(env.BLOBS, plan, request({ Range: "bytes=2-5" }));
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(range.headers.get("Content-Length")).toBe("4");
    expect(range.headers.get("ETag")).toBe(plan.contentEtag);
    expect(range.headers.get("Cache-Control")).toBe("private, no-store");
    expect(range.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(range.headers.get("Content-Disposition")).toMatch(/^inline; filename\*=UTF-8''/);
    expect(new TextDecoder().decode(await range.arrayBuffer())).toBe("2345");
    const full = await streamImmutableBlob(
      env.BLOBS,
      plan,
      request({ Range: "bytes=2-5", "If-Range": '"old-version"' }),
    );
    expect(full.status).toBe(200);
    expect(new TextDecoder().decode(await full.arrayBuffer())).toBe("0123456789");
    const head = await streamImmutableBlob(env.BLOBS, plan, request({}, "HEAD"));
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(head.body).toBeNull();
    const unchanged = await streamImmutableBlob(
      env.BLOBS,
      plan,
      request({ "If-None-Match": 'W/"content-v1"', Range: "bytes=2-5" }),
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeNull();
    const outside = await streamImmutableBlob(env.BLOBS, plan, request({ Range: "bytes=10-" }));
    expect(outside.status).toBe(416);
    expect(outside.headers.get("Content-Range")).toBe("bytes */10");
    const attachment = await streamImmutableBlob(
      env.BLOBS,
      { ...plan, mime: "text/html", name: "unsafe.html" },
      request({}, "HEAD"),
    );
    expect(attachment.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    await expect(streamImmutableBlob(env.BLOBS, { ...plan, size: 11 }, request())).rejects.toThrow(
      /blob_storage_mismatch/,
    );
    await expect(
      streamImmutableBlob(env.BLOBS, { ...plan, r2Etag: "wrong" }, request()),
    ).rejects.toThrow(/blob_storage_mismatch/);
    await expect(
      streamImmutableBlob(env.BLOBS, { ...plan, key: `backup/${crypto.randomUUID()}` }, request()),
    ).rejects.toThrow(/invalid_blob_read/);
  } finally {
    await env.BLOBS.delete(key);
  }
});
