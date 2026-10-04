import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { processTestMedia, rootFile } from "./uploadHelpers";

type ExternalMedia = {
  path: string;
  kind: "image" | "audio" | "video";
  name: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

type ExternalManifest = { files: ExternalMedia[] };
type UploadedNode = { id: string; currentBlobId: string };

function readManifestPath() {
  const value = process.env.NCF_USER_MEDIA_MANIFEST;
  return value && isAbsolute(value) ? value : undefined;
}

function validateManifest(value: unknown): ExternalManifest {
  if (!value || typeof value !== "object" || !Array.isArray((value as ExternalManifest).files))
    throw new Error("external_media_manifest_invalid");
  const files = (value as ExternalManifest).files;
  if (
    files.length !== 3 ||
    new Set(files.map((item) => item?.kind)).size !== 3 ||
    files.some(
      (item) =>
        !item ||
        !["image", "audio", "video"].includes(item.kind) ||
        !isAbsolute(item.path) ||
        !item.name ||
        basename(item.path) !== item.name ||
        (item.kind === "image" &&
          (!Number.isFinite(item.width) ||
            !Number.isFinite(item.height) ||
            item.width! < 1 ||
            item.height! < 1)) ||
        (item.kind !== "image" &&
          (!Number.isFinite(item.durationSeconds) || item.durationSeconds! <= 0)) ||
        (item.kind === "video" &&
          (!Number.isFinite(item.width) ||
            !Number.isFinite(item.height) ||
            item.width! < 1 ||
            item.height! < 1)),
    )
  )
    throw new Error("external_media_manifest_invalid");
  return { files };
}

async function loginFreshOwner(page: Page) {
  await page.goto("/");
  const status = await page.evaluate(() =>
    fetch("/__test__/login", { method: "POST" }).then((response) => response.status),
  );
  expect(status).toBe(200);
}

async function uploadWithFileChooser(page: Page, media: ExternalMedia) {
  await page.goto("/files");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooserPromise).setFiles(media.path);
  const task = page.locator(".upload-task").filter({ hasText: media.name });
  await expect(task.getByText("アップロード完了", { exact: true })).toBeVisible({
    timeout: 900_000,
  });
  const node = await rootFile(page, media.name);
  if (!node.currentBlobId) throw new Error("external_media_upload_has_no_blob");
  await expect
    .poll(() => processTestMedia(page, node.id), {
      timeout: 120_000,
      intervals: [500, 1000, 2000],
    })
    .toBe("completed");
  return { id: node.id, currentBlobId: node.currentBlobId };
}

async function prepareContentSession(page: Page, node: { id: string; currentBlobId: string }) {
  const status = await page.evaluate(async (node) => {
    const me = await fetch("/api/v1/me").then((response) => response.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((response) =>
      response.json(),
    );
    const issued = await fetch("/api/v1/content-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        targets: [{ spaceId: me.spaceId, nodeId: node.id }],
        purpose: "content",
        ttlSeconds: 300,
      }),
    });
    if (issued.status !== 201) throw new Error(`external_media_ticket_${issued.status}`);
    const ticket = await issued.json();
    const exchange = await fetch(`${me.contentOrigin}/session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: ticket.ticket }),
    });
    if (exchange.status !== 201) throw new Error(`external_media_exchange_${exchange.status}`);
    return 201;
  }, node);
  expect(status).toBe(201);
}

async function contentRange(
  page: Page,
  node: { id: string; currentBlobId: string },
  start: number,
  end: number,
) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/c/${node.id}/${node.currentBlobId}`) &&
      response.request().headers().range === `bytes=${start}-${end}`,
  );
  const status = await page.evaluate(
    async ({ node, start, end }) => {
      const me = await fetch("/api/v1/me").then((response) => response.json());
      const response = await fetch(`${me.contentOrigin}/c/${node.id}/${node.currentBlobId}`, {
        credentials: "include",
        headers: { Range: `bytes=${start}-${end}` },
      });
      await response.arrayBuffer();
      return response.status;
    },
    { node, start, end },
  );
  const response = await responsePromise;
  return { status, range: response.headers()["content-range"], bytes: await response.body() };
}

async function hashRemoteByRanges(
  page: Page,
  node: { id: string; currentBlobId: string },
  path: string,
  fileSize: number,
) {
  const source = await open(path, "r");
  await prepareContentSession(page, node);
  const remoteHash = createHash("sha256");
  const localHash = createHash("sha256");
  const chunkSize = 4 * 1024 * 1024;
  try {
    for (let start = 0; start < fileSize; start += chunkSize) {
      const end = Math.min(fileSize - 1, start + chunkSize - 1);
      const range = await contentRange(page, node, start, end);
      expect(range.status).toBe(206);
      expect(range.range).toBe(`bytes ${start}-${end}/${fileSize}`);
      const received = range.bytes;
      expect(received.byteLength).toBe(end - start + 1);
      const expected = Buffer.alloc(received.byteLength);
      const { bytesRead } = await source.read(expected, 0, expected.byteLength, start);
      expect(bytesRead).toBe(expected.byteLength);
      expect(received.equals(expected)).toBe(true);
      remoteHash.update(received);
      localHash.update(expected);
    }
  } finally {
    await source.close();
  }
  expect(remoteHash.digest("hex")).toBe(localHash.digest("hex"));
}

async function seekAndVerifyPlayback(
  page: Page,
  element: import("@playwright/test").Locator,
  media: ExternalMedia,
) {
  const duration = media.durationSeconds ?? 15;
  await element.evaluate((node) => (node as HTMLMediaElement).play());
  const points = [Math.min(1, duration / 10), duration / 2, Math.max(0, duration - 3)];
  for (const point of points) {
    const framesBeforeSeek =
      media.kind === "video"
        ? await element.evaluate(
            (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          )
        : 0;
    await element.evaluate((node, time) => {
      (node as HTMLMediaElement).currentTime = time;
    }, point);
    await expect
      .poll(() => element.evaluate((node) => (node as HTMLMediaElement).currentTime), {
        timeout: 30_000,
      })
      .toBeGreaterThan(point + 0.15);
    if (media.kind === "video")
      await expect
        .poll(() =>
          element.evaluate(
            (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          ),
        )
        .toBeGreaterThan(framesBeforeSeek);
  }
}

const manifestPath = readManifestPath();

test("external private optimized media uploads, renders, plays, seeks, and streams exact ranges", async ({
  page,
}) => {
  test.skip(!manifestPath, "NCF_USER_MEDIA_MANIFEST is not configured");
  test.setTimeout(1_200_000);
  await loginFreshOwner(page);
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath!, "utf8")));
  const uploaded = new Map<string, UploadedNode>();
  const sizes = new Map<string, number>();
  for (const media of manifest.files) {
    const metadata = await stat(media.path);
    if (!metadata.isFile() || metadata.size < 1) throw new Error("external_media_file_invalid");
    sizes.set(media.name, metadata.size);
    uploaded.set(media.name, await uploadWithFileChooser(page, media));
  }

  const image = manifest.files.find((item) => item.kind === "image")!;
  await page.goto("/gallery");
  const card = page.getByRole("button", {
    name: new RegExp(image.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  await expect(card).toBeVisible({ timeout: 120_000 });
  await card.click();
  const imageDialog = page.getByRole("dialog", { name: image.name });
  const photo = imageDialog.locator("img");
  await expect
    .poll(() => photo.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(image.width);
  await expect
    .poll(() => photo.evaluate((node) => (node as HTMLImageElement).naturalHeight))
    .toBe(image.height);
  await imageDialog.getByRole("button", { name: "写真を閉じる" }).click();

  const audio = manifest.files.find((item) => item.kind === "audio")!;
  await page.goto("/audio");
  const audioRow = page.getByRole("button", {
    name: new RegExp(audio.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  await expect(audioRow).toBeVisible({ timeout: 120_000 });
  await audioRow.click();
  const audioElement = page.locator("audio");
  await expect
    .poll(() => audioElement.evaluate((node) => (node as HTMLAudioElement).duration), {
      timeout: 30_000,
    })
    .toBeGreaterThan((audio.durationSeconds ?? 15) - 1);
  await seekAndVerifyPlayback(page, audioElement, audio);

  const video = manifest.files.find((item) => item.kind === "video")!;
  await page.goto("/video");
  const videoRow = page.getByRole("button", {
    name: new RegExp(video.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  await expect(videoRow).toBeVisible({ timeout: 120_000 });
  await videoRow.click();
  const videoNode = uploaded.get(video.name)!;
  const videoElement = page.locator(`video[aria-label="${video.name.replaceAll('"', '\\"')}"]`);
  await expect(videoElement).toHaveAttribute("src", new RegExp(videoNode.id));
  await videoElement.evaluate((node) => (node as HTMLVideoElement).play());
  await expect
    .poll(() => videoElement.evaluate((node) => (node as HTMLVideoElement).videoWidth), {
      timeout: 30_000,
    })
    .toBe(video.width);
  await expect
    .poll(() => videoElement.evaluate((node) => (node as HTMLVideoElement).videoHeight), {
      timeout: 30_000,
    })
    .toBe(video.height);
  await expect
    .poll(() =>
      videoElement.evaluate(
        (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
      ),
    )
    .toBeGreaterThan(0);
  await seekAndVerifyPlayback(page, videoElement, video);
  await expect
    .poll(() =>
      videoElement.evaluate(
        (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
      ),
    )
    .toBeGreaterThan(1);

  for (const media of manifest.files) {
    const node = uploaded.get(media.name)!;
    await hashRemoteByRanges(page, node, media.path, sizes.get(media.name)!);
  }
});
