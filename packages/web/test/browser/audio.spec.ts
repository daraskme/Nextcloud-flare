import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
test("Audio bounds empty-window scanning and lets the user continue to a real track", async ({
  page,
}) => {
  await login(page);
  const media = await upload(page, "long.opus", undefined, "tracks");
  const actual = await page.evaluate(
    async (id) => (await fetch(`/api/v1/nodes/${id}/tracks`)).json(),
    media.me.rootNodeId,
  );
  const cursors: (string | null)[] = [];
  await page.route(`**/api/v1/nodes/${media.me.rootNodeId}/tracks*`, async (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get("cursor"));
    await route.fulfill({
      json:
        cursors.length <= 3
          ? { ...actual, items: [], nextCursor: `window-${cursors.length}` }
          : {
              ...actual,
              items: actual.items.filter((x: { id: string }) => x.id === media.node.id),
              nextCursor: null,
            },
    });
  });
  await page.goto("/audio");
  await expect(page.getByText("まだ曲が見つかっていません。", { exact: false })).toBeVisible();
  expect(cursors).toEqual([null, "window-1", "window-2"]);
  await expect(page.getByText("再生できる曲がありません。", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "続けて曲を探す", exact: true }).click();
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  await playing(page);
  expect(cursors).toEqual([null, "window-1", "window-2", "window-3"]);
});
async function playing(page: Page) {
  await expect(
    page
      .getByRole("region", { name: "オーディオプレーヤー" })
      .getByRole("button", { name: "一時停止", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((el) => ({
        paused: (el as HTMLAudioElement).paused,
        duration: Math.round((el as HTMLAudioElement).duration),
        source: (el as HTMLAudioElement).currentSrc.includes("/c/"),
      })),
    )
    .toEqual({ paused: false, duration: 90, source: true });
}
async function state(page: Page, id: string, selection = "") {
  return page.evaluate(
    async ({ id, selection }) =>
      (await fetch(`/api/v1/nodes/${id}/tracks${selection}`).then((r) => r.json())).items[0]
        .playback as { positionMs: number; updatedAt: number } | null,
    { id, selection },
  );
}
test("Audio plays Ogg, WebM and MP4 Opus originals through authenticated native Range requests", async ({
  page,
}) => {
  await login(page);
  for (const filename of ["opus.ogg", "opus.webm", "opus.mp4"]) {
    const media = await upload(page, filename, undefined, "tracks");
    await page.goto(`/audio/${media.node.id}`);
    const content = page.waitForResponse(
      (r) => r.url().includes(`/c/${media.node.id}/`) && r.request().method() === "GET",
    );
    await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
    const response = await content;
    expect(response.status()).toBe(206);
    expect(response.request().headers().range).toMatch(/^bytes=/);
    const controls = page.getByRole("region", { name: "オーディオプレーヤー" });
    await expect(controls.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled();
    expect(
      await page.locator("audio").evaluate((el) => (el as HTMLAudioElement).duration),
    ).toBeGreaterThan(1);
    await controls.getByRole("button", { name: "プレーヤーを閉じる" }).click();
  }
});
test("Audio persists playback across SPA navigation, saves, resumes, reports competing tabs and closes on logout", async ({
  page,
}, info) => {
  await login(page);
  const media = await upload(page, "long.opus", undefined, "tracks");
  await page.goto(`/audio/${media.me.rootNodeId}`);
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  await playing(page);
  await page.locator("audio").evaluate((el) => {
    (el as HTMLAudioElement).currentTime = 24;
  });
  await expect
    .poll(async () => (await state(page, media.node.id))?.positionMs ?? 0, { timeout: 25000 })
    .toBeGreaterThanOrEqual(24000);
  const src = await page.locator("audio").getAttribute("src");
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("link", { name: "マイドライブ" })
    .click();
  await expect(page).toHaveURL(/\/files$/);
  await playing(page);
  expect(await page.locator("audio").getAttribute("src")).toBe(src);
  const controls = page.getByRole("region", { name: "オーディオプレーヤー" });
  await controls.getByLabel("音量").fill("0.35");
  expect(await page.locator("audio").evaluate((el) => (el as HTMLAudioElement).volume)).toBe(0.35);
  await page.locator("audio").evaluate((el) => {
    (el as HTMLAudioElement).currentTime = 43;
  });
  await controls.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect
    .poll(async () => (await state(page, media.node.id))?.positionMs ?? 0)
    .toBeGreaterThanOrEqual(43000);
  await page.goto(`/audio/${media.node.id}`);
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  await playing(page);
  expect(
    await page.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime),
  ).toBeGreaterThanOrEqual(43);
  const other = await state(page, media.node.id);
  expect(
    await page.evaluate(
      async ({ id, blobId, updatedAt }) => {
        const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
        return (
          await fetch(`/api/v1/nodes/${id}/playback-state`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
            body: JSON.stringify({
              blobId,
              generator: "track-metadata-v1",
              positionMs: 60000,
              previousUpdatedAt: updatedAt,
            }),
          })
        ).status;
      },
      { id: media.node.id, blobId: media.node.currentBlobId, updatedAt: other!.updatedAt },
    ),
  ).toBe(200);
  await controls.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(
    controls.getByText("別の画面で再生位置が更新されました。", { exact: false }),
  ).toBeVisible();
  await controls.getByRole("button", { name: "保存済みの位置から再開" }).click();
  await playing(page);
  expect(
    await page.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime),
  ).toBeGreaterThanOrEqual(60);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("audio-mobile.png") });
  // Keep this document available to inspect cleanup before Access navigation replaces it.
  await page.route("**/cdn-cgi/access/logout", (route) => route.fulfill({ status: 204 }));
  await page.evaluate(() => {
    const channel = new BroadcastChannel("ncf-auth");
    channel.postMessage("logout");
    channel.close();
  });
  await expect(controls).toHaveCount(0);
  expect(await page.locator("audio").getAttribute("src")).toBeNull();
});

test("internal and public Audio use current sharing grants, separate user positions and clear buffered originals", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const media = await upload(page, "long.opus", undefined, "tracks");
  const shares = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const create = async (body: unknown) => {
      const r = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });
      if (r.status !== 201) throw new Error(`share_${r.status}`);
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
  const recipient = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
  });
  const anonymous = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    for (const [context, identity] of [
      [recipient, "recipient"],
      [anonymous, "anonymous"],
    ] as const)
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
    await recipient.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
    const friend = await recipient.newPage();
    await friend.goto(`/shared/${shares.internal.id}`);
    await friend.getByRole("button", { name: "オーディオで表示", exact: true }).click();
    await friend.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
    await playing(friend);
    await friend.locator("audio").evaluate((el) => {
      (el as HTMLAudioElement).currentTime = 22;
    });
    await friend.getByRole("button", { name: "一時停止", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await state(friend, media.node.id, `?shareId=${shares.internal.id}&shareVersion=1`))
            ?.positionMs ?? 0,
      )
      .toBeGreaterThanOrEqual(22000);
    expect(await state(page, media.node.id)).toBeNull();
    const guest = await anonymous.newPage();
    const writes: string[] = [];
    guest.on("request", (r) => {
      if (r.url().includes("playback-state")) writes.push(r.url());
    });
    await openPublic(
      guest,
      `https://app.ncf.test:8879/s/${shares.public.id}#${shares.public.secret}`,
      media.name,
    );
    await guest.getByRole("button", { name: "オーディオで表示", exact: true }).click();
    await guest.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
    await playing(guest);
    await guest.getByRole("button", { name: "ファイル一覧へ戻る", exact: true }).click();
    await playing(guest);
    await guest.screenshot({ path: info.outputPath("audio-public-mobile.png") });
    await guest.getByRole("button", { name: "共有を閉じる", exact: true }).click();
    await expect(guest.getByRole("region", { name: "オーディオプレーヤー" })).toHaveCount(0);
    expect(await guest.locator("audio").getAttribute("src")).toBeNull();
    expect(writes).toEqual([]);
    await friend
      .getByRole("region", { name: "オーディオプレーヤー" })
      .getByRole("button", { name: "再生", exact: true })
      .click();
    await playing(friend);
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
      }, shares.internal.id),
    ).toBe(200);
    await expect(friend.getByRole("region", { name: "オーディオプレーヤー" })).toHaveCount(0, {
      timeout: 25000,
    });
    expect(await friend.locator("audio").getAttribute("src")).toBeNull();
  } finally {
    await recipient.close();
    await anonymous.close();
  }
});

test("unsupported browser decoding offers the authenticated original download", async ({
  page,
}) => {
  await login(page);
  const media = await upload(page, "long.opus", undefined, "tracks");
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.canPlayType = () => "";
  });
  await page.goto(`/audio/${media.node.id}`);
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  const player = page.getByRole("region", { name: "オーディオプレーヤー" });
  await expect(player.getByRole("status")).toContainText("原本をダウンロード");
  const popupPromise = page.waitForEvent("popup");
  await player.getByRole("button", { name: "原本をダウンロード", exact: true }).click();
  const popup = await popupPromise;
  const download = await popup.waitForEvent("download");
  expect(download.suggestedFilename()).toBe(media.name);
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream!) bytes += chunk.length;
  expect(bytes).toBe(63795);
  await popup.close();
});
