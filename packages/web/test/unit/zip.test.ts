import { afterEach, expect, it, vi } from "vitest";
import { zipDownloadPath } from "../../../shared/src/zips";
import { ApiClient, ApiError, zipErrorMessage } from "../../src/lib/api";
import { PublicClient, type SharedRoot } from "../../src/public-share/client";

afterEach(() => vi.unstubAllGlobals());
const receipt = { id: "ticket", size: 120, expiresAt: 123456789, url: "/api/v1/zips/ticket" };
const root: SharedRoot = {
  sessionId: "session",
  expiresAt: 123456789,
  contentOrigin: "https://content.invalid",
  permissions: {
    createFolder: false,
    rename: false,
    upload: false,
    overwrite: false,
    delete: false,
  },
  root: {
    id: "folder",
    name: "Folder",
    kind: "folder",
    currentBlobId: null,
    size: null,
    revision: 1,
  },
};
const popup = () => ({ location: { replace: vi.fn() }, close: vi.fn() });
function fixture(kind: "private" | "public", result: unknown = receipt) {
  vi.stubGlobal("location", { origin: "https://app.invalid" });
  const fetcher = vi.fn(async (url: string) =>
    Response.json(url.endsWith("/csrf") ? { token: "csrf" } : result),
  );
  vi.stubGlobal("fetch", fetcher);
  const target = popup(),
    api = new ApiClient(),
    client = new PublicClient("share", null);
  return {
    fetcher,
    target,
    close: () => (kind === "private" ? api.clear() : client.close()),
    run: () =>
      kind === "private"
        ? api.downloadZip("folder", target as unknown as Window, { id: "share", version: 2 })
        : client.downloadZip(root, "folder", target as unknown as Window),
  };
}

it.each([
  null,
  [],
  {},
  { ...receipt, id: "../escape" },
  { ...receipt, url: "https://app.invalid/api/v1/zips/ticket" },
  { ...receipt, url: "//evil.invalid/api/v1/zips/ticket" },
  { ...receipt, url: "/api/v1/zips/other" },
  { ...receipt, url: "/api/v1/zips/ticket?secret=x" },
  { ...receipt, url: "/api/v1/zips/ticket#secret" },
  { ...receipt, size: 21 },
  { ...receipt, size: 4_294_967_296 },
  { ...receipt, size: 22.5 },
  { ...receipt, expiresAt: 0 },
  { ...receipt, secret: "unexpected" },
])("rejects an invalid ZIP receipt %j", (input) => {
  expect(() => zipDownloadPath(input)).toThrow("invalid_zip_receipt");
});
it("binds the receipt to the private or exact public share route", () => {
  expect(zipDownloadPath(receipt)).toBe(receipt.url);
  const shared = { ...receipt, url: "/api/v1/public/shares/share/zips/ticket" };
  expect(zipDownloadPath(shared, "share")).toBe(shared.url);
  expect(() => zipDownloadPath(shared, "other")).toThrow();
  expect(() => zipDownloadPath(shared)).toThrow();
  expect(() => zipDownloadPath(shared, "../share")).toThrow();
});
it.each(["private", "public"] as const)(
  "%s saves via its credential, CSRF and validated app URL",
  async (kind) => {
    const prefix = kind === "private" ? "/api/v1" : "/api/v1/public/shares/share";
    const t = fixture(kind, { ...receipt, url: `${prefix}/zips/ticket` });
    await t.run();
    expect(t.fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${prefix}/csrf`,
      `${prefix}/nodes/folder/zip`,
    ]);
    const init = vi.mocked(fetch).mock.calls[1]![1]!;
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(init.headers).toMatchObject({
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual(
      kind === "private" ? { share: { id: "share", version: 2 } } : {},
    );
    if (kind === "public") expect(init.headers).toMatchObject({ "Share-Session": "session" });
    expect(t.target.location.replace).toHaveBeenCalledWith(
      `https://app.invalid${prefix}/zips/ticket`,
    );
    expect(t.target.close).not.toHaveBeenCalled();
  },
);
it.each(["private", "public"] as const)(
  "%s closes the popup on invalid URL without following it",
  async (kind) => {
    const t = fixture(kind, { ...receipt, url: "https://evil.invalid/" });
    await expect(t.run()).rejects.toThrow("invalid_zip_receipt");
    expect(t.target.close).toHaveBeenCalledOnce();
    expect(t.target.location.replace).not.toHaveBeenCalled();
  },
);
it.each(["private", "public"] as const)(
  "%s cannot navigate with a late receipt after logout",
  async (kind) => {
    const t = fixture(kind);
    let finish!: (value: Response) => void;
    t.fetcher.mockImplementationOnce(async () => Response.json({ token: "csrf" }));
    t.fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = t.run();
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(t.fetcher).toHaveBeenCalledTimes(2));
    t.close();
    finish(Response.json(receipt));
    await rejected;
    expect(t.target.location.replace).not.toHaveBeenCalled();
    expect(t.target.close).toHaveBeenCalledOnce();
  },
);
it.each(["private", "public"] as const)(
  "%s does not automatically retry a failed ZIP issue",
  async (kind) => {
    const t = fixture(kind);
    t.fetcher.mockImplementation(async (url) =>
      url.endsWith("/csrf")
        ? Response.json({ token: "csrf" })
        : Response.json({ title: "not_ready" }, { status: 503 }),
    );
    await expect(t.run()).rejects.toMatchObject({ status: 503 });
    expect(t.fetcher).toHaveBeenCalledTimes(2);
    expect(t.target.close).toHaveBeenCalledOnce();
  },
);
it("explains the ZIP entry limit and retains authentication error guidance", () => {
  expect(zipErrorMessage(new ApiError(413, "payload_too_large"))).toContain("1,000項目");
  expect(zipErrorMessage(new ApiError(429, "budget_exceeded"))).toContain("ダウンロードの利用上限");
  expect(zipErrorMessage(new ApiError(401, "unauthorized"))).toContain("ログイン");
});
