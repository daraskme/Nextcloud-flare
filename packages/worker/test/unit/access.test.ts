import { beforeAll, describe, expect, it, vi } from "vitest";
import { AccessVerifier } from "../../src/auth/access";
import { AccessJwks } from "../../src/auth/jwks";
import { accessFixture } from "../fixtures/access";

let fixture: Awaited<ReturnType<typeof accessFixture>>;
const NOW = 1_790_000_000_000;
beforeAll(async () => {
  fixture = await accessFixture("https://access.invalid", () => NOW);
});

it("verifies a signed user JWT and keeps service claims on their own audience", async () => {
  expect(await fixture.verifier.verify(await fixture.sign(), "user")).toMatchObject({
    kind: "user",
    sub: "owner",
  });
  const request = await fixture.sign({
    aud: ["service-aud"],
    common_name: "service-id",
    sub: "",
    email: undefined,
  });
  expect(await fixture.verifier.verify(request, "service")).toMatchObject({
    kind: "service",
    common_name: "service-id",
  });
  await expect(fixture.verifier.verify(request, "user")).rejects.toThrow(
    "access_authentication_failed",
  );
});

it.each([
  { iss: "https://other.invalid" },
  { aud: ["private-aud", "extra"] },
  { aud: "service-aud" },
  { type: "service" },
  { iat: 1.5 },
  { exp: 9_007_199_254_740_991 },
  { nbf: undefined },
  { sub: "a|b" },
  { email: "" },
  { common_name: "service-id" },
  { exp: 1 },
  { iat: NOW / 1000 + 61 },
  { nbf: NOW / 1000 + 61 },
  { exp: NOW / 1000 + 86401 },
])("rejects invalid signed claims %j", async (changes) => {
  await expect(fixture.verifier.verify(await fixture.sign(changes), "user")).rejects.toThrow(
    "access_authentication_failed",
  );
});

it.each([{ typ: "at+jwt" }, { jku: "https://attacker.invalid/keys" }, { kid: "" }])(
  "rejects a forbidden JOSE header %j",
  async (header) => {
    await expect(fixture.verifier.verify(await fixture.sign({}, header), "user")).rejects.toThrow();
  },
);

it("rejects altered signatures, duplicate assertion headers and all fallback credentials", async () => {
  const request = await fixture.sign();
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? "";
  const parts = token.split(".");
  const signature = parts[2] ?? "";
  parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
  await expect(
    fixture.verifier.verify(
      new Request(request, { headers: { "Cf-Access-Jwt-Assertion": parts.join(".") } }),
      "user",
    ),
  ).rejects.toThrow();
  request.headers.append("Cf-Access-Jwt-Assertion", token);
  await expect(fixture.verifier.verify(request, "user")).rejects.toThrow();
  await expect(
    fixture.verifier.verify(
      new Request(`https://app.invalid/?token=${token}`, {
        headers: {
          Cookie: `CF_Authorization=${token}`,
          Authorization: `Bearer ${token}`,
          "CF-Access-Client-Secret": "raw",
        },
      }),
      "user",
    ),
  ).rejects.toThrow();
});

describe("JWKS cache boundaries", () => {
  function setup() {
    let time = Date.now();
    const store = new Map<string, string>();
    const cache = {
      ...fixture.cache,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    } as typeof fixture.cache;
    const fetcher = vi.fn(fixture.fetcher);
    const source = new AccessJwks(fixture.issuer, cache, fetcher, () => time);
    return {
      source,
      fetcher,
      cache,
      store,
      advance(ms: number) {
        time += ms;
      },
      now: () => time,
    };
  }
  it("coalesces concurrent refreshes and caches a known key for one hour, including across isolates via KV", async () => {
    const s = setup();
    await Promise.all(Array.from({ length: 20 }, () => s.source.resolver("key-one")));
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    await new AccessJwks(fixture.issuer, s.cache, s.fetcher, s.now).resolver("key-one");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    s.advance(3_600_001);
    await s.source.resolver("key-one");
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    expect(s.fetcher.mock.calls[0]?.[0]).toBe(`${fixture.issuer}/cdn-cgi/access/certs`);
    expect(s.fetcher.mock.calls[0]?.[1].redirect).toBe("error");
  });
  it("allows a known stale key only during fetch failure and never beyond 24 hours", async () => {
    const s = setup();
    await s.source.resolver("key-one");
    s.advance(3_600_001);
    s.fetcher.mockRejectedValue(new Error("offline"));
    await expect(s.source.resolver("key-one")).resolves.toBeTypeOf("function");
    await expect(s.source.resolver("new-key")).rejects.toThrow();
    s.advance(86_400_000);
    await expect(s.source.resolver("key-one")).rejects.toThrow();
  });
  it("does not revive a key removed by a successful refresh", async () => {
    const s = setup();
    await s.source.resolver("key-one");
    s.advance(3_600_001);
    s.fetcher.mockImplementation(async () =>
      Response.json({ keys: fixture.jwks.keys.map((key) => ({ ...key, kid: "rotated" })) }),
    );
    await expect(s.source.resolver("key-one")).rejects.toThrow("unknown_kid");
    await expect(s.source.resolver("rotated")).resolves.toBeTypeOf("function");
  });
  it("negative-caches misses and caps issuer refreshes at ten per minute", async () => {
    const s = setup();
    await expect(s.source.resolver("unknown")).rejects.toThrow("unknown_kid");
    await expect(s.source.resolver("unknown")).rejects.toThrow("unknown_kid");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) await expect(s.source.resolver(`unknown-${i}`)).rejects.toThrow();
    expect(s.fetcher).toHaveBeenCalledTimes(10);
    s.advance(60_001);
    await expect(s.source.resolver("unknown")).rejects.toThrow("unknown_kid");
    expect(s.fetcher).toHaveBeenCalledTimes(11);
  });
  it.each(["large", "too-many", "duplicate", "private", "non-rsa", "bad-json", "unavailable"])(
    "rejects %s key responses",
    async (kind) => {
      const s = setup();
      s.fetcher.mockImplementation(async () => {
        const key = fixture.jwks.keys[0];
        if (kind === "large") return new Response(" ".repeat(262_145));
        if (kind === "too-many")
          return Response.json({
            keys: Array.from({ length: 17 }, (_, i) => ({ ...key, kid: String(i) })),
          });
        if (kind === "duplicate") return Response.json({ keys: [key, key] });
        if (kind === "private") return Response.json({ keys: [{ ...key, d: "secret" }] });
        if (kind === "non-rsa") return Response.json({ keys: [{ ...key, kty: "EC" }] });
        if (kind === "bad-json") return new Response("no");
        return new Response(null, { status: 503 });
      });
      await expect(s.source.resolver("key-one")).rejects.toThrow();
    },
  );
  it("times out a stalled response body within five seconds", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const cancel = vi.fn();
      s.fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel })));
      const result = expect(s.source.resolver("key-one")).rejects.toThrow("jwks_timeout");
      await vi.advanceTimersByTimeAsync(5000);
      await result;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("ignores malformed KV and rejects unsafe issuer/audience configuration", async () => {
    const s = setup();
    s.store.set(`access-jwks:v1:${fixture.issuer}`, "not json");
    await s.source.resolver("key-one");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(() => new AccessJwks("http://access.invalid", s.cache)).toThrow();
    expect(() => new AccessJwks("https://access.invalid/untrusted", s.cache)).toThrow();
    expect(() => new AccessVerifier(s.source, "same", "same")).toThrow();
  });
});
