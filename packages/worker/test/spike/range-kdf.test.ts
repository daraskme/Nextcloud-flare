import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { parseRange } from "../../src/platform/range";
import { hex } from "../../src/platform/stream";
import { readProbe } from "../fixtures/r2-read-probe";

it("exercises Range 206/416 and HEAD/304 response streams", async () => {
  const key = `probe/${crypto.randomUUID()}`;
  try {
    await env.BLOBS.put(key, "0123456789");
    const request = (headers: HeadersInit, method = "GET") =>
      new Request("https://probe.invalid", { method, headers });
    const partial = await readProbe(env.BLOBS, key, request({ Range: "bytes=2-5" }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");
    const outside = await readProbe(env.BLOBS, key, request({ Range: "bytes=10-" }));
    expect(outside.status).toBe(416);
    expect(outside.headers.get("Content-Range")).toBe("bytes */10");
    const head = await readProbe(env.BLOBS, key, request({}, "HEAD"));
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(head.body).toBeNull();
    const unchanged = await readProbe(
      env.BLOBS,
      key,
      request({ "If-None-Match": head.headers.get("ETag") ?? "" }),
    );
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeNull();
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("R2 serves the normalized byte range", async () => {
  const key = `probe/${crypto.randomUUID()}`;
  try {
    await env.BLOBS.put(key, "0123456789");
    const range = parseRange("bytes=2-5", 10);
    if (range.kind !== "range") throw new Error("invalid range");
    const object = await env.BLOBS.get(key, {
      range: { offset: range.offset, length: range.length },
    });
    expect(await object?.text()).toBe("2345");
    expect(object?.range).toEqual({ offset: 2, length: 4 });
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("accepts PBKDF2-SHA256 100,000 iterations with a 16-byte salt and 32-byte output", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("password"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode("0123456789abcdef"),
      iterations: 100_000,
    },
    key,
    256,
  );
  // Independently generated using Node's OpenSSL-backed pbkdf2Sync.
  expect(hex(derived)).toBe("a75190a792cd59d6d9c8c3a63b11c276ad449972b7886e1c2d819c286053366f");
});
