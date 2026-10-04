import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { processTestMedia, writeTestBytes } from "./uploadHelpers";

const fixture = (name: string) =>
  readFile(resolve(import.meta.dirname, "../../../worker/test/fixtures", name));

const media = [
  { name: "browser-e2e-tone.mp3", title: "Browser E2E Tone", fixture: "browser-e2e-tone.mp3" },
  { name: "browser-e2e-opus.ogg", title: "Browser E2E Opus Ogg", fixture: "browser-e2e-opus.ogg" },
  {
    name: "browser-e2e-opus.webm",
    title: "Browser E2E Opus WebM",
    fixture: "browser-e2e-opus.webm",
  },
  { name: "browser-e2e-opus.mp4", title: "Browser E2E Opus MP4", fixture: "browser-e2e-opus.mp4" },
  {
    name: "browser-e2e-av1-opus.webm",
    title: "AV1 + Opus WebM video",
    fixture: "browser-e2e-av1-opus.webm",
    video: true,
  },
  {
    name: "browser-e2e-av1-opus.mp4",
    title: "AV1 + Opus MP4 video",
    fixture: "browser-e2e-av1-opus.mp4",
    video: true,
  },
] as const;

async function setIdentity(page: Page, member: boolean) {
  await page.unroute("https://app.ncf.test:8879/**");
  await page.route("https://app.ncf.test:8879/**", (route) => {
    const headers = { ...route.request().headers() };
    if (member) headers["x-test-identity"] = "member";
    else delete headers["x-test-identity"];
    return route.continue({ headers });
  });
}

async function loginTestIdentity(page: Page) {
  const status = await page.evaluate(() =>
    fetch("/__test__/login", { method: "POST" }).then((response) => response.status),
  );
  if (status !== 200) throw new Error(`test_identity_login_${status}`);
}

async function waitForMediaProcessing(page: Page, nodeId: string) {
  await expect
    .poll(() => processTestMedia(page, nodeId), { timeout: 15_000, intervals: [250, 500, 1000] })
    .toBe("completed");
}

async function assertAuthenticatedRange(
  page: Page,
  node: { id: string; currentBlobId: string },
  expected: Buffer,
  adminOwnerId?: string,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/c/${node.id}/${node.currentBlobId}`) &&
      response.request().headers().range === "bytes=1024-3071",
  );
  const result = await page.evaluate(
    async ({ node, start, end, adminOwnerId }) => {
      const me = await fetch("/api/v1/me").then((response) => response.json());
      const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((response) =>
        response.json(),
      );
      let ownerSpaceId = me.spaceId;
      if (adminOwnerId) {
        const users = await fetch("/api/v1/admin/users").then((response) => response.json());
        const owner = users.users.find(
          (candidate: { id: string }) => candidate.id === adminOwnerId,
        );
        if (!owner) throw new Error("admin_media_owner_missing");
        ownerSpaceId = owner.spaceId;
      }
      const issued = await fetch(
        adminOwnerId
          ? `/api/v1/admin/users/${adminOwnerId}/content-session`
          : "/api/v1/content-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
          body: JSON.stringify({
            targets: [{ spaceId: ownerSpaceId, nodeId: node.id }],
            purpose: "content",
            ...(adminOwnerId ? { action: "preview" } : {}),
            ttlSeconds: 300,
          }),
        },
      );
      if (issued.status !== 201) throw new Error(`content_ticket_${issued.status}`);
      const ticket = await issued.json();
      const accepted = await fetch(`${me.contentOrigin}/session`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: ticket.ticket }),
      });
      if (accepted.status !== 201) throw new Error(`content_exchange_${accepted.status}`);
      const response = await fetch(`${me.contentOrigin}/c/${node.id}/${node.currentBlobId}`, {
        credentials: "include",
        headers: { Range: `bytes=${start}-${end}` },
      });
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    },
    { node, start: 1024, end: 3071, adminOwnerId },
  );
  const streamedResponse = await responsePromise;
  expect(result.status).toBe(206);
  expect(streamedResponse.headers()["content-range"]).toBe(`bytes 1024-3071/${expected.length}`);
  expect(Buffer.from(result.bytes)).toEqual(expected.subarray(1024, 3072));
}

test("real MP3 and Opus audio plus AV1 video decode, seek, and stream authenticated ranges", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const original = new Map<string, Buffer>();
  const uploaded = new Map<string, { id: string; currentBlobId: string }>();
  await setIdentity(page, true);
  await page.goto("/files");

  for (const item of media) {
    const bytes = await fixture(item.fixture);
    original.set(item.name, bytes);
    const node = await writeTestBytes(page, item.name, bytes);
    if (!node.currentBlobId) throw new Error(`test_upload_missing_blob_${item.name}`);
    uploaded.set(item.name, { id: node.id, currentBlobId: node.currentBlobId });
    await waitForMediaProcessing(page, node.id);
  }

  await page.goto("/audio");
  for (const item of media.filter((candidate) => !("video" in candidate))) {
    const visibleTrackLabel = item.fixture === "browser-e2e-tone.mp3" ? item.title : item.name;
    const row = page.getByRole("button", { name: new RegExp(visibleTrackLabel) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const audio = page.locator("audio");
    await expect
      .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).duration), {
        timeout: 15_000,
      })
      .toBeGreaterThan(14);
    await expect
      .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0.5);
    const seek = page.getByRole("slider", { name: "再生位置" });
    await seek.fill("8");
    await expect
      .poll(() => audio.evaluate((element) => (element as HTMLAudioElement).currentTime), {
        timeout: 10_000,
      })
      .toBeGreaterThan(8.3);
    await assertAuthenticatedRange(page, uploaded.get(item.name)!, original.get(item.name)!);
  }

  const videos = media.filter((item) => "video" in item);
  await page.goto("/video");
  await expect(page.getByRole("button", { name: /browser-e2e-opus\.(?:mp4|webm)/ })).toHaveCount(0);
  for (const video of videos) {
    const videoRow = page.getByRole("button", { name: new RegExp(video.name) });
    await expect(videoRow).toBeVisible();
    await videoRow.click();
    const videoNode = uploaded.get(video.name)!;
    const videoElement = page.locator(`video[aria-label="${video.name}"]`);
    await expect(videoElement).toBeVisible();
    await expect(videoElement).toHaveAttribute("src", new RegExp(videoNode.id));
    await videoElement.evaluate((element) => (element as HTMLVideoElement).play());
    await expect
      .poll(() => videoElement.evaluate((element) => (element as HTMLVideoElement).videoWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        videoElement.evaluate(
          (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() => videoElement.evaluate((element) => (element as HTMLVideoElement).currentTime), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0.5);
    const framesBeforeSeek = await videoElement.evaluate(
      (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
    );
    await videoElement.evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 8;
    });
    await expect
      .poll(() => videoElement.evaluate((element) => (element as HTMLVideoElement).currentTime), {
        timeout: 10_000,
      })
      .toBeGreaterThan(8.3);
    await expect
      .poll(() =>
        videoElement.evaluate(
          (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
        ),
      )
      .toBeGreaterThan(framesBeforeSeek);
    await assertAuthenticatedRange(page, uploaded.get(video.name)!, original.get(video.name)!);
  }

  // The default identity is the first owner/admin; browse the actual member bytes.
  await setIdentity(page, false);
  await loginTestIdentity(page);
  await page.goto("/admin/files");
  await page
    .getByLabel("利用者", { exact: true })
    .selectOption({ label: "browser-member@example.invalid" });
  const adminOwnerId = await page.getByLabel("利用者", { exact: true }).inputValue();
  for (const item of media) {
    const row = page.getByRole("row").filter({ hasText: item.name });
    await row.getByRole("button", { name: "プレビュー", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `プレビュー: ${item.name}` });
    await expect(dialog).toBeVisible();
    const isVideo = "video" in item;
    const player = isVideo
      ? dialog.locator(`video[aria-label="${item.name}"]`)
      : dialog.locator(`audio[aria-label="${item.name}"]`);
    await expect(player).toHaveAttribute("src", new RegExp(uploaded.get(item.name)!.id));
    await expect
      .poll(() => player.evaluate((element) => (element as HTMLMediaElement).duration), {
        timeout: 15_000,
      })
      .toBeGreaterThan(14);
    await player.evaluate((element) => (element as HTMLMediaElement).play());
    if (isVideo) {
      await expect
        .poll(() =>
          player.evaluate(
            (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          ),
        )
        .toBeGreaterThan(0);
    }
    await expect
      .poll(() => player.evaluate((element) => (element as HTMLMediaElement).currentTime), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0.5);
    const adminFramesBeforeSeek = isVideo
      ? await player.evaluate(
          (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
        )
      : 0;
    await player.evaluate((element) => {
      (element as HTMLMediaElement).currentTime = 8;
    });
    await expect
      .poll(() => player.evaluate((element) => (element as HTMLMediaElement).currentTime), {
        timeout: 10_000,
      })
      .toBeGreaterThan(8.3);
    if (isVideo) {
      await expect
        .poll(() =>
          player.evaluate(
            (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          ),
        )
        .toBeGreaterThan(adminFramesBeforeSeek);
    }
    await assertAuthenticatedRange(
      page,
      uploaded.get(item.name)!,
      original.get(item.name)!,
      adminOwnerId,
    );
    await dialog.getByRole("button", { name: "プレビューを閉じる" }).click();
  }

  const downloadPopup = page.waitForEvent("popup");
  await page
    .getByRole("row")
    .filter({ hasText: media[0].name })
    .getByRole("button", { name: "ダウンロード", exact: true })
    .click();
  const popup = await downloadPopup;
  const filePromise = popup.waitForEvent("download");
  const responsePromise = popup.waitForResponse((response) =>
    response.url().includes(`/c/${uploaded.get(media[0].name)!.id}/`),
  );
  const [file, attachmentResponse] = await Promise.all([filePromise, responsePromise]);
  const contentResponse = await attachmentResponse;
  expect(contentResponse.status()).toBe(200);
  expect(contentResponse.headers()["content-disposition"]).toMatch(/^attachment;/i);
  const downloadedPath = `/tmp/ncf-admin-media-download-${Date.now()}`;
  await file.saveAs(downloadedPath);
  const downloaded = await readFile(downloadedPath);
  expect(downloaded).toEqual(original.get(media[0].name));
});
