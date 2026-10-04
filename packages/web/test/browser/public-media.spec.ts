import { readFile } from "node:fs/promises";
import { expect, type Page, type Route, test } from "@playwright/test";

const shareId = "public-media";
const root = {
  id: "folder",
  spaceId: "space",
  name: "Public media",
  kind: "folder",
  currentBlobId: null,
  size: 0,
  updatedAt: 1_700_000_000_000,
};
const book = {
  id: "book",
  spaceId: "space",
  name: "Book.epub",
  kind: "file",
  currentBlobId: "book-blob",
  size: 1_024,
  updatedAt: 1_700_000_000_000,
};
const video = {
  id: "video",
  spaceId: "space",
  name: "Movie.mp4",
  kind: "file",
  currentBlobId: "video-blob",
  size: 2_048,
  updatedAt: 1_700_000_000_000,
};
const image = {
  id: "image",
  name: "Photo.jpg",
  currentBlobId: "image-blob",
  mime: "image/jpeg",
  size: 512,
  width: 640,
  height: 480,
  takenAt: null,
  updatedAt: 1_700_000_000_000,
  thumbnail: "ready",
};
const track = {
  id: "track",
  name: "Song.mp3",
  currentBlobId: "track-blob",
  mime: "audio/mpeg",
  durationMs: 125_000,
  codec: "mp3",
  title: "Public song",
  artist: "Public artist",
  album: null,
  trackNumber: null,
  discNumber: null,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockReadOnlyShare(page: Page) {
  const issued: Array<{ id: string; purpose: string }> = [];
  const cancelled: string[] = [];
  let serial = 0;
  await page.route("**/api/v1/public/shares/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/api/v1/public/shares/${shareId}` && request.method() === "GET")
      return json(route, {
        id: shareId,
        kind: "read_only",
        version: 1,
        expiresAt: null,
        createdAt: 1_700_000_000_000,
        contentOrigin: "https://content.ncf.test:8879",
        root,
        actions: ["read", "download"],
      });
    if (path.endsWith(`/shares/${shareId}/children/${root.id}`))
      return json(route, { children: [book, video], nextCursor: null });
    if (path.endsWith(`/shares/${shareId}/gallery`))
      return json(route, {
        rootId: root.id,
        recursive: true,
        items: [image],
        nextCursor: null,
        truncated: false,
        candidateLimit: 10_000,
      });
    if (path.endsWith(`/shares/${shareId}/tracks`))
      return json(route, {
        rootId: root.id,
        recursive: true,
        items: [track],
        nextCursor: null,
        limitReached: false,
        trackLimit: 2_000,
      });
    if (path.endsWith(`/shares/${shareId}/csrf`)) return json(route, { token: "csrf-token" }, 201);
    if (path.endsWith(`/shares/${shareId}/tickets`) && request.method() === "POST") {
      const purpose = String(request.postDataJSON().purpose);
      const id = `ticket-${++serial}`;
      issued.push({ id, purpose });
      return json(route, { ticketId: id, ticket: `signed-${id}` }, 201);
    }
    const cancelledTicket = path.match(/\/tickets\/([^/]+)$/)?.[1];
    if (cancelledTicket && request.method() === "DELETE") {
      cancelled.push(cancelledTicket);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith(`/shares/${shareId}/library/${book.id}`))
      return json(route, {
        nodeId: book.id,
        blobId: book.currentBlobId,
        title: "Public book",
        author: "Public author",
        pageCount: 2,
        spine: ["chapter-one", "chapter-two"],
        entries: [{ token: "chapter-one" }, { token: "chapter-two" }],
        ticketPurpose: "page",
      });
    if (path.endsWith(`/shares/${shareId}/nodes/${root.id}/zip`))
      return json(
        route,
        {
          ticketId: "zip-ticket",
          ticket: "signed-zip-ticket",
          targetSetId: "zip-target",
        },
        201,
      );
    if (path.endsWith(`/shares/${shareId}/zips/zip-target`))
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="Public-media.zip"',
          "Content-Type": "application/zip",
        },
        body: "bounded-zip",
      });
    return route.fulfill({ status: 404 });
  });
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({ status: 201 }),
  );
  await page.route("https://content.ncf.test:8879/c/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "HEAD") {
      const type = url.pathname.includes(`/${video.id}/`) ? "video/mp4" : "audio/mpeg";
      return route.fulfill({ status: 200, headers: { "Content-Type": type } });
    }
    if (url.pathname.endsWith("/entries/chapter-one"))
      return route.fulfill({
        status: 200,
        contentType: "application/xhtml+xml",
        body: "<html xmlns='http://www.w3.org/1999/xhtml'><body>First safe chapter</body></html>",
      });
    if (url.pathname.endsWith("/entries/chapter-two"))
      return route.fulfill({
        status: 200,
        contentType: "application/xhtml+xml",
        body: "<html xmlns='http://www.w3.org/1999/xhtml'><body>Second safe chapter</body></html>",
      });
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  return { issued, cancelled };
}

test("public read-only shares expose media surfaces and replace stale tickets", async ({
  page,
}) => {
  const calls = await mockReadOnlyShare(page);
  await page.goto(`/s/${shareId}`);

  await expect(page.getByRole("tab", { name: "ファイル" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "読む" })).toBeVisible();
  await expect(page.getByRole("button", { name: "再生" })).toBeVisible();

  await page.getByRole("tab", { name: "ギャラリー" }).click();
  await expect(page.getByRole("button", { name: /Photo.jpg/ })).toBeVisible();
  await expect.poll(() => calls.issued.map((entry) => entry.purpose)).toContain("thumb");
  await page.getByRole("button", { name: /Photo.jpg/ }).click();
  await expect(page.getByRole("dialog", { name: "Photo.jpg" })).toBeVisible();
  await expect.poll(() => calls.issued.map((entry) => entry.purpose)).toContain("content");
  await page
    .getByRole("dialog", { name: "Photo.jpg" })
    .getByRole("button", { name: "閉じる" })
    .click();

  await page.getByRole("tab", { name: "オーディオ" }).click();
  await page.getByRole("button", { name: /Public song/ }).click();
  await expect(page.locator("audio")).toHaveAttribute(
    "src",
    `https://content.ncf.test:8879/c/${track.id}/${track.currentBlobId}/track`,
  );
  await expect(page.getByText("Public song · 2:05")).toBeVisible();

  await page.getByRole("tab", { name: "ファイル" }).click();
  await page.getByRole("button", { name: "読む" }).click();
  const reader = page.getByRole("dialog", { name: "Book.epub" });
  await expect(reader.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(reader.locator("iframe")).toHaveAttribute("srcdoc", /First safe chapter/);
  const firstPageTicket = calls.issued.filter((entry) => entry.purpose === "page").at(-1)?.id;
  expect(firstPageTicket).toBeTruthy();
  await reader.getByRole("button", { name: "次の章" }).click();
  await expect(reader.locator("iframe")).toHaveAttribute("srcdoc", /Second safe chapter/);
  await expect.poll(() => calls.cancelled).toContain(firstPageTicket as string);
  await reader.getByRole("button", { name: "閉じる" }).click();

  await page.getByRole("button", { name: "再生" }).click();
  const videoDialog = page.getByRole("dialog", { name: "Movie.mp4" });
  await expect(videoDialog.locator("video")).toHaveAttribute(
    "src",
    `https://content.ncf.test:8879/c/${video.id}/${video.currentBlobId}/track`,
  );
  await videoDialog.locator("video").dispatchEvent("error");
  await expect(videoDialog.getByText("ネイティブ再生に失敗しました。")).toBeVisible();
  await videoDialog.getByRole("button", { name: "閉じる" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ZIPをダウンロード" }).click();
  const archive = await download;
  expect(archive.suggestedFilename()).toBe("Public-media.zip");
  expect(await readFile(await archive.path(), "utf8")).toBe("bounded-zip");
  await page.getByRole("tab", { name: "ギャラリー" }).click();
  await expect.poll(() => calls.cancelled).toContain("zip-ticket");
  expect(calls.issued.map((entry) => entry.purpose)).toEqual(
    expect.arrayContaining(["thumb", "content", "track", "page"]),
  );
});

test("upload-only shares do not expose read-only media or download surfaces", async ({ page }) => {
  await page.route("**/api/v1/public/shares/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/v1/public/shares/${shareId}`)
      return json(route, {
        id: shareId,
        kind: "upload_only",
        version: 1,
        expiresAt: null,
        createdAt: 1_700_000_000_000,
        actions: ["create", "upload"],
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`/s/${shareId}`);
  await expect(page.getByRole("heading", { name: "ファイル受け取り" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ZIPをダウンロード" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "読む" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "再生" })).toHaveCount(0);
});

test("public media failures render explicit fail-closed fallback states", async ({ page }) => {
  await mockReadOnlyShare(page);
  await page.route(`**/api/v1/public/shares/${shareId}/gallery*`, (route) =>
    route.fulfill({ status: 401 }),
  );
  await page.route(`**/api/v1/public/shares/${shareId}/library/${book.id}`, (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.route(
    `https://content.ncf.test:8879/c/${video.id}/${video.currentBlobId}/track`,
    (route) =>
      route.request().method() === "HEAD"
        ? route.fulfill({ status: 200, headers: { "Content-Type": "application/octet-stream" } })
        : route.fulfill({ status: 404 }),
  );
  await page.goto(`/s/${shareId}`);

  await page.getByRole("tab", { name: "ギャラリー" }).click();
  await expect(page.getByText("共有が再ロックされたか")).toBeVisible();
  await page.getByRole("tab", { name: "ファイル" }).click();
  await page.getByRole("button", { name: "読む" }).click();
  await expect(page.getByText("共有が停止・期限切れになったか")).toBeVisible();
  await page.getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("button", { name: "再生" }).click();
  await expect(page.getByText("このコンテナまたはコーデック")).toBeVisible();
});

test("file-root shares only expose the files view", async ({ page }) => {
  const requested: string[] = [];
  const fileRoot = { ...video, id: "single", name: "Single.mp4", currentBlobId: "single-blob" };
  await page.route("**/api/v1/public/shares/**", (route) => {
    const url = new URL(route.request().url());
    requested.push(url.pathname);
    if (url.pathname === `/api/v1/public/shares/${shareId}`)
      return json(route, {
        id: shareId,
        kind: "read_only",
        version: 1,
        expiresAt: null,
        createdAt: 1_700_000_000_000,
        contentOrigin: "https://content.ncf.test:8879",
        root: fileRoot,
        actions: ["read", "download"],
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`/s/${shareId}`);
  await expect(page.getByRole("tab", { name: "ファイル" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "▤ Single.mp4" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "ギャラリー" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "オーディオ" })).toHaveCount(0);
  expect(requested.some((path) => /\/(gallery|tracks)$/.test(path))).toBe(false);
});
