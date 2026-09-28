import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../src/lib/api";

afterEach(() => vi.unstubAllGlobals());

it("reads and cancels the same accepted copy job, without creating a second copy", async () => {
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("/csrf") ? { token: "csrf" } : { id: "copy_job", state: "cancelled" },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient();
  await api.copyJob("copy_job");
  await api.cancelCopyJob("copy_job");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/jobs/copy_job",
    "/api/v1/csrf",
    "/api/v1/jobs/copy_job/cancel",
  ]);
  const cancel = vi.mocked(fetch).mock.calls.at(-1)![1]!;
  expect(cancel.method).toBe("POST");
  expect(cancel.headers).toMatchObject({
    "X-CSRF-Token": "csrf",
    "Content-Type": "application/json",
  });
  expect(cancel.body).toBe("{}");
});

it("keeps the selected share on node, breadcrumb and paginated children requests", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json({});
    }),
  );
  const api = new ApiClient();
  const share = { id: "share_1", version: 3 };
  await api.node("file", share);
  await api.path("file", undefined, share);
  await api.children("folder", "cursor+with/special=", undefined, share);
  for (const url of urls) {
    const query = new URL(url, "https://app.example.invalid").searchParams;
    expect(query.get("shareId")).toBe("share_1");
    expect(query.get("shareVersion")).toBe("3");
  }
  expect(new URL(urls[2]!, "https://app.example.invalid").searchParams.get("cursor")).toBe(
    "cursor+with/special=",
  );
  await api.children("own-folder");
  expect(urls.at(-1)).toBe("/api/v1/nodes/own-folder/children");
});

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

it("sends the persisted copy retry key and reconciles an uncertain receipt by operation ID", async () => {
  const job = "copy_" + "a".repeat(64),
    child = "copy_" + "b".repeat(64);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "csrf" }))
    .mockResolvedValueOnce(
      Response.json(
        { title: "commit_unknown" },
        { status: 503, headers: { "Operation-Id": "op_retry" } },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ id: "op_retry", state: "committed", result: { status: 202, jobId: child } }),
    );
  vi.stubGlobal("fetch", fetcher);
  const result = await new ApiClient().retryCopyJob(job, "saved-retry-key");
  expect(result.result?.jobId).toBe(child);
  expect(fetcher.mock.calls[1]![0]).toBe(`/api/v1/jobs/${job}/retry`);
  expect(fetcher.mock.calls[1]![1].headers["Idempotency-Key"]).toBe("saved-retry-key");
  expect(fetcher.mock.calls[1]![1].body).toBe("{}");
  expect(fetcher.mock.calls[2]![0]).toBe("/api/v1/operations/op_retry");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
