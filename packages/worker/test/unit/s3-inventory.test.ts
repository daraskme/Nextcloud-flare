import { describe, expect, it, vi } from "vitest";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { multipartLifecycle, multipartPage, partPage } from "../../src/r2/s3InventoryPages";
import {
  inventoryEnv,
  lifecycleRule,
  partsXml,
  partXml,
  uploadsXml,
  uploadXml,
  xml,
} from "../fixtures/s3Inventory";

const uploadExpected = { bucket: "test-blobs", prefix: "u/", limit: 20, marker: null };
const partExpected = {
  bucket: "test-blobs",
  key: "u/owner/b/blob",
  uploadId: "upload-1",
  limit: 20,
  marker: 0,
};

describe("fixed S3 binding probe read", () => {
  it("signs only the fixed protocol key and reads exactly one nonce", async () => {
    const nonce = "a9".repeat(32);
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe(`/test-blobs/${BINDING_PROBE_KEY}`);
      expect(url.search).toBe("");
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("Authorization")).toMatch(/\/auto\/s3\/aws4_request/);
      return new Response(nonce);
    });
    expect(await new R2S3Inventory(inventoryEnv, { fetch }).readBindingProbe()).toBe(nonce);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enforces the smaller 64-byte cap on declared and streamed bodies", async () => {
    for (const declared of [true, false]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!declared) controller.enqueue(new Uint8Array(65));
        },
        cancel,
      });
      const fetch = async () =>
        new Response(stream, declared ? { headers: { "Content-Length": "65" } } : {});
      await expect(new R2S3Inventory(inventoryEnv, { fetch }).readBindingProbe()).rejects.toThrow(
        "s3_inventory_body_limit",
      );
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects truncated, padded and non-hex challenges", async () => {
    for (const body of [
      "",
      "a".repeat(63),
      "A".repeat(64),
      `${"a".repeat(63)}\n`,
      "g".repeat(64),
    ]) {
      await expect(
        new R2S3Inventory(inventoryEnv, {
          fetch: async () => new Response(body),
        }).readBindingProbe(),
      ).rejects.toThrow("invalid_r2_binding_probe");
    }
  });

  it("applies the same transport deadline while reading a probe body", async () => {
    // Real signing can exceed 20ms on CI. Advance the transport timer only once read() is pending.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cancel = vi.fn();
      let reading!: () => void;
      const pendingRead = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const fetch = vi.fn(
        async () =>
          new Response(new ReadableStream({ pull: reading, cancel }, { highWaterMark: 0 })),
      );
      const rejected = expect(
        new R2S3Inventory(inventoryEnv, { fetch, timeoutMs: 20 }).readBindingProbe(),
      ).rejects.toThrow("s3_inventory_timeout");
      await pendingRead;
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bounded multipart inventory XML", () => {
  it("checks UTF-8 key order and rejects pages that move behind the cursor", () => {
    const lower = "u/\ue000";
    const higher = "u/\u{10000}";
    expect(
      multipartPage(uploadsXml({ uploads: uploadXml(lower) + uploadXml(higher) }), uploadExpected)
        .uploads,
    ).toHaveLength(2);
    expect(() =>
      multipartPage(uploadsXml({ uploads: uploadXml(higher) + uploadXml(lower) }), uploadExpected),
    ).toThrow();
    expect(() =>
      multipartPage(uploadsXml({ keyMarker: higher, idMarker: "old", uploads: uploadXml(lower) }), {
        ...uploadExpected,
        marker: { key: higher, uploadId: "old" },
      }),
    ).toThrow();
  });

  it("requires initiation order for different IDs at the same key", () => {
    const newer = uploadXml("u/a", "new").replace("2026-09-20", "2026-09-21");
    expect(() =>
      multipartPage(uploadsXml({ uploads: newer + uploadXml("u/a", "old") }), uploadExpected),
    ).toThrow();
  });
  it("retains different IDs at the same key and the paired continuation marker", () => {
    const key = "u/日本語/b/a+b%26&file";
    const uploadId = "id+/%&=";
    const page = multipartPage(
      uploadsXml({
        uploads: uploadXml(key, "first") + uploadXml(key, uploadId),
        truncated: true,
        nextKey: key,
        nextId: uploadId,
      }),
      uploadExpected,
    );
    expect(page.uploads.map((row) => row.uploadId)).toEqual(["first", uploadId]);
    expect(page.next).toEqual({ key, uploadId });
    expect(
      multipartPage(uploadsXml({ uploads: "", keyMarker: key, idMarker: uploadId }), {
        ...uploadExpected,
        marker: page.next,
      }),
    ).toEqual({ uploads: [], next: null });
  });

  it("accepts namespace prefixes, one XML declaration and predefined/numeric entities", () => {
    const document = uploadsXml({ uploads: uploadXml("u/a/b/c", "id&#x26;") })
      .replaceAll("&amp;#x26;", "&#x26;")
      .replaceAll('xmlns="', 'xmlns:s="')
      .replace(/<(\/?)([A-Za-z]+)/g, "<$1s:$2");
    expect(
      multipartPage(`<?xml version="1.0" encoding="UTF-8"?>${document}`, uploadExpected).uploads[0]!
        .uploadId,
    ).toBe("id&");
  });

  it.each([
    ["wrong bucket", (s: string) => s.replace("test-blobs", "other-bucket")],
    ["wrong namespace", (s: string) => s.replace("s3.amazonaws.com", "attacker.invalid")],
    [
      "unqualified root",
      (s: string) => s.replace(' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"', ""),
    ],
    ["namespace shadow", (s: string) => s.replace("<Upload>", '<Upload xmlns="other:">')],
    [
      "duplicate scalar",
      (s: string) => s.replace("<Bucket>", "<Bucket>test-blobs</Bucket><Bucket>"),
    ],
    ["nested scalar", (s: string) => s.replace("test-blobs", "<x>test-blobs</x>")],
    ["wrong prefix", (s: string) => s.replace("u%2F</Prefix>", "v%2F</Prefix>")],
    ["outside prefix", (s: string) => s.replace("u%2Fowner", "v%2Fowner")],
    ["encoding omitted", (s: string) => s.replace("<EncodingType>url</EncodingType>", "")],
    ["bad encoding", (s: string) => s.replace("u%2Fowner", "u%XXowner")],
    ["bad bool", (s: string) => s.replace("false", "0")],
    ["bad integer", (s: string) => s.replace("<MaxUploads>20", "<MaxUploads>020")],
    ["mismatched maximum", (s: string) => s.replace("<MaxUploads>20", "<MaxUploads>100")],
    [
      "wrong marker",
      (s: string) => s.replace("<KeyMarker></KeyMarker>", "<KeyMarker>u%2Fother</KeyMarker>"),
    ],
    ["missing continuation", (s: string) => s.replace("false", "true")],
    ["invalid date", (s: string) => s.replace("2026-09-20", "2026-02-30")],
    ["duplicate tuple", (s: string) => s.replace("</Upload>", `</Upload>${uploadXml()}`)],
    ["external entity", (s: string) => `<!DOCTYPE a [<!ENTITY e SYSTEM "file:///secret">]>${s}`],
    ["unknown entity", (s: string) => s.replace("upload-1", "&unknown;")],
    ["zero entity", (s: string) => s.replace("upload-1", "&#0;")],
    ["surrogate entity", (s: string) => s.replace("upload-1", "&#xD800;")],
    ["oversized entity", (s: string) => s.replace("upload-1", "&#x110000;")],
    ["CDATA", (s: string) => s.replace("upload-1", "<![CDATA[id]]>")],
    ["processing instruction", (s: string) => s.replace("upload-1", "<?instruction?>")],
    ["extra root", (s: string) => s + s],
    ["mixed root text", (s: string) => s.replace("<Bucket>", "bad<Bucket>")],
    [
      "common prefixes",
      (s: string) =>
        s.replace("<Bucket>", "<CommonPrefixes><Prefix>u/</Prefix></CommonPrefixes><Bucket>"),
    ],
    ["delimiter", (s: string) => s.replace("<Bucket>", "<Delimiter>/</Delimiter><Bucket>")],
    ["attribute", (s: string) => s.replace("<Upload>", '<Upload attr="x">')],
    ["depth", (s: string) => s.replace("upload-1", "<x>".repeat(17) + "x" + "</x>".repeat(17))],
    [
      "element budget",
      (s: string) => s.replace("<Upload>", `<Owner>${"<x/>".repeat(10001)}</Owner><Upload>`),
    ],
    ["byte budget", (s: string) => s + " ".repeat(1_048_576)],
  ])("rejects %s without accepting partial inventory", (_name, mutate) => {
    expect(() => multipartPage(mutate(uploadsXml()), uploadExpected)).toThrow(
      "invalid_s3_inventory_xml",
    );
  });

  it("rejects page overflow, truncated empty pages, stale and detached markers", () => {
    expect(() =>
      multipartPage(uploadsXml({ limit: 1, uploads: uploadXml() + uploadXml("u/x", "second") }), {
        ...uploadExpected,
        limit: 1,
      }),
    ).toThrow();
    expect(() =>
      multipartPage(uploadsXml({ uploads: "", truncated: true }), uploadExpected),
    ).toThrow();
    expect(() =>
      multipartPage(
        uploadsXml({ truncated: true, nextKey: "u/owner/b/blob", nextId: "other" }),
        uploadExpected,
      ),
    ).toThrow();
    expect(() =>
      multipartPage(uploadsXml({ keyMarker: "u/owner/b/blob", idMarker: "upload-1" }), {
        ...uploadExpected,
        marker: { key: "u/owner/b/blob", uploadId: "upload-1" },
      }),
    ).toThrow();
  });

  it("reads ordered part sizes and a numeric continuation, including zero-byte terminal parts", () => {
    expect(
      partPage(
        partsXml({ parts: partXml(1, 0) + partXml(2, 8388608), truncated: true, next: 2 }),
        partExpected,
      ),
    ).toEqual({
      parts: [0, 8388608].map((bytes, i) => ({
        partNumber: i + 1,
        bytes,
        etag: '"abc"',
        modifiedAt: Date.parse("2026-09-20T01:02:03Z"),
      })),
      next: 2,
    });
    expect(partPage(partsXml({ parts: "", marker: 2 }), { ...partExpected, marker: 2 })).toEqual({
      parts: [],
      next: null,
    });
  });

  it.each([
    ["bucket", (s: string) => s.replace("test-blobs", "wrong")],
    ["key", (s: string) => s.replace("u/owner/b/blob", "u/wrong")],
    ["upload ID", (s: string) => s.replace("upload-1", "wrong")],
    ["echo marker", (s: string) => s.replace("<PartNumberMarker>0", "<PartNumberMarker>1")],
    ["fractional bytes", (s: string) => s.replace("<Size>123", "<Size>1.5")],
    ["unsafe bytes", (s: string) => s.replace("<Size>123", "<Size>9007199254740992")],
    ["negative bytes", (s: string) => s.replace("<Size>123", "<Size>-1")],
    ["too many parts", (s: string) => s.replace("<PartNumber>1", "<PartNumber>10001")],
    ["duplicate part", (s: string) => s.replace("</Part>", `</Part>${partXml()}`)],
    ["nonadvancing next", (s: string) => s.replace("false", "true")],
    ["empty etag", (s: string) => s.replace("&quot;abc&quot;", "")],
  ])("rejects invalid part %s", (_name, mutate) => {
    expect(() => partPage(mutate(partsXml()), partExpected)).toThrow("invalid_s3_inventory_xml");
  });
});

describe("lifecycle observation", () => {
  const read = (rules: string) => multipartLifecycle(xml("LifecycleConfiguration", rules), "u/");
  it("recognizes exact seven-day coverage under an enabled prefix or all-object filter", () => {
    expect(read(lifecycleRule()).sevenDayCoverage).toBe(true);
    expect(read(lifecycleRule({ filter: "<Filter/>" })).sevenDayCoverage).toBe(true);
    expect(read(lifecycleRule({ filter: "<Prefix></Prefix>" })).sevenDayCoverage).toBe(true);
  });
  it.each([
    { days: 6 },
    { days: 8 },
    { status: "Disabled" },
    { filter: "<Filter><Prefix>other/</Prefix></Filter>" },
    { filter: "<Filter><Prefix>u/one-owner/</Prefix></Filter>" },
    { filter: "<Filter><Tag><Key>scope</Key><Value>x</Value></Tag></Filter>" },
    {
      filter:
        "<Filter><And><Prefix>u/</Prefix><ObjectSizeGreaterThan>0</ObjectSizeGreaterThan></And></Filter>",
    },
    { filter: "" },
  ])("does not claim complete seven-day coverage for %j", (rule) => {
    expect(read(lifecycleRule(rule)).sevenDayCoverage).toBe(false);
  });
  it("rejects early overlapping rules and unknown selectors even alongside a covering rule", () => {
    expect(
      read(
        lifecycleRule() +
          lifecycleRule({
            id: "early",
            days: 1,
            filter: "<Filter><Prefix>u/one/</Prefix></Filter>",
          }),
      ).sevenDayCoverage,
    ).toBe(false);
    expect(
      read(
        lifecycleRule() +
          lifecycleRule({
            id: "unknown",
            filter: "<Filter><Tag><Key>a</Key><Value>b</Value></Tag></Filter>",
          }),
      ).sevenDayCoverage,
    ).toBe(false);
    expect(
      read(
        lifecycleRule() +
          lifecycleRule({
            id: "unrelated",
            days: 1,
            filter: "<Filter><Prefix>other/</Prefix></Filter>",
          }),
      ).sevenDayCoverage,
    ).toBe(true);
  });
  it("rejects ambiguous statuses, duplicate rules and noncanonical days", () => {
    expect(() => read(lifecycleRule({ status: "enabled" }))).toThrow();
    expect(() => read(lifecycleRule() + lifecycleRule())).toThrow();
    expect(() => read(lifecycleRule().replace(">7<", ">07<"))).toThrow();
    expect(() => read(lifecycleRule({ filter: "<Prefix/><Filter/>" }))).toThrow();
  });
});

describe("signed bounded S3 reads", () => {
  it.each(["default", "eu", "fedramp", "us"])(
    "signs one GET for the %s endpoint without URL credentials",
    async (jurisdiction) => {
      const fetch = vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        expect(url.host).toBe(
          `${"a".repeat(32)}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com`,
        );
        expect(url.pathname).toBe("/test-blobs");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          uploads: "",
          "encoding-type": "url",
          prefix: "u/",
          "max-uploads": "20",
        });
        expect(request.method).toBe("GET");
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("Authorization")).toMatch(
          /AWS4-HMAC-SHA256 Credential=.+\/auto\/s3\/aws4_request,.+Signature=[a-f0-9]{64}$/,
        );
        expect(request.url).not.toContain(inventoryEnv.R2_INVENTORY_ACCESS_KEY_ID);
        return new Response(uploadsXml());
      });
      const client = new R2S3Inventory(
        { ...inventoryEnv, R2_INVENTORY_JURISDICTION: jurisdiction },
        { fetch },
      );
      expect((await client.listMultipartUploads()).uploads).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      const source = client.source;
      source.bucket = "changed";
      expect(client.source.bucket).toBe("test-blobs");
      expect(JSON.stringify(client)).toBe("{}");
    },
  );

  it("encodes path/query once and preserves plus, percent, ampersand and Unicode", async () => {
    const key = "u/日本語/b/a+b%26 &?#\\file";
    const uploadId = "id+/=&%";
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(decodeURIComponent(url.pathname)).toBe(`/test-blobs/${key}`);
      expect(url.searchParams.get("uploadId")).toBe(uploadId);
      return new Response(partsXml({ key, uploadId }));
    });
    expect(
      (await new R2S3Inventory(inventoryEnv, { fetch }).listParts({ key, uploadId })).parts,
    ).toHaveLength(1);
  });

  it.each([
    ["R2_INVENTORY_ACCOUNT_ID", "https://attacker.invalid"],
    ["R2_INVENTORY_BUCKET", "bucket/../other"],
    ["R2_INVENTORY_BUCKET", "bucket.example"],
    ["R2_INVENTORY_JURISDICTION", "evil.example"],
    ["R2_INVENTORY_ACCESS_KEY_ID", ""],
    ["R2_INVENTORY_SECRET_ACCESS_KEY", "secret\nheader"],
  ])("rejects invalid server config %s", (name, value) => {
    expect(() => new R2S3Inventory({ ...inventoryEnv, [name]: value })).toThrow(
      "s3_inventory_unconfigured",
    );
  });

  it("does not dispatch malformed limits, markers, paths or prefixes", async () => {
    const fetch = vi.fn();
    const client = new R2S3Inventory(inventoryEnv, { fetch });
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { prefix: "" },
      { prefix: "backups/" },
      { marker: { key: "wrong", uploadId: "id" } },
      { marker: { key: "u/x", uploadId: "" } },
    ])
      await expect(client.listMultipartUploads(options)).rejects.toThrow(
        "invalid_s3_inventory_request",
      );
    for (const key of ["u/../secret", "u/./secret", "u/\ud800", "u/" + "日".repeat(400)])
      await expect(client.listParts({ key, uploadId: "id" })).rejects.toThrow(
        "invalid_s3_inventory_request",
      );
    await expect(client.listParts({ key: "u/x", uploadId: "id", marker: 10000 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([301, 302, 403, 404, 429, 500, 503])(
    "does not retry or accept HTTP %i as absence",
    async (status) => {
      const cancel = vi.fn();
      const fetch = vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            status,
            headers: { Location: "https://attacker.invalid" },
          }),
      );
      await expect(
        new R2S3Inventory(inventoryEnv, { fetch }).listMultipartUploads(),
      ).rejects.toThrow(`s3_inventory_http_${status}`);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("redacts upstream transport failures", async () => {
    const fetch = async () => {
      throw new Error(`secret ${inventoryEnv.R2_INVENTORY_SECRET_ACCESS_KEY}`);
    };
    await expect(new R2S3Inventory(inventoryEnv, { fetch }).listMultipartUploads()).rejects.toThrow(
      /^s3_inventory_unavailable$/,
    );
  });

  it("cancels stalled bodies within the transport deadline", async () => {
    // Signing latency is not the condition under test: first establish a pending body read.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cancel = vi.fn();
      let reading!: () => void;
      const pendingRead = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const fetch = vi.fn(
        async () =>
          new Response(new ReadableStream({ pull: reading, cancel }, { highWaterMark: 0 })),
      );
      const rejected = expect(
        new R2S3Inventory(inventoryEnv, { fetch, timeoutMs: 20 }).listMultipartUploads(),
      ).rejects.toThrow("s3_inventory_timeout");
      await pendingRead;
      await vi.advanceTimersByTimeAsync(19);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a fetch that never responds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let signal: AbortSignal | undefined;
      let dispatched!: () => void;
      const pendingFetch = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      const fetch = vi.fn((request: Request) => {
        signal = request.signal;
        dispatched();
        return new Promise<Response>(() => {});
      });
      const rejected = expect(
        new R2S3Inventory(inventoryEnv, { fetch, timeoutMs: 20 }).listMultipartUploads(),
      ).rejects.toThrow("s3_inventory_timeout");
      await pendingFetch;
      await vi.advanceTimersByTimeAsync(19);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized declared and streamed bodies, canceling the reader", async () => {
    for (const declared of [true, false]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!declared) controller.enqueue(new Uint8Array(1_048_577));
        },
        cancel,
      });
      const fetch = async () =>
        new Response(stream, declared ? { headers: { "Content-Length": "1048577" } } : {});
      await expect(
        new R2S3Inventory(inventoryEnv, { fetch }).listMultipartUploads(),
      ).rejects.toThrow("s3_inventory_body_limit");
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed UTF-8 instead of replacing it", async () => {
    const fetch = async () => new Response(new Uint8Array([0xc0, 0xaf]));
    await expect(new R2S3Inventory(inventoryEnv, { fetch }).listMultipartUploads()).rejects.toThrow(
      "invalid_s3_inventory_xml",
    );
  });
});
