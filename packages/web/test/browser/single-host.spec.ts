import { expect, type Page, test } from "@playwright/test";
import { generateLarge, upload as uploadImage } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";
import { fileContent, rootFile, writeTestFile } from "./uploadHelpers";

const origin = "https://app.ncf.test:8880";
async function owner(page: Page) {
  await page.request.post("https://127.0.0.1:8880/__test__/access-login", {
    headers: { Host: "app.ncf.test:8880" },
  });
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      fetch("/api/v1/me")
        .then((r) => r.json())
        .then((me) => me.contentOrigin),
    ),
  ).toBe(origin);
}
async function downloaded(popup: Page, name: string, expected: string) {
  const download = await popup.waitForEvent("download");
  expect(download.suggestedFilename()).toBe(name);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const part of stream!) chunks.push(Buffer.from(part));
  expect(Buffer.concat(chunks).toString()).toBe(expected);
  await popup.close();
}

test("single host Gallery decodes private and anonymous AVIF lightboxes", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await owner(page);
  const image = await uploadImage(page, "red.avif");
  await page.goto("/gallery");
  const view = async (target: Page) => {
    const gallery = target.getByRole("region", { name: "ギャラリー" });
    await expect(gallery.locator(".gallery-thumb img")).toHaveCount(1);
    await gallery.getByRole("button", { name: `${image.name}を表示` }).click();
    const img = target.getByRole("dialog", { name: "画像の詳細" }).locator("img");
    await expect(img).toHaveAttribute("src", new RegExp(`^${origin}/c/`));
    await expect
      .poll(() =>
        img.evaluate((image) => [
          (image as HTMLImageElement).naturalWidth,
          (image as HTMLImageElement).naturalHeight,
        ]),
      )
      .toEqual([16, 12]);
    await target.getByRole("button", { name: "画像を閉じる" }).click();
  };
  await view(page);
  const share = await page.evaluate(async (nodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId: nodeId, role: "read" }),
    });
    if (response.status !== 201) throw new Error("single_gallery_share");
    return response.json();
  }, image.node.id);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      {
        name: "ncf-test-user",
        value: "anonymous",
        domain: "app.ncf.test",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const guest = await context.newPage();
    await openPublic(guest, `${origin}/s/${share.id}#${share.secret}`, image.name);
    await guest.getByRole("button", { name: "ギャラリーで表示" }).click();
    await view(guest);
  } finally {
    await context.close();
  }
});

test("single host Gallery switches a generated large preview back to the same-origin original", async ({
  page,
}) => {
  test.setTimeout(180000);
  await owner(page);
  const image = await uploadImage(page, "pattern.png");
  await page.goto("/gallery");
  await page.getByRole("button", { name: `${image.name}を表示` }).click();
  const img = page.getByRole("dialog", { name: "画像の詳細" }).locator("img");
  const size = () =>
    img.evaluate((el) => [
      (el as HTMLImageElement).naturalWidth,
      (el as HTMLImageElement).naturalHeight,
    ]);
  await expect.poll(size).toEqual([1920, 1080]);
  await generateLarge(page, image.node.currentBlobId);
  await page.getByRole("button", { name: "軽いプレビューを表示" }).click();
  await expect.poll(size).toEqual([1600, 900]);
  await expect(img).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "原本を表示", exact: true }).click();
  await expect.poll(size).toEqual([1920, 1080]);
  await expect(img).toHaveAttribute("src", new RegExp(`^${origin}/c/`));
});

test("single host Gallery plays and seeks AV1 and offers an authenticated attachment", async ({
  page,
}) => {
  test.setTimeout(180000);
  await owner(page);
  const media = await uploadImage(page, "av1-opus.webm", undefined, "tracks");
  await page.goto("/gallery");
  await page.getByRole("button", { name: `${media.name}を表示` }).click();
  const video = page.getByRole("dialog", { name: "動画の詳細" }).locator("video");
  await expect(video).toHaveAttribute("src", new RegExp(`^${origin}/c/`));
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).videoWidth)).toBe(160);
  await video.evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    v.muted = true;
    await v.play();
  });
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.15);
  await video.evaluate((el) => {
    const v = el as HTMLVideoElement;
    v.pause();
    v.currentTime = 1.2;
  });
  await expect
    .poll(() =>
      video.evaluate((el) => {
        const v = el as HTMLVideoElement;
        return !v.seeking && Math.abs(v.currentTime - 1.2) < 0.1;
      }),
    )
    .toBe(true);
  const url = await video.getAttribute("src");
  const result = await page.evaluate(async (url) => {
    const response = await fetch(`${url}?download=1`, { headers: { Range: "bytes=0-15" } });
    return {
      status: response.status,
      disposition: response.headers.get("Content-Disposition"),
      length: (await response.arrayBuffer()).byteLength,
      invalid: await Promise.all(
        ["download=0", "download=1&download=1", "download=1&variant=sm"].map(
          async (query) => (await fetch(`${url}?${query}`)).status,
        ),
      ),
    };
  }, url);
  expect(result.status).toBe(206);
  expect(result.disposition).toMatch(/^attachment;/);
  expect(result.length).toBe(16);
  expect(result.invalid).toEqual([404, 404, 404]);
});

test("single host Files plays an Opus original while scripts stay disabled", async ({ page }) => {
  await owner(page);
  const media = await uploadImage(page, "opus.ogg", undefined, "tracks");
  await page.goto("/files");
  await page.getByRole("button", { name: `${media.name}の操作`, exact: true }).click();
  const opening = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: "ファイルを開く・保存", exact: true }).click();
  const popup = await opening;
  try {
    await popup.waitForURL(new RegExp(`^${origin}/c/`));
    const player = popup.locator("audio,video");
    await expect(player).toHaveCount(1);
    await player.evaluate((el) => {
      const m = el as HTMLMediaElement;
      m.muted = true;
      void m.play();
      const script = document.createElement("script");
      script.textContent = 'document.body.dataset.scriptExecuted = "yes"';
      document.body.append(script);
    });
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLMediaElement).currentTime))
      .toBeGreaterThan(0.15);
    expect(await popup.evaluate(() => document.body.dataset.scriptExecuted)).toBeUndefined();
  } finally {
    await popup.close();
  }
});

test("single host serves private Files and anonymous public downloads with isolated authority", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await owner(page);
  const name = "単一ドメイン.txt",
    value = "Single host download\n";
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(value) });
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({ timeout: 60000 });
  const node = await rootFile(page, name);
  expect(await fileContent(page, node, "bytes=0-5")).toBe("Single");
  const privatePath = await page.locator('script[src*="private-assets"]').getAttribute("src");
  expect(privatePath).toBeTruthy();
  await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  const opened = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: "ファイルを開く・保存", exact: true }).click();
  await downloaded(await opened, name, value);
  const link = await page.evaluate(async (nodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId: nodeId, role: "read" }),
    });
    if (response.status !== 201) throw new Error(`single_host_share_${response.status}`);
    return response.json() as Promise<{ id: string; secret: string }>;
  }, node.id);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: "ncf-test-user",
      value: "anonymous",
      domain: "app.ncf.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  try {
    const guest = await context.newPage();
    guest.on("pageerror", (error) => errors.push(error.message));
    guest.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) errors.push(message.text());
    });
    await guest.goto(`${origin}/s/${link.id}#${link.secret}`);
    const save = guest.getByRole("button", { name: `${name}を開く・保存`, exact: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const unlock = guest.getByRole("button", { name: /共有を開く|秒後に再試行できます/ });
      await expect(save.or(unlock)).toBeVisible({ timeout: 60000 });
      if (await save.isVisible()) break;
      await expect(unlock).toBeEnabled({ timeout: 70000 });
      await unlock.click();
    }
    await expect(save).toBeVisible();
    expect(new URL(guest.url()).hash).toBe("");
    const guestOpened = guest.waitForEvent("popup");
    await save.click();
    await downloaded(await guestOpened, name, value);
    expect(
      requests.some(
        (url) =>
          url.includes("content.ncf.test") ||
          url.includes("private-assets") ||
          url.includes(link.secret),
      ),
    ).toBe(false);
    const cookies = await context.cookies();
    const contentCookie = cookies.find(
      (cookie) => cookie.name.startsWith("__Host-") && !cookie.name.includes("share"),
    );
    expect(contentCookie).toMatchObject({
      domain: "app.ncf.test",
      path: "/",
      secure: true,
      httpOnly: true,
    });
    expect(await guest.evaluate(() => document.cookie)).not.toContain("__Host-");
    const contentPath = `/c/${node.id}/${node.currentBlobId}`;
    const check = await guest.evaluate(
      async ({ path, privatePath }) => {
        const head = await fetch(path, { method: "HEAD" });
        const range = await fetch(path, { headers: { Range: "bytes=0-5" } });
        const unchanged = await fetch(path, {
          headers: { "If-None-Match": head.headers.get("ETag")! },
        });
        const denied = await Promise.all(
          ["/api/v1/me", "/files", privatePath, "/unknown", "/public.html", "/sw.js"].map(
            async (url) => (await fetch(url)).status,
          ),
        );
        return {
          head: head.status,
          headBody: await head.text(),
          range: range.status,
          text: await range.text(),
          unchanged: unchanged.status,
          denied,
          local: localStorage.length,
          session: sessionStorage.length,
          width: document.documentElement.scrollWidth,
          privacy: [head, range, unchanged].every(
            (r) =>
              r.headers.get("Cache-Control") === "private, no-store" &&
              r.headers.get("Referrer-Policy") === "no-referrer",
          ),
        };
      },
      { path: contentPath, privatePath: privatePath! },
    );
    expect(check).toEqual({
      head: 200,
      headBody: "",
      range: 206,
      text: "Single",
      unchanged: 304,
      denied: [401, 401, 401, 404, 404, 404],
      local: 0,
      session: 0,
      width: 390,
      privacy: true,
    });
    await guest.getByRole("button", { name: "共有を閉じる", exact: true }).click();
    await expect(save).toHaveCount(0);
    expect(await guest.evaluate(async (path) => (await fetch(path)).status, contentPath)).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const [name, value] of [
  ["添付のみ.html", '<!doctype html><script>document.title="executed"</script>'],
  [
    "添付のみ.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="executed"</script></svg>',
  ],
] as const) {
  test(`single host downloads ${name} with restrictive CSP and attachment`, async ({ page }) => {
    await owner(page);
    const node = await writeTestFile(page, name, value);
    expect(await fileContent(page, node)).toBe(value);
    const headers = await page.evaluate(async (node) => {
      const response = await fetch(`/c/${node.id}/${node.currentBlobId}`, { method: "HEAD" });
      return {
        status: response.status,
        csp: response.headers.get("Content-Security-Policy"),
        disposition: response.headers.get("Content-Disposition"),
        sniff: response.headers.get("X-Content-Type-Options"),
      };
    }, node);
    expect(headers.status).toBe(200);
    expect(headers.csp).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
    expect(headers.disposition).toMatch(/^attachment;/);
    expect(headers.sniff).toBe("nosniff");
    const download = page.waitForEvent("download");
    await page.evaluate((node) => {
      const link = document.createElement("a");
      link.href = `/c/${node.id}/${node.currentBlobId}`;
      document.body.append(link);
      link.click();
      link.remove();
    }, node);
    expect((await download).suggestedFilename()).toBe(name);
    await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
    expect(await page.title()).not.toBe("executed");
  });
}
