import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicClient } from "../../src/public-share/client";
import { transferPublicUpload, type UploadProgress } from "../../src/public-share/upload";
import {
  newPublicUpload,
  type PublicUploadRecord,
  validPublicUpload,
} from "../../src/public-share/uploadStore";

beforeEach(() =>
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        options: object,
        callback: (lock: object) => Promise<void>,
      ) => {
        expect(options).not.toHaveProperty("signal");
        await callback({});
      },
    },
  }),
);
afterEach(() => vi.unstubAllGlobals());
const uploadId = `up_${"a".repeat(64)}`,
  operationId = `op_${"b".repeat(64)}`;
const capability = `kid.${"c".repeat(43)}`;
async function setup(text = "abc", mode: "single" | "multipart" = "single") {
  const file = new File([text], "元の資料.txt", { lastModified: 1000 });
  const record = await newPublicUpload("share", "session", Date.now() + 600000, "folder", file);
  record.mode = mode;
  let saved: PublicUploadRecord | undefined = structuredClone(record);
  const store = {
    read: vi.fn(async () => saved && structuredClone(saved)),
    save: vi.fn(async (r: PublicUploadRecord) => {
      saved = structuredClone(r);
    }),
    remove: vi.fn(async () => {
      saved = undefined;
    }),
  };
  const state = { phase: "created", received: false, operation: null as string | null };
  const receipt = () => ({
    id: uploadId,
    capability,
    mode,
    state: state.phase,
    declaredSize: file.size,
    expiresAt: Date.now() + 600000,
    operationId: state.operation,
    ...(mode === "multipart"
      ? {
          partBytes: 8388608,
          partCount: 1,
          revision: 1,
          nextAfter: null,
          parts: state.received
            ? [
                {
                  partNumber: 1,
                  state: "completed",
                  expectedBytes: file.size,
                  attempts: 1,
                  attemptId: "original",
                },
              ]
            : [],
        }
      : {}),
  });
  const route = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/csrf")) return Response.json({ token: "csrf" });
    if (url.endsWith("/uploads")) return Response.json(receipt(), { status: 201 });
    if (init?.method === "PUT") {
      state.received = true;
      state.phase = mode === "single" ? "completing" : "uploading";
      return Response.json(mode === "single" ? receipt() : { disposition: "completed" });
    }
    if (url.endsWith("/complete") || url.startsWith("/api/v1/operations/")) {
      state.phase = "completed";
      state.operation = operationId;
      return Response.json({
        id: operationId,
        state: "committed",
        result: { status: 201, nodeId: "file" },
      });
    }
    if (init?.method === "DELETE") state.phase = "aborting";
    return Response.json(receipt());
  };
  const fetcher = vi.fn(route);
  vi.stubGlobal("fetch", fetcher);
  const client = new PublicClient("share", null),
    progress: UploadProgress[] = [];
  const run = (
    action: "continue" | "check" | "cancel" = "continue",
    selected: File | undefined = file,
    signal = new AbortController().signal,
  ) =>
    transferPublicUpload(
      client,
      record,
      action,
      selected,
      signal,
      (value) => progress.push(value),
      store,
    );
  return {
    file,
    record,
    store,
    state,
    receipt,
    route,
    fetcher,
    client,
    progress,
    run,
    saved: () => saved,
    putCount: () => fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").length,
  };
}
it.each(["", "abc"])(
  "uploads a single file once and removes its terminal capability: %j",
  async (value) => {
    const t = await setup(value);
    await t.run();
    expect(t.putCount()).toBe(1);
    expect(t.progress.at(-1)).toMatchObject({ phase: "completed", bytes: t.file.size });
    expect(t.saved()).toBeUndefined();
    for (const [url, init] of t.fetcher.mock.calls) {
      expect(url).toContain("/api/v1/public/shares/share/");
      if (!url.endsWith("/csrf"))
        expect(init?.headers).toMatchObject({ "Share-Session": "session" });
    }
  },
);
it("recovers an unknown reservation with its original key without dispatching bytes on check", async () => {
  const t = await setup();
  let lost = true;
  t.fetcher.mockImplementation(async (url, init) => {
    const response = await t.route(url, init);
    if (url.endsWith("/uploads") && lost) {
      lost = false;
      throw new TypeError("lost");
    }
    return response;
  });
  await expect(t.run()).rejects.toThrow();
  expect(t.saved()?.uploadId).toBeUndefined();
  await t.run("check", undefined);
  expect(t.putCount()).toBe(0);
  await t.run();
  const creates = t.fetcher.mock.calls.filter(([url]) => url.endsWith("/uploads"));
  expect(creates).toHaveLength(2);
  expect(creates[0]![1]?.body).toBe(creates[1]![1]?.body);
  expect(
    creates.map(([, init]) => (init!.headers as Record<string, string>)["Idempotency-Key"]),
  ).toEqual([t.record.createKey, t.record.createKey]);
  expect(t.putCount()).toBe(1);
});
it("does not replay a single PUT after a lost response; it can finish without reselecting bytes", async () => {
  const t = await setup();
  t.fetcher.mockImplementation(async (url, init) => {
    const response = await t.route(url, init);
    if (init?.method === "PUT") throw new TypeError("lost");
    return response;
  });
  await expect(t.run()).rejects.toThrow();
  await t.run("check", undefined);
  expect(t.progress.at(-1)?.phase).toBe("paused");
  await t.run("continue", undefined);
  expect(t.putCount()).toBe(1);
  expect(t.saved()).toBeUndefined();
});
it("never resends an unconfirmed single dispatch and can explicitly cancel it", async () => {
  const t = await setup();
  t.fetcher.mockImplementation((url, init) => {
    if (init?.method === "PUT") throw new TypeError("not delivered");
    return t.route(url, init);
  });
  await expect(t.run()).rejects.toThrow();
  await expect(t.run()).rejects.toThrow("再送せず");
  expect(t.putCount()).toBe(1);
  await t.run("cancel", undefined);
  expect(t.progress.at(-1)?.phase).toBe("stopped");
});
it("looks up a known completion operation without issuing a second POST", async () => {
  const t = await setup();
  t.fetcher.mockImplementation((url, init) =>
    url.endsWith("/complete")
      ? Promise.resolve(
          Response.json({}, { status: 503, headers: { "Operation-Id": operationId } }),
        )
      : t.route(url, init),
  );
  await expect(t.run()).rejects.toThrow();
  expect(t.saved()?.operationId).toBe(operationId);
  await t.run("check", undefined);
  expect(t.fetcher.mock.calls.filter(([url]) => url.endsWith("/complete"))).toHaveLength(1);
  expect(t.fetcher.mock.calls.at(-1)![1]?.headers).toMatchObject({
    "X-Share-Id": "share",
    "Share-Session": "session",
  });
  expect(t.saved()).toBeUndefined();
});
it("resumes a multipart upload by skipping a confirmed part after response loss", async () => {
  const t = await setup("abc", "multipart");
  t.fetcher.mockImplementation(async (url, init) => {
    const response = await t.route(url, init);
    if (init?.method === "PUT") throw new TypeError("lost part response");
    return response;
  });
  await expect(t.run()).rejects.toThrow();
  await t.run();
  expect(t.putCount()).toBe(1);
  expect(t.saved()).toBeUndefined();
});
it("reports confirmed multipart bytes after reload without redispatching", async () => {
  const t = await setup("abc", "multipart");
  t.fetcher.mockImplementation(async (url, init) => {
    const response = await t.route(url, init);
    if (init?.method === "PUT") throw new TypeError("lost response");
    return response;
  });
  await expect(t.run()).rejects.toThrow();
  await t.run("check", undefined);
  expect(t.progress.at(-1)).toMatchObject({ phase: "paused", bytes: 3 });
  expect(t.putCount()).toBe(1);
  expect(t.fetcher.mock.calls.some(([url]) => url.endsWith("/complete"))).toBe(false);
  expect(t.saved()).toBeDefined();
});
it("pins overwrite revision, hidden parent and blob ETag", async () => {
  const t = await setup();
  t.record.parentId = null;
  t.record.target = { id: "target", revision: 7, blobId: "before" };
  t.record.name = "保存先.txt";
  await t.store.save(t.record);
  await t.run();
  const body = JSON.parse(
    t.fetcher.mock.calls.find(([url]) => url.endsWith("/uploads"))![1]!.body as string,
  );
  expect(body).toMatchObject({ targetId: "target", targetRevision: 7, name: "保存先.txt" });
  expect(body).not.toHaveProperty("parentId");
  expect(
    t.fetcher.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.headers,
  ).toMatchObject({ "If-Match": '"b-before"' });
});
it("refuses a changed source file with otherwise identical metadata", async () => {
  const t = await setup();
  await expect(
    t.run("continue", new File(["xyz"], t.file.name, { lastModified: 1000 })),
  ).rejects.toThrow("元のファイル");
  expect(t.fetcher).not.toHaveBeenCalled();
});
it("requires a persisted dispatch intent before sending any bytes", async () => {
  const t = await setup();
  t.store.save.mockImplementation(async (r) => {
    if (r.singleDispatched) throw new Error("disk failed");
  });
  await expect(t.run()).rejects.toThrow("disk failed");
  expect(t.putCount()).toBe(0);
});
it("stops a mutation after logout during CSRF acquisition", async () => {
  const t = await setup();
  t.fetcher.mockImplementation(async () => {
    t.client.close();
    return Response.json({ token: "csrf" });
  });
  await expect(t.run()).rejects.toMatchObject({ name: "AbortError" });
  expect(t.fetcher).toHaveBeenCalledTimes(1);
});
it.each(["session", "lock", "expiry"])(
  "rejects an unavailable %s before HTTP dispatch",
  async (change) => {
    const t = await setup();
    if (change === "session") await t.store.save({ ...t.record, sessionId: "different" });
    if (change === "expiry") await t.store.save({ ...t.record, expiresAt: 1 });
    if (change === "lock")
      vi.stubGlobal("navigator", {
        locks: {
          request: async (_: string, _o: object, callback: (l: null) => Promise<void>) =>
            callback(null),
        },
      });
    await expect(t.run()).rejects.toThrow();
    expect(t.fetcher).not.toHaveBeenCalled();
  },
);
it.each(["geometry", "cursor", "in_flight", "unknown"])(
  "refuses unsafe multipart %s without transfer or completion",
  async (kind) => {
    const t = await setup("abc", "multipart");
    t.fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith(uploadId)) {
        const r = t.receipt();
        return Response.json({
          ...r,
          ...(kind === "geometry"
            ? { partBytes: 1 }
            : kind === "cursor"
              ? { nextAfter: 0 }
              : {
                  parts: [
                    {
                      partNumber: 1,
                      state: kind,
                      expectedBytes: 3,
                      attempts: 1,
                      attemptId: "original",
                    },
                  ],
                }),
        });
      }
      return t.route(url, init);
    });
    await expect(t.run()).rejects.toThrow();
    expect(t.putCount()).toBe(0);
    expect(t.fetcher.mock.calls.some(([url]) => url.endsWith("/complete"))).toBe(false);
  },
);
it.each([401, 403, 404, 412, 507])(
  "retains original intent after HTTP %s without automatic retry",
  async (status) => {
    const t = await setup();
    t.fetcher.mockImplementation(async (url) =>
      url.endsWith("/csrf") ? Response.json({ token: "csrf" }) : Response.json({}, { status }),
    );
    await expect(t.run()).rejects.toMatchObject({ status });
    expect(t.fetcher).toHaveBeenCalledTimes(2);
    expect(t.saved()).toEqual(t.record);
  },
);
it("rejects corrupt persisted geometry and capability pairs", async () => {
  const t = await setup();
  expect(validPublicUpload(t.record)).toBe(true);
  for (const change of [
    { size: -1 },
    { parentId: null },
    { attempts: [] },
    { mode: "other" },
    { capability },
    { uploadId },
    { target: { id: "target", blobId: "blob", revision: 0 } },
  ])
    expect(validPublicUpload({ ...t.record, ...change })).toBe(false);
});
