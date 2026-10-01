import { expect, type Page, test } from "@playwright/test";

const candidate = (id: string, name: string, mime: string) => ({
  id,
  parentId: "root",
  name,
  kind: "file",
  revision: 1,
  currentBlobId: `blob-${id}`,
  updatedAt: Date.now(),
  size: 1024,
  mime,
});

const searchPage = (items: ReturnType<typeof candidate>[]) => ({
  scopeId: "root",
  query: "",
  treeGeneration: 1,
  items,
  nextCursor: null,
  truncated: false,
});

const account = {
  id: "user",
  email: "private@example.invalid",
  role: "owner",
  spaceId: "space",
  rootNodeId: "root",
  epoch: 1,
  quotaBytes: 2_000_000_000,
  usedBytes: 0,
  reservedBytes: 0,
  contentOrigin: "https://content.ncf.test:8879",
};

async function mockPrivateShell(page: Page) {
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, json: account }));
  await page.route("**/api/v1/csrf", (route) =>
    route.fulfill({ status: 200, json: { token: "media-test-csrf" } }),
  );
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("private Audio preserves terminal zero when selecting the next track", async ({ page }) => {
  await mockPrivateShell(page);
  const first = {
    ...candidate("audio-1", "First Track.opus", "audio/ogg"),
    durationMs: 120_000,
    codec: "opus",
    title: "First Track",
    artist: null,
    album: null,
    trackNumber: 1,
    discNumber: 1,
  };
  const second = {
    ...candidate("audio-2", "Second Track.opus", "audio/ogg"),
    durationMs: 120_000,
    codec: "opus",
    title: "Second Track",
    artist: null,
    album: null,
    trackNumber: 2,
    discNumber: 1,
  };
  const writes: number[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get() {
        return 120;
      },
    });
    HTMLMediaElement.prototype.play = async function () {
      this.dispatchEvent(new Event("play"));
    };
    HTMLMediaElement.prototype.pause = function () {
      this.dispatchEvent(new Event("pause"));
    };
  });
  await page.route("**/api/v1/nodes/root/tracks?*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        rootId: "root",
        treeGeneration: 1,
        recursive: true,
        items: [first, second],
        nextCursor: null,
        limitReached: false,
        trackLimit: 2,
      },
    }),
  );
  await page.route("**/api/v1/nodes/*/playback-state", (route) => {
    const nodeId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const track = nodeId === first.id ? first : second;
    if (route.request().method() === "GET")
      return route.fulfill({
        status: 200,
        json: {
          nodeId,
          blobId: track.currentBlobId,
          durationMs: track.durationMs,
          positionMs: nodeId === first.id ? 12_000 : null,
          updatedAt: nodeId === first.id ? 1 : null,
        },
      });
    writes.push(route.request().postDataJSON().positionMs);
    return route.fulfill({
      status: 200,
      json: {
        nodeId,
        blobId: track.currentBlobId,
        durationMs: track.durationMs,
        positionMs: writes.at(-1),
        updatedAt: Date.now(),
      },
    });
  });
  await page.route("**/api/v1/content-session", (route) =>
    route.fulfill({
      status: 201,
      json: { ticket: crypto.randomUUID(), ticketId: crypto.randomUUID() },
    }),
  );
  await page.route("**/api/v1/tickets/*", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({
      status: 201,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
      },
      body: "",
    }),
  );

  await page.goto("/files");
  await page.getByRole("link", { name: "オーディオ", exact: true }).click();
  await page.getByRole("button", { name: /First Track/ }).click();
  const audio = page.locator("audio");
  await audio.dispatchEvent("loadedmetadata");
  await expect
    .poll(() => audio.evaluate((element) => (element as HTMLMediaElement).currentTime))
    .toBe(12);
  await audio.evaluate((element) => {
    const media = element as HTMLMediaElement;
    media.currentTime = 24;
    media.dispatchEvent(new Event("timeupdate"));
  });
  await page.waitForTimeout(4_000);
  expect(writes).toEqual([]);
  await expect.poll(() => writes, { timeout: 2_000 }).toEqual([24_000]);
  await audio.evaluate((element) => {
    const media = element as HTMLMediaElement;
    media.currentTime = 31;
    media.dispatchEvent(new Event("pause"));
  });
  await expect.poll(() => writes).toEqual([24_000, 31_000]);
  await audio.evaluate((element) => {
    const media = element as HTMLMediaElement;
    media.currentTime = 78;
    media.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByText("Second Track", { exact: true }).first()).toBeVisible();
  await expect.poll(() => writes).toEqual([24_000, 31_000, 0]);
});

test("private Bookshelf replaces stale page tickets and rejects unsupported books", async ({
  page,
}) => {
  await mockPrivateShell(page);
  const book = candidate("book-1", "Private Book.epub", "application/epub+zip");
  const unsupported = candidate("book-2", "Scanned Book.pdf", "application/pdf");
  const issued: string[] = [];
  const cancelled: string[] = [];
  await page.route("**/api/v1/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    const items = query === ".epub" ? [book] : query === ".pdf" ? [unsupported] : [];
    return route.fulfill({ status: 200, json: searchPage(items) });
  });
  await page.route("**/api/v1/library/book-1", (route) =>
    route.fulfill({
      status: 200,
      json: {
        nodeId: book.id,
        blobId: book.currentBlobId,
        title: "Private Book",
        author: "Private Author",
        series: null,
        pageCount: 2,
        coverToken: null,
        spine: ["chapter-one", "chapter-two"],
        entries: [
          {
            token: "chapter-one",
            path: "OPS/one.xhtml",
            mime: "application/xhtml+xml",
            size: 100,
          },
          {
            token: "chapter-two",
            path: "OPS/two.xhtml",
            mime: "application/xhtml+xml",
            size: 100,
          },
        ],
        ticketPurpose: "page",
        contentBaseUrl: `${book.id}/${book.currentBlobId}/entries/`,
      },
    }),
  );
  await page.route("**/api/v1/content-session", (route) => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({
      purpose: "page",
      targets: [{ nodeId: book.id }],
    });
    const ticketId = `page-${issued.length + 1}`;
    issued.push(ticketId);
    return route.fulfill({ status: 201, json: { ticket: `token-${ticketId}`, ticketId } });
  });
  await page.route("**/api/v1/tickets/*", (route) => {
    cancelled.push(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({
      status: 201,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
        "Set-Cookie": "ncf_content=fixture; Path=/; Secure; SameSite=None",
      },
      body: "",
    }),
  );
  await page.route("https://content.ncf.test:8879/c/**/entries/chapter-one", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route
      .fulfill({
        status: 200,
        headers: {
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
          "Content-Type": "application/octet-stream",
        },
        body: "<html><body><h1>Chapter One</h1><p>First page.</p></body></html>",
      })
      .catch(() => undefined);
  });
  await page.route("https://content.ncf.test:8879/c/**/entries/chapter-two", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
        "Content-Type": "application/octet-stream",
      },
      body: "<html><body><h1>Chapter Two</h1><p>Second page.</p></body></html>",
    }),
  );

  await page.goto("/files");
  await page.getByRole("link", { name: "本棚", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本棚", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "本棚", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Private Book.epubを開く", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "目次" })).toBeVisible();
  await expect(page.getByText("章を読み込んでいます", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "次の章", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("body")).toContainText("Chapter Two");
  expect(issued).toEqual(["page-1", "page-2"]);
  await expect.poll(() => cancelled).toContain("page-1");
  await page.getByRole("button", { name: "リーダーを閉じる", exact: true }).click();
  await expect.poll(() => cancelled).toContain("page-2");
  await page.getByRole("button", { name: "Scanned Book.pdfを開く", exact: true }).click();
  await expect(page.getByRole("heading", { name: "この本はリーダーで開けません" })).toBeVisible();
});

test("private Bookshelf resumes and debounces bounded progress on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPrivateShell(page);
  const book = candidate("book-resume", "Resume Book.epub", "application/epub+zip");
  const writes: Array<{ blobId: string; spineIndex: number; progress: number }> = [];
  await page.route("**/api/v1/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({
      status: 200,
      json: searchPage(query === ".epub" ? [book] : []),
    });
  });
  await page.route("**/api/v1/library/book-resume", (route) =>
    route.fulfill({
      status: 200,
      json: {
        nodeId: book.id,
        blobId: book.currentBlobId,
        title: "Resume Book",
        author: null,
        series: null,
        pageCount: 2,
        coverToken: null,
        spine: ["chapter-one", "chapter-two"],
        entries: [
          { token: "chapter-one", path: "one.xhtml", mime: "application/xhtml+xml", size: 100 },
          { token: "chapter-two", path: "two.xhtml", mime: "application/xhtml+xml", size: 100 },
        ],
        ticketPurpose: "page",
        contentBaseUrl: `${book.id}/${book.currentBlobId}/entries/`,
      },
    }),
  );
  await page.route("**/api/v1/library/book-resume/reading-state", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        status: 200,
        json: {
          nodeId: book.id,
          blobId: book.currentBlobId,
          pageCount: 2,
          position: { spineIndex: 1, progress: 5_000 },
          updatedAt: 1,
        },
      });
    writes.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      json: {
        nodeId: book.id,
        blobId: book.currentBlobId,
        pageCount: 2,
        position: writes.at(-1),
        updatedAt: Date.now(),
      },
    });
  });
  await page.route("**/api/v1/content-session", (route) =>
    route.fulfill({
      status: 201,
      json: { ticket: "resume-ticket", ticketId: crypto.randomUUID() },
    }),
  );
  await page.route("**/api/v1/tickets/*", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({
      status: 201,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
      },
      body: "",
    }),
  );
  await page.route("https://content.ncf.test:8879/c/**/entries/chapter-two", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
      },
      body: `<html><body><h1>Resumed chapter</h1>${"<p>Scrollable text.</p>".repeat(200)}</body></html>`,
    }),
  );

  await page.goto("/files");
  await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
  await page.getByRole("link", { name: "本棚", exact: true }).click();
  await page.getByRole("button", { name: "Resume Book.epubを開く", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("body")).toContainText("Resumed chapter");
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await page
    .frameLocator("iframe")
    .locator("body")
    .evaluate(() => {
      const scrolling = document.scrollingElement;
      if (!scrolling) throw new Error("missing_scrolling_element");
      scrolling.scrollTop = scrolling.scrollHeight - scrolling.clientHeight;
      window.dispatchEvent(new Event("scroll"));
    });
  await page.waitForTimeout(4_000);
  expect(writes).toEqual([]);
  await expect.poll(() => writes, { timeout: 2_000 }).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    blobId: book.currentBlobId,
    spineIndex: 1,
  });
  expect(writes[0]!.progress).toBeGreaterThan(9_000);
  await expect(page.getByRole("dialog", { name: "Resume Book.epub" })).toBeVisible();
});

test("private Video probes current track metadata and shows revocation and format fallbacks", async ({
  page,
}) => {
  await mockPrivateShell(page);
  const playable = candidate("video-1", "Private AV1.mp4", "video/mp4");
  const unsupported = candidate("video-2", "Legacy Video.mov", "video/quicktime");
  const cancelled: string[] = [];
  let tickets = 0;
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = (type) => (type.includes("av01") ? "probably" : "");
  });
  await page.route("**/api/v1/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    const items = query === ".mp4" ? [playable] : query === ".mov" ? [unsupported] : [];
    return route.fulfill({ status: 200, json: searchPage(items) });
  });
  await page.route("**/api/v1/content-session", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      purpose: "track",
      targets: [{ nodeId: playable.id }],
    });
    tickets++;
    return route.fulfill({
      status: 201,
      json: { ticket: `video-token-${tickets}`, ticketId: `video-ticket-${tickets}` },
    });
  });
  await page.route("**/api/v1/tickets/*", (route) => {
    cancelled.push(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({
      status: 201,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
        "Set-Cookie": "ncf_content=fixture; Path=/; Secure; SameSite=None",
      },
      body: "",
    }),
  );
  await page.route("https://content.ncf.test:8879/c/**/track", (route) =>
    route.fulfill({
      status: route.request().method() === "HEAD" ? 200 : 206,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
        "Content-Type": 'video/mp4; codecs="av01.0.08M.10,Opus"',
      },
      body: "",
    }),
  );

  await page.goto("/files");
  await page.getByRole("link", { name: "動画", exact: true }).click();
  await expect(page.getByRole("heading", { name: "動画", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "動画", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Private AV1\.mp4/ }).click();
  const element = page.locator('video[aria-label="Private AV1.mp4"]');
  await expect(element).toHaveAttribute("controls", "");
  await expect(element).toHaveAttribute("src", /\/c\/video-1\/blob-video-1\/track$/);
  await expect(page.getByText(/video\/mp4; codecs="av01/)).toBeVisible();
  await element.dispatchEvent("error");
  await expect(page.getByRole("alert")).toContainText("セッションの失効");
  await expect.poll(() => cancelled).toContain("video-ticket-1");
  await page.getByRole("button", { name: /Legacy Video\.mov/ }).click();
  await expect(page.getByRole("alert")).toContainText("ブラウザー再生に対応していません");
  await expect(page.getByRole("button", { name: "原本を保存", exact: true })).toBeVisible();
});
