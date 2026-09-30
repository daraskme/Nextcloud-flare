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
