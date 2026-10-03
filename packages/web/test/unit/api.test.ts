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

it("uses the encryption registry challenge and account-scoped lookup routes", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ keys: [] }))
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json(
        { id: "challenge-id", ciphertext: "ciphertext", expiresAt: 99 },
        { status: 201 },
      ),
    )
    .mockResolvedValueOnce(Response.json({ keys: [] }));
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient();
  await client.encryptionAdminKeys();
  await client.createEncryptionKeyChallenge(
    { fingerprint: "rsa-fingerprint", spki: "rsa-spki" },
    { fingerprint: "sign-fingerprint", spki: "sign-spki" },
  );
  await client.encryptionKeys("owner/id");
  expect(fetcher.mock.calls[0]![0]).toBe("/api/v1/encryption/admin-keys");
  expect(fetcher.mock.calls[2]![0]).toBe("/api/v1/encryption/keys/challenge");
  expect(JSON.parse(String(fetcher.mock.calls[2]![1].body))).toEqual({
    recipient: { fingerprint: "rsa-fingerprint", spki: "rsa-spki" },
    signer: { fingerprint: "sign-fingerprint", spki: "sign-spki" },
  });
  expect(fetcher.mock.calls[3]![0]).toBe("/api/v1/encryption/keys/owner%2Fid");
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

it("issues an audited admin content ticket and exchanges it for the owner's content session", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json({ ticket: "admin-ticket", ticketId: "ticket-id" }, { status: 201 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  const owner = {
    id: "owner/id",
    email: "owner@example.invalid",
    spaceId: "owner-space",
    rootNodeId: "root",
    quotaBytes: 100,
    usedBytes: 1,
    disabled: false,
  };
  const account = { ...accountFixture, contentOrigin: "https://content.example.invalid" };
  const session = await api.prepareAdminContentSession(
    owner,
    { id: "file/id", currentBlobId: "blob/id" },
    "download",
    account,
  );
  expect(fetcher.mock.calls[1]![0]).toBe("/api/v1/admin/users/owner%2Fid/content-session");
  expect(JSON.parse(String(fetcher.mock.calls[1]![1].body))).toEqual({
    targets: [{ spaceId: "owner-space", nodeId: "file/id" }],
    purpose: "content",
    action: "download",
    ttlSeconds: 300,
  });
  expect(fetcher.mock.calls[2]![0]).toBe("https://content.example.invalid/session");
  expect(session.url({ id: "file/id", currentBlobId: "blob/id" })).toBe(
    "https://content.example.invalid/c/file%2Fid/blob%2Fid",
  );
  await session.cancel();
  expect(fetcher.mock.calls[3]![0]).toBe("/api/v1/tickets/ticket-id");
});

const accountFixture = {
  id: "admin",
  email: "admin@example.invalid",
  role: "app_admin",
  spaceId: "admin-space",
  rootNodeId: "admin-root",
  epoch: 1,
  quotaBytes: 100,
  usedBytes: 1,
  reservedBytes: 0,
  contentOrigin: "https://content.example.invalid",
};

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

it("uses private CSRF mutations for share groups and bounded downstream resharing", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(Response.json({ id: "group" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: "group", name: "Renamed" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({ id: "child-direct" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: "child-group" }, { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  await api.createGroup("Editors", ["alice@example.invalid", "bob@example.invalid"]);
  await api.updateGroup("group", {
    name: "Renamed",
    memberEmails: ["alice@example.invalid"],
  });
  await api.disableGroup("group");
  const source = {
    shareId: "source",
    root: {
      id: "folder",
      spaceId: "space",
      ownerId: "owner",
      name: "Shared",
      kind: "folder" as const,
      revision: 1,
    },
  };
  await api.createInternalReshare(
    source,
    { email: "carol@example.invalid" },
    ["read", "download"],
    5,
    "direct-key",
  );
  await api.createInternalReshare(source, { groupId: "group" }, ["read"], 3, "group-key");

  expect(fetcher.mock.calls.slice(1).map(([path, init]) => [path, init.method])).toEqual([
    ["/api/v1/groups", "POST"],
    ["/api/v1/groups/group", "PATCH"],
    ["/api/v1/groups/group", "DELETE"],
    ["/api/v1/shares", "POST"],
    ["/api/v1/shares", "POST"],
  ]);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    name: "Editors",
    memberEmails: ["alice@example.invalid", "bob@example.invalid"],
  });
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    name: "Renamed",
    memberEmails: ["alice@example.invalid"],
  });
  expect(JSON.parse(fetcher.mock.calls[4]![1].body)).toEqual({
    kind: "internal",
    sourceShareId: "source",
    rootNodeId: "folder",
    spaceId: "space",
    recipientEmail: "carol@example.invalid",
    actions: ["read", "download"],
    ttlDays: 5,
  });
  expect(fetcher.mock.calls[4]![1].headers["Idempotency-Key"]).toBe("direct-key");
  expect(JSON.parse(fetcher.mock.calls[5]![1].body)).toEqual({
    kind: "internal",
    sourceShareId: "source",
    rootNodeId: "folder",
    spaceId: "space",
    recipientGroupId: "group",
    actions: ["read"],
    ttlDays: 3,
  });
  expect(fetcher.mock.calls[5]![1].headers["Idempotency-Key"]).toBe("group-key");
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

it("uses private no-store media state reads and CSRF writes", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        nodeId: "track",
        blobId: "blob",
        durationMs: 10_000,
        positionMs: 2_000,
        updatedAt: 1,
      }),
    )
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json({
        nodeId: "track",
        blobId: "blob",
        durationMs: 10_000,
        positionMs: 3_000,
        updatedAt: 2,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        nodeId: "book",
        blobId: "epub",
        pageCount: 3,
        position: { spineIndex: 1, progress: 5_000 },
        updatedAt: 3,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        nodeId: "book",
        blobId: "epub",
        pageCount: 3,
        position: { spineIndex: 2, progress: 0 },
        updatedAt: 4,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const client = new ApiClient();
  await client.playbackState("track");
  await client.writePlaybackState("track", "blob", 3_000);
  await client.readingState("book");
  await client.writeReadingState("book", "epub", 2, 0);
  expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
    ["/api/v1/nodes/track/playback-state", "GET"],
    ["/api/v1/csrf", "POST"],
    ["/api/v1/nodes/track/playback-state", "PUT"],
    ["/api/v1/library/book/reading-state", "GET"],
    ["/api/v1/library/book/reading-state", "PUT"],
  ]);
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    blobId: "blob",
    positionMs: 3_000,
  });
  expect(JSON.parse(fetcher.mock.calls[4]![1].body)).toEqual({
    blobId: "epub",
    spineIndex: 2,
    progress: 0,
  });
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
