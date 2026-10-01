import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

it("does not dispatch a waiting mutation after logout invalidates its CSRF flight", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  const mutation = api.json("/api/v1/nodes", "POST", {}, "same-key");
  const rejected = expect(mutation).rejects.toMatchObject({ name: "AbortError" });
  api.clear();
  finish(Response.json({ token: "stale" }));
  await rejected;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("a late cancelled CSRF request cannot erase a newer deduplicated flight", async () => {
  const pending: Array<(response: Response) => void> = [];
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  const stale = api.csrf();
  const rejected = expect(stale).rejects.toMatchObject({ name: "AbortError" });
  api.clear();
  const fresh = api.csrf();
  pending[0]!(Response.json({ token: "old" }));
  await rejected;
  const deduped = api.csrf();
  expect(fetcher).toHaveBeenCalledTimes(2);
  pending[1]!(Response.json({ token: "new" }));
  expect(await fresh).toBe("new");
  expect(await deduped).toBe("new");
  expect(await api.csrf()).toBe("new");
});

it("reconciles commit uncertainty by operation ID without issuing another mutation", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json(
        { title: "commit_unknown" },
        { status: 503, headers: { "Operation-Id": "op_fixture" } },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ id: "op_fixture", state: "committed", result: { nodeId: "folder" } }),
    );
  vi.stubGlobal("fetch", fetcher);
  const result = await new ApiClient().mutation(
    "/api/v1/nodes",
    "POST",
    { name: "folder" },
    "original-key",
  );
  expect(result.state).toBe("committed");
  expect(fetcher.mock.calls[1]![1].headers["Idempotency-Key"]).toBe("original-key");
  expect(fetcher.mock.calls[2]![0]).toBe("/api/v1/operations/op_fixture");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("a still-claimed operation remains uncertain", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "csrf" }))
      .mockResolvedValueOnce(Response.json({ id: "op_fixture", state: "claimed", result: null })),
  );
  await expect(
    new ApiClient().mutation("/api/v1/nodes", "POST", {}, "original-key"),
  ).rejects.toEqual(new ApiError(503, "commit_unknown", "op_fixture"));
});

it("uses private CSRF mutations for direct and group internal shares", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(Response.json({ id: "sh_direct" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: "sh_group" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: "sh_group", actions: ["read"] }));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  await api.createInternalShare(
    "folder",
    "space",
    { email: "member@example.invalid" },
    ["read", "download"],
    30,
  );
  await api.createInternalShare("folder", "space", { groupId: "group" }, ["read"], 7);
  await api.updateInternalShareActions("sh_group", ["read"]);
  expect(fetcher.mock.calls.slice(1).map(([path, init]) => [path, init.method])).toEqual([
    ["/api/v1/shares", "POST"],
    ["/api/v1/shares", "POST"],
    ["/api/v1/shares/sh_group", "PATCH"],
  ]);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    kind: "internal",
    rootNodeId: "folder",
    spaceId: "space",
    recipientEmail: "member@example.invalid",
    actions: ["read", "download"],
    ttlDays: 30,
  });
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    kind: "internal",
    rootNodeId: "folder",
    spaceId: "space",
    recipientGroupId: "group",
    actions: ["read"],
    ttlDays: 7,
  });
  for (const [, init] of fetcher.mock.calls.slice(1))
    expect(init.headers["X-CSRF-Token"]).toBe("csrf");
});

it("cancels stale shared-mount reads with the caller signal", async () => {
  let signal!: AbortSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn((_path: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }),
  );
  const controller = new AbortController();
  const request = new ApiClient().sharedWithMe(controller.signal);
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(signal.aborted).toBe(true);
});

it("exchanges media tickets at the exact content origin and returns direct media URLs", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(Response.json({ ticket: "signed-ticket" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const target = { id: "image", currentBlobId: "blob" };
  const contentUrl = await new ApiClient().prepareContent(
    {
      id: "user",
      email: "user@example.invalid",
      role: "user",
      spaceId: "space",
      rootNodeId: "root",
      epoch: 1,
      quotaBytes: 100,
      usedBytes: 1,
      reservedBytes: 0,
      contentOrigin: "https://content.example.invalid",
    },
    [target],
    "thumb",
  );
  expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/content-session");
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    targets: [{ nodeId: "image", spaceId: "space" }],
    purpose: "thumb",
    ttlSeconds: 300,
  });
  expect(fetcher.mock.calls[2]![0]).toBe("https://content.example.invalid/session");
  expect(fetcher.mock.calls[2]![1]).toMatchObject({
    method: "POST",
    credentials: "include",
    redirect: "error",
  });
  expect(contentUrl(target)).toBe("https://content.example.invalid/c/image/blob/thumb");
});

it("rejects a non-HTTPS media origin before issuing a content ticket", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new ApiClient().prepareContent(
      {
        id: "user",
        email: "user@example.invalid",
        role: "user",
        spaceId: "space",
        rootNodeId: "root",
        epoch: 1,
        quotaBytes: 100,
        usedBytes: 1,
        reservedBytes: 0,
        contentOrigin: "http://content.example.invalid",
      },
      [{ id: "track", currentBlobId: "blob" }],
      "track",
    ),
  ).rejects.toThrow("invalid_content_origin");
  expect(fetcher).not.toHaveBeenCalled();
});
