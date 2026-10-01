import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

const account = {
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
};

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
    .mockResolvedValueOnce(Response.json({ id: "sh_group", actions: ["read"] }))
    .mockResolvedValueOnce(Response.json({ id: "sh_group", resharePolicy: { enabled: true } }));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  await api.createInternalShare(
    "folder",
    "space",
    { email: "member@example.invalid" },
    ["read", "download", "create", "edit"],
    30,
    {
      enabled: true,
      actions: ["read", "create", "edit"],
      maxDepth: 2,
      maxFanout: 5,
      ttlDays: 7,
    },
  );
  await api.createInternalShare("folder", "space", { groupId: "group" }, ["read"], 7);
  await api.updateInternalShare("sh_group", { actions: ["read", "create", "edit"] });
  await api.updateInternalShare("sh_group", {
    resharePolicy: {
      enabled: true,
      actions: ["read", "create"],
      maxDepth: 3,
      maxFanout: 8,
    },
  });
  expect(fetcher.mock.calls.slice(1).map(([path, init]) => [path, init.method])).toEqual([
    ["/api/v1/shares", "POST"],
    ["/api/v1/shares", "POST"],
    ["/api/v1/shares/sh_group", "PATCH"],
    ["/api/v1/shares/sh_group", "PATCH"],
  ]);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    kind: "internal",
    rootNodeId: "folder",
    spaceId: "space",
    recipientEmail: "member@example.invalid",
    actions: ["read", "download", "create", "edit"],
    ttlDays: 30,
    resharePolicy: {
      enabled: true,
      actions: ["read", "create", "edit"],
      maxDepth: 2,
      maxFanout: 5,
      ttlDays: 7,
    },
  });
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    kind: "internal",
    rootNodeId: "folder",
    spaceId: "space",
    recipientGroupId: "group",
    actions: ["read"],
    ttlDays: 7,
  });
  expect(JSON.parse(fetcher.mock.calls[3]![1].body)).toEqual({
    actions: ["read", "create", "edit"],
  });
  expect(JSON.parse(fetcher.mock.calls[4]![1].body)).toEqual({
    resharePolicy: {
      enabled: true,
      actions: ["read", "create"],
      maxDepth: 3,
      maxFanout: 8,
    },
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

it("uses private abortable requests for app-password list, creation and revoke", async () => {
  const created = {
    id: "ap_00000000000000000000000000",
    credentialId: "ap:ap_00000000000000000000000000",
    name: "DAV client",
    rootNodeId: "folder",
    createdAt: 1,
    expiresAt: 2,
    scopes: ["node:read", "node:write"],
    secret: "secret",
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ passwords: [] }))
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(Response.json(created, { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient();
  await expect(client.appPasswords()).resolves.toEqual({ passwords: [] });
  await expect(
    client.createAppPassword({
      name: "DAV client",
      scopes: ["node:read", "node:write"],
      ttlDays: 30,
      spaceId: "space",
      rootNodeId: "folder",
    }),
  ).resolves.toEqual(created);
  await expect(client.revokeAppPassword(created.credentialId)).resolves.toBeUndefined();
  expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
    ["/api/v1/app-passwords", "GET"],
    ["/api/v1/csrf", "POST"],
    ["/api/v1/app-passwords", "POST"],
    ["/api/v1/app-passwords/ap%3Aap_00000000000000000000000000", "DELETE"],
  ]);
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    name: "DAV client",
    scopes: ["node:read", "node:write"],
    ttlDays: 30,
    spaceId: "space",
    rootNodeId: "folder",
  });
  for (const call of [fetcher.mock.calls[2]!, fetcher.mock.calls[3]!])
    expect(call[1].headers["X-CSRF-Token"]).toBe("csrf");
});

it("does not dispatch a stale app-password creation after its caller aborts", async () => {
  let finishCsrf!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finishCsrf = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const creation = new ApiClient().createAppPassword(
    { name: "stale", scopes: ["node:read"], ttlDays: 30 },
    controller.signal,
  );
  controller.abort();
  finishCsrf(Response.json({ token: "csrf" }));
  await expect(creation).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
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

it("prepares a private ZIP through the content origin and returns the app redirect", async () => {
  const expiresAt = Date.now() + 300_000;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json(
        {
          ticket: "signed-ticket",
          ticketId: "ticket",
          targetSetId: "target-set",
          expiresAt,
        },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const prepared = await new ApiClient().prepareZip(account, "folder/id", "zip-key");
  expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/nodes/folder%2Fid/zip");
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: "POST", body: "{}" });
  expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
    "Idempotency-Key": "zip-key",
    "X-CSRF-Token": "csrf",
  });
  expect(fetcher.mock.calls[2]![0]).toBe("https://content.example.invalid/session");
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ ticket: "signed-ticket" });
  expect(fetcher.mock.calls[3]![0]).toBe("https://content.example.invalid/z/target-set");
  expect(fetcher.mock.calls[3]![1]).toMatchObject({
    method: "HEAD",
    credentials: "include",
    redirect: "error",
  });
  expect(prepared).toMatchObject({
    ticketId: "ticket",
    targetSetId: "target-set",
    expiresAt,
    downloadUrl: "/api/v1/zips/target-set",
  });
  await prepared.cancel();
  await prepared.cancel();
  expect(fetcher.mock.calls[4]![0]).toBe("/api/v1/tickets/ticket");
  expect(fetcher.mock.calls[4]![1]).toMatchObject({ method: "DELETE" });
  expect(fetcher.mock.calls[4]![1].body).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it("keeps a budget-limited private ZIP available for an idempotent retry", async () => {
  const publication = {
    ticket: "signed-ticket",
    ticketId: "ticket",
    targetSetId: "target-set",
    expiresAt: Date.now() + 300_000,
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(Response.json(publication))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 429 }))
    .mockResolvedValueOnce(Response.json(publication))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient();
  await expect(client.prepareZip(account, "folder", "zip-key")).rejects.toEqual(
    new ApiError(429, "budget_exceeded"),
  );
  const retried = await client.prepareZip(account, "folder", "zip-key");
  expect(fetcher.mock.calls[1]![1].headers["Idempotency-Key"]).toBe("zip-key");
  expect(fetcher.mock.calls[4]![1].headers["Idempotency-Key"]).toBe("zip-key");
  await retried.cancel();
  expect(fetcher.mock.calls[7]![0]).toBe("/api/v1/tickets/ticket");
});

it("cancels a private ZIP ticket when a newer request aborts preparation", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const contentRequest = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json({
        ticket: "signed-ticket",
        ticketId: "ticket",
        targetSetId: "target-set",
        expiresAt: Date.now() + 300_000,
      }),
    )
    .mockImplementationOnce((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      entered();
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    })
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const preparation = new ApiClient().prepareZip(account, "folder", "zip-key", controller.signal);
  await contentRequest;
  controller.abort();
  await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  expect(fetcher.mock.calls[3]![0]).toBe("/api/v1/tickets/ticket");
});

it.each([
  [413, "payload_too_large"],
  [415, "unsupported_media_type"],
])("keeps private ZIP creation error %s actionable", async (status, code) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ token: "csrf" }))
      .mockResolvedValueOnce(Response.json({ title: code }, { status })),
  );
  await expect(new ApiClient().prepareZip(account, "folder", "zip-key")).rejects.toEqual(
    new ApiError(status, code),
  );
});
