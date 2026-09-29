import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(240000);
test("Files opens original Opus in Ogg, WebM and MP4 with native playback and seek", async ({
  page,
}) => {
  await login(page);
  for (const file of ["opus.ogg", "opus.webm", "opus.mp4"]) {
    const media = await upload(page, file, undefined, "tracks");
    await page.goto("/files");
    await page.getByRole("button", { name: `${media.name}の操作`, exact: true }).click();
    const opening = page.waitForEvent("popup");
    await page.getByRole("menuitem", { name: "ファイルを開く・保存", exact: true }).click();
    const popup = await opening;
    try {
      await popup.waitForURL(/^https:\/\/content\.ncf\.test:8879\/c\//);
      const mediaElement = popup.locator("audio,video");
      await expect(mediaElement).toHaveCount(1);
      // The raw media document forbids scripts. Read its native state from Playwright;
      // do not wait for a Promise/timer callback inside that sandboxed document.
      await mediaElement.evaluate((el) => {
        const m = el as HTMLMediaElement;
        m.muted = true;
        void m.play();
      });
      await expect
        .poll(() => mediaElement.evaluate((el) => (el as HTMLMediaElement).currentTime))
        .toBeGreaterThan(0.15);
      await mediaElement.evaluate((el) => {
        const m = el as HTMLMediaElement;
        m.pause();
        m.currentTime = 1.2;
      });
      await expect
        .poll(() =>
          mediaElement.evaluate((el) => {
            const m = el as HTMLMediaElement;
            return !m.seeking && Math.abs(m.currentTime - 1.2) < 0.1;
          }),
        )
        .toBe(true);
    } finally {
      await popup.close();
    }
  }
});
async function play(page: Page, name: string) {
  await page.getByRole("button", { name: `${name}を表示` }).click();
  const video = page.getByRole("dialog", { name: "動画の詳細" }).locator("video");
  await expect(video).toHaveAttribute("src", /^https:\/\/content\.ncf\.test:8879\/c\//);
  await expect
    .poll(() =>
      video.evaluate((el) => [
        (el as HTMLVideoElement).videoWidth,
        (el as HTMLVideoElement).videoHeight,
      ]),
    )
    .toEqual([160, 90]);
  await video.evaluate(async (element) => {
    const el = element as HTMLVideoElement;
    el.muted = true;
    await el.play();
  });
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.15);
  await video.evaluate((element) => {
    const el = element as HTMLVideoElement;
    el.pause();
    el.currentTime = 1.2;
  });
  await expect
    .poll(() =>
      video.evaluate(
        (el) =>
          !(el as HTMLVideoElement).seeking &&
          Math.abs((el as HTMLVideoElement).currentTime - 1.2) < 0.1,
      ),
    )
    .toBe(true);
  return video;
}
test("Gallery decodes AV1 MP4/WebM with and without Opus, preserves bit depth, and seeks using original URLs", async ({
  page,
}, info) => {
  await login(page);
  const requested: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/c/")) requested.push(r.url());
  });
  for (const file of [
    "av1.mp4",
    "av1.webm",
    "av1-opus.mp4",
    "av1-opus.webm",
    "av1-10bit.mp4",
    "av1-10bit.webm",
  ]) {
    const media = await upload(page, file, undefined, "tracks");
    await page.goto("/gallery");
    const before = requested.length;
    await expect(page.getByRole("button", { name: `${media.name}を表示` })).toBeVisible();
    expect(requested.length).toBe(before);
    const video = await play(page, media.name),
      url = (await video.getAttribute("src"))!;
    const range = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: "include", headers: { Range: "bytes=80-127" } });
      return {
        status: r.status,
        mime: r.headers.get("Content-Type"),
        bytes: Array.from(new Uint8Array(await r.arrayBuffer())),
      };
    }, url);
    expect(range.status).toBe(206);
    expect(range.mime).toContain(file.includes("10bit") ? ".10" : ".08");
    expect(range.bytes).toEqual(
      Array.from(
        readFileSync(
          new URL(`../../../worker/test/fixtures/tracks/${file}`, import.meta.url),
        ).subarray(80, 128),
      ),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath(`${file}.png`) });
    const handle = await video.elementHandle();
    await page.getByRole("button", { name: "動画を閉じる" }).click();
    expect(
      await handle!.evaluate((el) => (el as HTMLVideoElement).paused && !el.getAttribute("src")),
    ).toBe(true);
  }
});
test("unsupported video and actual decoder errors offer an authenticated original download", async ({
  page,
}) => {
  await login(page);
  const media = await upload(page, "av1-opus.mp4", undefined, "tracks");
  await page.goto("/gallery");
  const video = await play(page, media.name);
  await video.dispatchEvent("error");
  await expect(page.getByRole("alert")).toContainText("この端末では動画を再生できません");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "原本をダウンロード" }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe(media.name);
  const stream = await result.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(
    readFileSync(new URL("../../../worker/test/fixtures/tracks/av1-opus.mp4", import.meta.url)),
  );
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "";
  });
  await page.reload();
  await page.getByRole("button", { name: `${media.name}を表示` }).click();
  await expect(page.getByRole("alert")).toContainText("この端末では動画を再生できません");
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "原本をダウンロード" })).toBeVisible();
});
test("internal recipients and anonymous readers play the same AV1 original and lose access after revocation", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const media = await upload(page, "av1-opus.webm", undefined, "tracks");
  const shares = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const create = async (body: unknown) => {
      const r = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("video_share_failed");
      return r.json();
    };
    return {
      internal: await create({
        kind: "internal",
        rootNodeId,
        role: "read",
        recipients: ["recipient@example.invalid"],
      }),
      public: await create({ kind: "link", rootNodeId, role: "read" }),
    };
  }, media.node.id);
  for (const identity of ["recipient", "anonymous"]) {
    const context = await browser.newContext({
      baseURL: "https://app.ncf.test:8879",
      ignoreHTTPSErrors: true,
    });
    try {
      await context.addCookies([
        {
          name: "ncf-test-user",
          value: identity,
          domain: ".ncf.test",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      if (identity === "recipient")
        await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
          headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
        });
      const guest = await context.newPage();
      if (identity === "recipient") await guest.goto(`/shared/${shares.internal.id}`);
      else
        await openPublic(
          guest,
          `https://app.ncf.test:8879/s/${shares.public.id}#${shares.public.secret}`,
          media.name,
        );
      await guest.getByRole("button", { name: "ギャラリーで表示", exact: true }).click();
      const video = await play(guest, media.name),
        url = (await video.getAttribute("src"))!;
      await guest.screenshot({ path: info.outputPath(`video-${identity}.png`) });
      const shareId = identity === "recipient" ? shares.internal.id : shares.public.id;
      expect(
        await page.evaluate(async (id) => {
          const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
          return (
            await fetch(`/api/v1/shares/${id}`, {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": token,
                "If-Match": '"share-1"',
              },
            })
          ).status;
        }, shareId),
      ).toBe(200);
      expect(
        await guest.evaluate(
          async (url) =>
            (
              await fetch(url, {
                credentials: "include",
                headers: { Range: "bytes=80-127" },
                cache: "no-store",
              })
            ).status,
          url,
        ),
      ).toBe(404);
    } finally {
      await context.close();
    }
  }
});
