import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ClientMediaRegistration,
  ClientMediaWorker,
  parseClientMediaRange,
} from "../../src/lib/clientMediaServiceWorker";
import { createRecipientVault, PLAIN_CHUNK_BYTES } from "../../src/lib/cryptoEnvelope";
import {
  type ContainerWriterFactory,
  createEncryptedContainer,
  openContainerHeader,
} from "../../src/lib/encryptedContainer";

const HOST = "https://app.example.test";
const CONTENT = "https://content.example.test";
const SOURCE = `${CONTENT}/c/node-1/blob-1`;
const ETAG = '"revision-1"';
const CLIENT = "private-client";

const memoryWriter: ContainerWriterFactory = async (name) => {
  const parts: Uint8Array[] = [];
  return {
    async write(bytes) {
      parts.push(new Uint8Array(bytes));
    },
    async close() {
      return new File(
        parts.map((part) => new Uint8Array(part)),
        name,
        { type: "application/octet-stream" },
      );
    },
    async discard() {
      parts.length = 0;
    },
  };
};

function withUrl(response: Response, url = SOURCE): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("client-decrypted media virtual responses", () => {
  let bytes: Uint8Array;
  let plain: Uint8Array;
  let registration: ClientMediaRegistration;
  let fetcher: ReturnType<typeof vi.fn>;
  let clientUrl: string;
  let accountId: string;
  let now: number;
  let worker: ClientMediaWorker;
  let sourceFault: {
    etag?: string;
    truncate?: boolean;
    redirect?: boolean;
    wrongRange?: boolean;
    status?: number;
    corrupt?: boolean;
  };

  beforeAll(async () => {
    const owner = await createRecipientVault("owner_user");
    plain = new Uint8Array(PLAIN_CHUNK_BYTES + 7);
    plain[0] = 5;
    plain[PLAIN_CHUNK_BYTES - 1] = 17;
    plain[PLAIN_CHUNK_BYTES] = 19;
    plain[plain.length - 1] = 29;
    const source = new File([new Uint8Array(plain)], "private-video.mp4", {
      type: "video/mp4",
      lastModified: 123,
    });
    const created = await createEncryptedContainer(
      source,
      [owner.unlocked.publicKey],
      memoryWriter,
      undefined,
      { legacyUnsigned: true },
    );
    bytes = new Uint8Array(await created.file.arrayBuffer());
    const opened = await openContainerHeader(created.header, owner.unlocked, {
      legacyUnsigned: true,
    });
    registration = {
      headerBytes: bytes.slice(0, created.header.headerEnd),
      cipher: opened.cipher,
      sourceUrl: SOURCE,
      sourceEtag: ETAG,
      accountId: "owner_user",
      expiresAt: 20_000,
      mode: "inline",
    };
  }, 30_000);

  function setup() {
    now = 10_000;
    clientUrl = `${HOST}/files`;
    accountId = "owner_user";
    sourceFault = {};
    fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("Range");
      if (init?.method === "HEAD") {
        return withUrl(
          new Response(null, {
            status: 200,
            headers: { ETag: sourceFault.etag ?? ETAG, "Content-Length": String(bytes.length) },
          }),
          sourceFault.redirect ? `${CONTENT}/elsewhere` : url,
        );
      }
      if (!range) throw new Error("unexpected_full_cipher_fetch");
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) throw new Error("unexpected_range");
      const first = Number(match[1]);
      const last = Number(match[2]);
      if (last - first + 1 > PLAIN_CHUNK_BYTES) throw new Error("unbounded_cipher_fetch");
      const body = bytes.slice(first, last + (sourceFault.truncate ? 0 : 1));
      if (sourceFault.corrupt && first >= registration.headerBytes.length && body.length > 0)
        body[0] = body[0]! ^ 1;
      return withUrl(
        new Response(body, {
          status: sourceFault.status ?? 206,
          headers: {
            ETag: sourceFault.etag ?? ETAG,
            "Content-Range": sourceFault.wrongRange
              ? `bytes 0-0/${bytes.length}`
              : `bytes ${first}-${last}/${bytes.length}`,
            "Content-Length": String(body.length),
          },
        }),
        sourceFault.redirect ? `${CONTENT}/elsewhere` : url,
      );
    });
    worker = new ClientMediaWorker({
      hostOrigin: HOST,
      contentOrigin: CONTENT,
      lookupClient: async (id) => (id === CLIENT ? { url: clientUrl } : undefined),
      lookupAccountId: async () => accountId,
      fetcher: fetcher as typeof fetch,
      now: () => now,
    });
  }

  it("serves authenticated native video ranges with bounded ciphertext requests", async () => {
    setup();
    const url = await worker.register(CLIENT, registration);
    expect(url).toMatch(new RegExp(`^${HOST}/__client_media/[a-f0-9]{64}$`));
    const response = await worker.handleFetch(
      new Request(url, {
        headers: { Range: `bytes=${PLAIN_CHUNK_BYTES - 1}-${PLAIN_CHUNK_BYTES + 2}` },
      }),
      CLIENT,
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${PLAIN_CHUNK_BYTES - 1}-${PLAIN_CHUNK_BYTES + 2}/${plain.length}`,
    );
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      plain.slice(PLAIN_CHUNK_BYTES - 1, PLAIN_CHUNK_BYTES + 3),
    );
    const ranges = fetcher.mock.calls.map((call) => new Headers(call[1]?.headers).get("Range"));
    expect(ranges).toHaveLength(4); // header, full 4 MiB plus tag in two requests, final chunk
    expect(
      ranges.every(
        (range) =>
          range &&
          Number(range.split("-")[1]) - Number(range.split("=")[1]?.split("-")[0]) + 1 <=
            PLAIN_CHUNK_BYTES,
      ),
    ).toBe(true);
  }, 30_000);

  it("binds the default global fetch receiver before contacting content origin", async () => {
    setup();
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return (fetcher as typeof fetch)(input, init);
    } as typeof fetch;
    try {
      const browserLike = new ClientMediaWorker({
        hostOrigin: HOST,
        contentOrigin: CONTENT,
        lookupClient: async (id) => (id === CLIENT ? { url: clientUrl } : undefined),
        lookupAccountId: async () => accountId,
        now: () => now,
      });
      await expect(browserLike.register(CLIENT, registration)).resolves.toMatch(/__client_media/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reuses ciphertext across inline and download ranges only after a fresh source HEAD", async () => {
    setup();
    const inline = await worker.register(CLIENT, registration);
    const first = await worker.handleFetch(
      new Request(inline, { headers: { Range: "bytes=0-10" } }),
      CLIENT,
    );
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(plain.slice(0, 11));
    const chunkGets = () =>
      fetcher.mock.calls.filter(
        (call) =>
          call[1]?.method === "GET" &&
          Number(new Headers(call[1]?.headers).get("Range")?.split("=")[1]?.split("-")[0]) >=
            registration.headerBytes.length,
      ).length;
    expect(chunkGets()).toBe(2); // 4 MiB plus the GCM overhead

    const headerGets = () =>
      fetcher.mock.calls.filter(
        (call) =>
          new Headers(call[1]?.headers).get("Range") ===
          `bytes=0-${registration.headerBytes.length - 1}`,
      ).length;
    expect(headerGets()).toBe(1);

    const download = await worker.register(CLIENT, { ...registration, mode: "download" });
    const again = await worker.handleFetch(
      new Request(download, { headers: { Range: "bytes=1-4" } }),
      CLIENT,
    );
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(plain.slice(1, 5));
    expect(chunkGets()).toBe(2);
    expect(headerGets()).toBe(1);
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "HEAD")).toBe(true);

    sourceFault = { etag: '"changed"' };
    const rejected = await worker.handleFetch(new Request(download), CLIENT);
    await expect(rejected.arrayBuffer()).rejects.toThrow();
    expect((await worker.handleFetch(new Request(download), CLIENT)).status).toBe(404);
    expect(chunkGets()).toBe(2);
  }, 30_000);

  it("deduplicates simultaneous reads of one ciphertext chunk", async () => {
    setup();
    const original = fetcher;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range");
      if (range?.startsWith(`bytes=${registration.headerBytes.length}-`)) {
        began?.();
        await blocked;
      }
      return (original as typeof fetch)(input, init);
    });
    worker = new ClientMediaWorker({
      hostOrigin: HOST,
      contentOrigin: CONTENT,
      lookupClient: async (id) => (id === CLIENT ? { url: clientUrl } : undefined),
      lookupAccountId: async () => accountId,
      fetcher: fetcher as typeof fetch,
      now: () => now,
    });
    const url = await worker.register(CLIENT, registration);
    const a = await worker.handleFetch(
      new Request(url, { headers: { Range: "bytes=0-3" } }),
      CLIENT,
    );
    const b = await worker.handleFetch(
      new Request(url, { headers: { Range: "bytes=1-4" } }),
      CLIENT,
    );
    const first = a.arrayBuffer();
    await started;
    const second = b.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    const [aBytes, bBytes] = await Promise.all([first, second]);
    expect(new Uint8Array(aBytes)).toEqual(plain.slice(0, 4));
    expect(new Uint8Array(bBytes)).toEqual(plain.slice(1, 5));
    expect(
      fetcher.mock.calls.filter((call) =>
        new Headers(call[1]?.headers)
          .get("Range")
          ?.startsWith(`bytes=${registration.headerBytes.length}-`),
      ),
    ).toHaveLength(1);
  }, 30_000);

  it("drops cached ciphertext on revoke before another registration reads it", async () => {
    setup();
    const firstUrl = await worker.register(CLIENT, registration);
    const first = await worker.handleFetch(
      new Request(firstUrl, { headers: { Range: "bytes=0-1" } }),
      CLIENT,
    );
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(plain.slice(0, 2));
    const chunkGets = () =>
      fetcher.mock.calls.filter((call) => {
        const range = new Headers(call[1]?.headers).get("Range");
        return range?.startsWith(`bytes=${registration.headerBytes.length}-`);
      }).length;
    expect(chunkGets()).toBe(1);
    worker.revoke(CLIENT, firstUrl);
    const secondUrl = await worker.register(CLIENT, registration);
    const second = await worker.handleFetch(
      new Request(secondUrl, { headers: { Range: "bytes=0-1" } }),
      CLIENT,
    );
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(plain.slice(0, 2));
    expect(chunkGets()).toBe(2);
  }, 30_000);

  it("does not share or reinsert an in-flight chunk after revocation", async () => {
    setup();
    const original = fetcher;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let chunkGets = 0;
    fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (
        new Headers(init?.headers)
          .get("Range")
          ?.startsWith(`bytes=${registration.headerBytes.length}-`)
      ) {
        chunkGets++;
        if (chunkGets === 1) {
          began?.();
          await blocked;
        }
      }
      return (original as typeof fetch)(input, init);
    });
    worker = new ClientMediaWorker({
      hostOrigin: HOST,
      contentOrigin: CONTENT,
      lookupClient: async (id) => (id === CLIENT ? { url: clientUrl } : undefined),
      lookupAccountId: async () => accountId,
      fetcher: fetcher as typeof fetch,
      now: () => now,
    });
    const oldUrl = await worker.register(CLIENT, registration);
    const oldResponse = await worker.handleFetch(new Request(oldUrl), CLIENT);
    const oldBody = oldResponse.arrayBuffer();
    await started;
    worker.revoke(CLIENT, oldUrl);
    const newUrl = await worker.register(CLIENT, registration);
    const newResponse = await worker.handleFetch(
      new Request(newUrl, { headers: { Range: "bytes=0-1" } }),
      CLIENT,
    );
    expect(new Uint8Array(await newResponse.arrayBuffer())).toEqual(plain.slice(0, 2));
    expect(chunkGets).toBe(2);
    release?.();
    await expect(oldBody).rejects.toThrow();
  }, 30_000);

  it("serves HEAD without decrypting and rejects unknown or cross-client URLs locally", async () => {
    setup();
    const url = await worker.register(CLIENT, registration);
    const head = await worker.handleFetch(new Request(url, { method: "HEAD" }), CLIENT);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(plain.length));
    const calls = fetcher.mock.calls.length;
    expect((await worker.handleFetch(new Request(url), "other-client")).status).toBe(404);
    expect(
      (await worker.handleFetch(new Request(`${HOST}/__client_media/${"0".repeat(64)}`), CLIENT))
        .status,
    ).toBe(404);
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it("uses attachment headers for downloads and rejects a forged source header", async () => {
    setup();
    const url = await worker.register(CLIENT, { ...registration, mode: "download" });
    const response = await worker.handleFetch(new Request(url, { method: "HEAD" }), CLIENT);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    const changed = registration.headerBytes.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await expect(
      worker.register(CLIENT, { ...registration, headerBytes: changed }),
    ).rejects.toThrow();
  });

  it("renews the same token only for its client, account and unchanged source", async () => {
    setup();
    const url = await worker.register(CLIENT, registration);
    now = 19_000;
    await expect(worker.renew("other-client", url, 30_000)).rejects.toThrow();
    expect((await worker.handleFetch(new Request(url, { method: "HEAD" }), CLIENT)).status).toBe(
      404,
    );

    const next = await worker.register(CLIENT, { ...registration, expiresAt: 30_000 });
    now = 29_000;
    await worker.renew(CLIENT, next, 40_000);
    now = 30_000;
    expect((await worker.handleFetch(new Request(next, { method: "HEAD" }), CLIENT)).status).toBe(
      200,
    );
    sourceFault = { etag: '"changed"' };
    await expect(worker.renew(CLIENT, next, 50_000)).rejects.toThrow();
    expect((await worker.handleFetch(new Request(next), CLIENT)).status).toBe(404);
  });

  it("stops an active stream after explicit client clear", async () => {
    setup();
    const url = await worker.register(CLIENT, registration);
    const response = await worker.handleFetch(new Request(url), CLIENT);
    worker.clear(CLIENT);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect((await worker.handleFetch(new Request(url), CLIENT)).status).toBe(404);
  });

  it("rejects public-share clients, cross-account old tokens, expiration, and malformed ranges", async () => {
    setup();
    clientUrl = `${HOST}/s/public-token`;
    await expect(worker.register(CLIENT, registration)).rejects.toThrow();
    clientUrl = `${HOST}/files`;
    const old = await worker.register(CLIENT, registration);
    accountId = "admin_user";
    const newUrl = await worker.register(CLIENT, { ...registration, accountId: "admin_user" });
    expect((await worker.handleFetch(new Request(old), CLIENT)).status).toBe(404);
    expect(
      (
        await worker.handleFetch(
          new Request(newUrl, { headers: { Range: "bytes=0-1,3-4" } }),
          CLIENT,
        )
      ).status,
    ).toBe(416);
    expect(
      (
        await worker.handleFetch(
          new Request(newUrl, { headers: { Range: "bytes=999999999-" } }),
          CLIENT,
        )
      ).status,
    ).toBe(416);
    clientUrl = `${HOST}/s/public-token`;
    expect((await worker.handleFetch(new Request(newUrl), CLIENT)).status).toBe(404);
    clientUrl = `${HOST}/files`;
    expect((await worker.handleFetch(new Request(newUrl), CLIENT)).status).toBe(404);
    const accountUrl = await worker.register(CLIENT, { ...registration, accountId: "admin_user" });
    accountId = "owner_user";
    expect((await worker.handleFetch(new Request(accountUrl), CLIENT)).status).toBe(404);
    accountId = "admin_user";
    expect((await worker.handleFetch(new Request(accountUrl), CLIENT)).status).toBe(404);
    now = 20_000;
    expect((await worker.handleFetch(new Request(newUrl), CLIENT)).status).toBe(404);
  });

  it.each([
    { etag: '"changed"' },
    { truncate: true },
    { redirect: true },
    { wrongRange: true },
    { status: 503 },
    { corrupt: true },
  ])("fails closed on changed, truncated, redirected or invalid source %#", async (fault) => {
    setup();
    const url = await worker.register(CLIENT, registration);
    // Change the source only after registration, so no plaintext chunk may be emitted.
    sourceFault = fault;
    const response = await worker.handleFetch(
      new Request(url, { headers: { Range: "bytes=0-1" } }),
      CLIENT,
    );
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});

describe("strict plaintext range parser", () => {
  it("accepts suffix and open ranges and rejects multiple or unsafe numbers", () => {
    expect(parseClientMediaRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseClientMediaRange("bytes=8-", 10)).toEqual({ offset: 8, length: 2 });
    expect(parseClientMediaRange("bytes=0-50", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseClientMediaRange("bytes=0-1,2-3", 10)).toBeNull();
    expect(parseClientMediaRange("bytes=-0", 10)).toBeNull();
    expect(parseClientMediaRange("bytes=9007199254740992-", 10)).toBeNull();
  });
});
