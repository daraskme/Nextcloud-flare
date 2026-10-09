import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { unlockRecipientVault } from "../../src/lib/cryptoEnvelope";
import {
  type ContainerWriterFactory,
  createEncryptedContainer,
} from "../../src/lib/encryptedContainer";
import { processTestMedia, rootFile, writeTestBytes } from "./uploadHelpers";

const fixture = (name: string) =>
  resolve(import.meta.dirname, "../../../worker/test/fixtures", name);

const media = [
  { name: "avif-still-16x12.avif", width: 16, height: 12 },
  { name: "browser-e2e-tone.mp3", duration: 15 },
  { name: "browser-e2e-av1-opus.webm", duration: 15, video: true },
] as const;

type ExternalMedia = {
  path: string;
  kind: "image" | "audio" | "video";
  name: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

function externalManifestPath() {
  const value = process.env.NCF_USER_MEDIA_MANIFEST;
  return value && isAbsolute(value) ? value : undefined;
}

async function readExternalMedia(): Promise<ExternalMedia[]> {
  const manifestPath = externalManifestPath();
  if (!manifestPath) return [];
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { files?: unknown }).files)
  )
    throw new Error("external_encrypted_media_manifest_invalid");
  const files = (parsed as { files: ExternalMedia[] }).files;
  if (
    files.length !== 3 ||
    new Set(files.map((file) => file?.kind)).size !== 3 ||
    files.some(
      (file) =>
        !file ||
        !["image", "audio", "video"].includes(file.kind) ||
        !isAbsolute(file.path) ||
        !file.name ||
        (file.kind === "image" &&
          (!Number.isFinite(file.width) || !Number.isFinite(file.height))) ||
        (file.kind !== "image" &&
          (!Number.isFinite(file.durationSeconds) || file.durationSeconds! <= 0)) ||
        (file.kind === "video" && (!Number.isFinite(file.width) || !Number.isFinite(file.height))),
    )
  )
    throw new Error("external_encrypted_media_manifest_invalid");
  for (const file of files) {
    const metadata = await stat(file.path);
    if (!metadata.isFile() || metadata.size < 1)
      throw new Error("external_encrypted_media_invalid");
  }
  return files;
}

test.use({ actionTimeout: 15_000 });

type EncryptedNode = {
  id: string;
  name: string;
  currentBlobId: string;
  size: number;
  encryption: { formatVersion: 1 | 2; adminReceiptState: "pending" | "verified" } | null;
};

// The isolated server keeps one immutable identity per fixture account across tests.
// Keep synthetic recovery material with the harness state so a restarted Playwright worker
// reuses the registered key. browser-server.mjs clears this directory before each suite.
const fixtureRecoveryDirectory = resolve(
  import.meta.dirname,
  "../../../../.wrangler/browser-tests/recovery-fixtures",
);

async function setIdentity(page: Page, member: boolean) {
  await page.route("https://app.ncf.test:8879/**", (route) => {
    const headers = { ...route.request().headers() };
    if (member) headers["x-test-identity"] = "member";
    else delete headers["x-test-identity"];
    return route.continue({ headers });
  });
  await page.goto("/");
  const status = await page.evaluate(() =>
    fetch("/__test__/login", { method: "POST" }).then((response) => response.status),
  );
  expect(status).toBe(200);
}

async function saveRecoveryFile(page: Page, directory: string): Promise<string> {
  const accountId = await page.evaluate(
    async () => (await (await fetch("/api/v1/me")).json()).id as string,
  );
  const fixturePath = resolve(
    fixtureRecoveryDirectory,
    `${createHash("sha256").update(accountId).digest("hex")}.json`,
  );
  const saved = await readFile(fixturePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (saved) {
    const path = resolve(directory, `recovery-${randomUUID()}.json`);
    await writeFile(path, saved, { mode: 0o600 });
    await unlockRecoveryFile(page, path);
    return path;
  }
  await expect(
    page.getByText(
      "復旧ファイル自体はパスワード保護されていません。秘密鍵として扱い、このサービスにはアップロードしないでください。",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "暗号化鍵を作成", exact: true }).click();
  const recoveryDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "復旧ファイルを保存", exact: true }).click();
  const download = await recoveryDownload;
  const path = resolve(directory, `recovery-${randomUUID()}.json`);
  await download.saveAs(path);
  await mkdir(fixtureRecoveryDirectory, { recursive: true, mode: 0o700 });
  await writeFile(fixturePath, await readFile(path), { mode: 0o600, flag: "wx" });
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .first()
    .setInputFiles(path);
  await expect(
    page.getByRole("status").filter({ hasText: "この端末で暗号化鍵を解除しました" }),
  ).toBeVisible();
  return path;
}

async function unlockRecoveryFile(page: Page, path: string) {
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .first()
    .setInputFiles(path);
  await expect(
    page.getByRole("status").filter({ hasText: "この端末で暗号化鍵を解除しました" }),
  ).toBeVisible();
}

async function encryptNodes(page: Page): Promise<EncryptedNode[]> {
  return page.evaluate(async () => {
    const me = await fetch("/api/v1/me").then((response) => response.json());
    const result = await fetch(`/api/v1/nodes/${me.rootNodeId}/children`).then((response) =>
      response.json(),
    );
    return result.children.filter(
      (node: EncryptedNode) => node.encryption !== null && node.encryption !== undefined,
    );
  });
}

async function encryptedBody(page: Page, node: EncryptedNode) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/c/${node.id}/${node.currentBlobId}`) &&
      response.request().method() === "GET",
  );
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
    if (issued.status !== 201) throw new Error(`encrypted_content_ticket_${issued.status}`);
    const grant = await issued.json();
    const exchange = await fetch(`${me.contentOrigin}/session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: grant.ticket }),
    });
    if (exchange.status !== 201) throw new Error(`encrypted_content_exchange_${exchange.status}`);
    const response = await fetch(`${me.contentOrigin}/c/${node.id}/${node.currentBlobId}`, {
      credentials: "include",
    });
    await response.arrayBuffer();
    return response.status;
  }, node);
  const response = await responsePromise;
  return { status, bytes: await response.body() };
}

async function expectDecryptedBytes(
  page: Page,
  source: Buffer,
  options: { imageDimensions?: { width: number; height: number }; verifyPlayback?: boolean } = {},
) {
  const preview = page.getByRole("region", { name: "復号プレビュー" });
  const element = preview.locator("img, audio, video");
  await expect(element).toBeVisible();
  if ((await element.evaluate((node) => node.tagName.toLowerCase())) === "img") {
    const expected = options.imageDimensions ?? { width: 16, height: 12 };
    await expect
      .poll(() => element.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(expected.width);
    await expect
      .poll(() => element.evaluate((node) => (node as HTMLImageElement).naturalHeight))
      .toBe(expected.height);
  } else if (options.verifyPlayback !== false) {
    const isVideo = (await element.evaluate((node) => node.tagName.toLowerCase())) === "video";
    await expect
      .poll(() => element.evaluate((node) => (node as HTMLMediaElement).duration), {
        timeout: 30_000,
      })
      .toBeGreaterThan(10);
    if (isVideo) {
      const video = element;
      await video.evaluate((node) => (node as HTMLVideoElement).play());
      await expect
        .poll(() =>
          video.evaluate(
            (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          ),
        )
        .toBeGreaterThan(0);
      const framesBeforeSeek = await video.evaluate(
        (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
      );
      await video.evaluate((node) => {
        (node as HTMLVideoElement).currentTime = 7;
      });
      await expect
        .poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime))
        .toBeGreaterThan(7.3);
      await expect
        .poll(() =>
          video.evaluate(
            (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          ),
        )
        .toBeGreaterThan(framesBeforeSeek);
    } else {
      const audio = element;
      await audio.evaluate((node) => (node as HTMLAudioElement).play());
      await expect
        .poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime))
        .toBeGreaterThan(0.3);
      await audio.evaluate((node) => {
        (node as HTMLAudioElement).currentTime = 7;
      });
      await expect
        .poll(() => audio.evaluate((node) => (node as HTMLAudioElement).currentTime))
        .toBeGreaterThan(7.3);
    }
  }

  const sourceUrl = await element.getAttribute("src");
  if (!sourceUrl || !/\/__client_media\/[a-f0-9]{64}$/.test(sourceUrl))
    throw new Error("encrypted_preview_source_missing");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === new URL(sourceUrl, page.url()).href &&
      response.request().method() === "GET" &&
      response.request().resourceType() === "fetch" &&
      !response.request().headers().range,
  );
  const digest = await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status !== 200) throw new Error(`decrypted_virtual_media_${response.status}`);
    const bytes = await response.arrayBuffer();
    return {
      size: bytes.byteLength,
      hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, sourceUrl);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(digest.size).toBe(source.byteLength);
  expect(digest.hash).toBe(createHash("sha256").update(source).digest("hex"));
}

async function downloadAndCompare(
  page: Page,
  preview: Locator,
  expected: Buffer,
  directory: string,
  label: string,
) {
  // Exercise the browser download fallback deterministically, including exact bytes.
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    });
  });
  const downloadPromise = page.waitForEvent("download");
  await preview.getByRole("button", { name: "復号して保存", exact: true }).click();
  const download = await downloadPromise;
  const path = resolve(directory, `${label}.bin`);
  await download.saveAs(path);
  expect((await readFile(path)).equals(expected)).toBe(true);
}

async function encryptedHeader(page: Page, node: EncryptedNode) {
  await page.evaluate(async (target) => {
    const me = await fetch("/api/v1/me").then((response) => response.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((response) =>
      response.json(),
    );
    const issued = await fetch("/api/v1/content-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        targets: [{ spaceId: me.spaceId, nodeId: target.id }],
        purpose: "content",
        ttlSeconds: 300,
      }),
    });
    if (issued.status !== 201) throw new Error("external_encrypted_ticket_failed");
    const ticket = await issued.json();
    const exchange = await fetch(`${me.contentOrigin}/session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: ticket.ticket }),
    });
    if (exchange.status !== 201) throw new Error("external_encrypted_exchange_failed");
  }, node);
  const contentRange = async (start: number, end: number) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/c/${node.id}/${node.currentBlobId}`) &&
        response.request().headers().range === `bytes=${start}-${end}`,
    );
    const status = await page.evaluate(
      async ({ target, start, end }) => {
        const me = await fetch("/api/v1/me").then((response) => response.json());
        const response = await fetch(`${me.contentOrigin}/c/${target.id}/${target.currentBlobId}`, {
          credentials: "include",
          headers: { Range: `bytes=${start}-${end}` },
        });
        await response.arrayBuffer();
        return response.status;
      },
      { target: node, start, end },
    );
    const response = await responsePromise;
    return { status, range: response.headers()["content-range"], bytes: await response.body() };
  };
  const prefix = await contentRange(0, 11);
  expect(prefix.status).toBe(206);
  expect(prefix.range).toMatch(/^bytes 0-11\/\d+$/);
  expect(prefix.bytes.subarray(0, 8)).toEqual(Buffer.from([78, 67, 70, 69, 78, 67, 50, 0]));
  const headerLength = prefix.bytes.readUInt32BE(8);
  expect(headerLength).toBeGreaterThan(0);
  expect(headerLength).toBeLessThanOrEqual(16 * 1024);
  const headerPart = await contentRange(12, 11 + headerLength);
  expect(headerPart.status).toBe(206);
  expect(headerPart.range).toMatch(new RegExp(`^bytes 12-${11 + headerLength}/\\d+$`));
  return JSON.parse(headerPart.bytes.toString("utf8"));
}

async function simulateMissingContentLength(
  page: Page,
  node: { id: string; currentBlobId: string | null },
  status: 200 | 206 = 206,
) {
  if (!node.currentBlobId) throw new Error("migration_source_blob_missing");
  await page.evaluate(
    async (target) => {
      const me = await fetch("/api/v1/me").then((response) => response.json());
      const contentOrigin = new URL(me.contentOrigin).origin;
      const originalFetch = window.fetch.bind(window);
      const probe = {
        responses: [] as Array<{
          contentLengthAbsent: boolean;
          contentRangePreserved: boolean;
          etagPreserved: boolean;
          urlPreserved: boolean;
          bodyPreserved: boolean;
          statusPreserved: boolean;
        }>,
      };
      Object.defineProperty(window, "__ncfMissingContentLengthProbe", {
        configurable: true,
        value: probe,
      });
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const responseUrl = new URL(response.url);
        if (
          responseUrl.origin === contentOrigin &&
          responseUrl.pathname === `/c/${target.id}/${target.currentBlobId}` &&
          response.status === target.expectedStatus
        ) {
          const originalBody = response.body;
          const originalUrl = response.url;
          const originalStatus = response.status;
          const originalContentRange = response.headers.get("Content-Range");
          const originalEtag = response.headers.get("ETag");
          const pageVisibleHeaders = new Headers(response.headers);
          pageVisibleHeaders.delete("Content-Length");
          Object.defineProperty(response, "headers", {
            configurable: true,
            value: pageVisibleHeaders,
          });
          probe.responses.push({
            contentLengthAbsent: response.headers.get("Content-Length") === null,
            contentRangePreserved: response.headers.get("Content-Range") === originalContentRange,
            etagPreserved: response.headers.get("ETag") === originalEtag,
            urlPreserved: response.url === originalUrl,
            bodyPreserved: response.body === originalBody,
            statusPreserved: response.status === originalStatus,
          });
        }
        return response;
      };
    },
    { id: node.id, currentBlobId: node.currentBlobId, expectedStatus: status },
  );
}

async function expectMissingContentLengthSimulation(page: Page, minimumResponses = 2) {
  const result = await page.evaluate(() => {
    const probe = (
      window as Window & {
        __ncfMissingContentLengthProbe?: {
          responses: Array<Record<string, boolean>>;
        };
      }
    ).__ncfMissingContentLengthProbe;
    return probe?.responses ?? [];
  });
  expect(result.length).toBeGreaterThanOrEqual(minimumResponses);
  for (const response of result) {
    expect(response.contentLengthAbsent).toBe(true);
    expect(response.contentRangePreserved).toBe(true);
    expect(response.etagPreserved).toBe(true);
    expect(response.urlPreserved).toBe(true);
    expect(response.bodyPreserved).toBe(true);
    expect(response.statusPreserved).toBe(true);
  }
}

async function uploadEncryptedFile(page: Page, mediaFile: ExternalMedia) {
  const before = new Set((await encryptNodes(page)).map((node) => node.id));
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "暗号化してアップロード", exact: true }).click();
  await (await chooser).setFiles(mediaFile.path);
  await expect
    .poll(async () => (await encryptNodes(page)).filter((node) => !before.has(node.id)).length, {
      timeout: 120_000,
      intervals: [500, 1000, 2000],
    })
    .toBe(1);
  const node = (await encryptNodes(page)).find((item) => !before.has(item.id))!;
  const task = page.locator(".upload-task").filter({ hasText: node.name });
  const state: { value: "pending" | "completed" | "paused" } = { value: "pending" };
  await expect
    .poll(
      async () => {
        const text = await task.innerText().catch(() => "");
        if (text.includes("アップロード完了")) state.value = "completed";
        else if (
          text.includes("暗号化済みデータから再開") ||
          text.includes("同じファイルを選び直す")
        )
          state.value = "paused";
        return state.value !== "pending";
      },
      { timeout: 30_000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  if (state.value !== "completed") throw new Error("external_encrypted_upload_paused");
  return node;
}

async function playAndSeekEncrypted(
  mediaElement: Locator,
  mediaFile: ExternalMedia,
): Promise<void> {
  const duration = mediaFile.durationSeconds!;
  await expect
    .poll(() => mediaElement.evaluate((node) => (node as HTMLMediaElement).duration), {
      timeout: 60_000,
    })
    .toBeGreaterThan(duration - 2);
  if (mediaFile.kind === "video") {
    await expect
      .poll(() => mediaElement.evaluate((node) => (node as HTMLVideoElement).videoWidth))
      .toBe(mediaFile.width);
    await expect
      .poll(() => mediaElement.evaluate((node) => (node as HTMLVideoElement).videoHeight))
      .toBe(mediaFile.height);
  }
  await mediaElement.evaluate((node) => (node as HTMLMediaElement).play());
  const points = [Math.min(1, duration / 10), duration / 2, Math.max(0.1, duration - 3)];
  for (const point of points) {
    const frames =
      mediaFile.kind === "video"
        ? await mediaElement.evaluate(
            (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          )
        : 0;
    await mediaElement.evaluate((node, time) => {
      (node as HTMLMediaElement).currentTime = time;
    }, point);
    await expect
      .poll(() => mediaElement.evaluate((node) => (node as HTMLMediaElement).currentTime), {
        timeout: 60_000,
      })
      .toBeGreaterThan(point + 0.1);
    if (mediaFile.kind === "video")
      await expect
        .poll(() =>
          mediaElement.evaluate(
            (node) => (node as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
          ),
        )
        .toBeGreaterThan(frames);
  }
}

test("encrypted files are opaque at rest and decrypt only while the member key is unlocked", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const directory = await mkdtemp(resolve(tmpdir(), "ncf-encryption-browser-"));
  try {
    await setIdentity(page, false);
    await page.goto("/encryption");
    const adminRecovery = await saveRecoveryFile(page, directory);

    const publicKeyDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "公開鍵を保存", exact: true }).click();
    const publicKeyPath = resolve(directory, "admin-public-key.json");
    await (await publicKeyDownload).saveAs(publicKeyPath);

    await setIdentity(page, true);
    await page.goto("/encryption");
    const memberRecovery = await saveRecoveryFile(page, directory);
    const adminPublic = JSON.parse(await readFile(publicKeyPath, "utf8"));
    const memberPrivate = JSON.parse(await readFile(memberRecovery, "utf8"));
    const forgedAdminPath = resolve(directory, "forged-admin-public-key.json");
    await writeFile(
      forgedAdminPath,
      JSON.stringify({ ...adminPublic, recipient: memberPrivate.recipientVault.recipient }),
      { mode: 0o600 },
    );
    const forgedChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "管理者公開鍵ファイルを確認", exact: true }).click();
    await (await forgedChooser).setFiles(forgedAdminPath);
    await expect(
      page.getByRole("alert").filter({ hasText: "管理者公開鍵ファイルを検証できませんでした" }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "未固定の管理者公開鍵候補" })).toHaveCount(0);
    const keyChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "管理者公開鍵ファイルを確認", exact: true }).click();
    await (await keyChooser).setFiles(publicKeyPath);
    await expect(page.getByRole("group", { name: "未固定の管理者公開鍵候補" })).toBeVisible();
    await page.getByRole("button", { name: "この公開鍵を固定", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "暗号化してアップロード", exact: true }),
    ).toBeVisible();

    const originals = await Promise.all(media.map((item) => readFile(fixture(item.name))));
    const before = new Set((await encryptNodes(page)).map((node) => node.id));
    const nodes: EncryptedNode[] = [];
    for (const item of media) {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "暗号化してアップロード", exact: true }).click();
      await (await chooser).setFiles(fixture(item.name));
      await expect
        .poll(
          async () => (await encryptNodes(page)).filter((node) => !before.has(node.id)).length,
          {
            timeout: 30_000,
            intervals: [250, 500, 1000],
          },
        )
        .toBe(nodes.length + 1);
      nodes.push(
        (await encryptNodes(page)).find(
          (node) => !before.has(node.id) && !nodes.some((existing) => existing.id === node.id),
        )!,
      );
      await page.getByRole("button", { name: "一覧を更新", exact: true }).click();
    }
    await page.getByRole("button", { name: "完了した項目を閉じる", exact: true }).click();

    expect(nodes).toHaveLength(media.length);
    await page.getByRole("button", { name: "固定を解除", exact: true }).click();
    await expect(
      page.getByText(
        "管理者の公開鍵はまだ固定されていません。固定されるまで暗号化アップロードは利用できません。",
      ),
    ).toBeVisible();
    const uploadButton = page.getByRole("button", {
      name: "暗号化してアップロード",
      exact: true,
    });
    await expect(uploadButton).toBeDisabled();
    let unpinnedUploadRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
        unpinnedUploadRequests++;
    });
    for (const [index, item] of media.entries()) {
      const node = nodes[index]!;
      const original = originals[index]!;
      expect(node.name).toMatch(/^[A-Za-z0-9_-]{22}\.ncf$/);
      const stored = await encryptedBody(page, node);
      expect(stored.status).toBe(200);
      expect(stored.bytes.byteLength).toBe(node.size);
      expect(stored.bytes.byteLength).toBeGreaterThan(original.byteLength);
      expect(stored.bytes.subarray(0, 8)).toEqual(Buffer.from([78, 67, 70, 69, 78, 67, 50, 0]));
      expect(stored.bytes.equals(original)).toBe(false);

      const headerLength = stored.bytes.readUInt32BE(8);
      const header = JSON.parse(stored.bytes.subarray(12, 12 + headerLength).toString("utf8"));
      expect(header.envelope.recipients).toHaveLength(2);
      expect(header.encryptedMetadata).toBeDefined();
      expect(JSON.stringify(header)).not.toContain(item.name);

      const row = page
        .locator(".encryption-list li")
        .filter({ hasText: `暗号化ファイル · ${node.name.slice(0, 8)}` });
      if (index === 0) await simulateMissingContentLength(page, node);
      await row.getByRole("button", { name: "復号して開く", exact: true }).click();
      const preview = page.getByRole("region", { name: "復号プレビュー" });
      await expect(preview.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
      await expectDecryptedBytes(page, original);
      if (index === 0) await expectMissingContentLengthSimulation(page);
      if (index === 0) await downloadAndCompare(page, preview, original, directory, "member-image");
      expect(unpinnedUploadRequests).toBe(0);
      await preview.getByRole("button", { name: "閉じる", exact: true }).click();
    }

    const lastNode = nodes.at(-1)!;
    const row = page
      .locator(".encryption-list li")
      .filter({ hasText: `暗号化ファイル · ${lastNode.name.slice(0, 8)}` });
    await row.getByRole("button", { name: "復号して開く", exact: true }).click();
    const lastPreview = page.getByRole("region", { name: "復号プレビュー" });
    await expect(lastPreview).toBeVisible();
    const lastVideo = lastPreview.locator("video");
    await expect(lastVideo).toHaveAttribute("src", /\/__client_media\//);
    const oldUrl = await lastVideo.getAttribute("src");
    if (!oldUrl) throw new Error("encrypted_preview_source_missing_before_lock");
    await page.getByRole("button", { name: "この端末でロック", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "暗号化してアップロード", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(async (url) => (await fetch(url)).status, oldUrl))
      .toBe(404);
    await page.reload();
    await expect(
      page.getByText("このアカウントの鍵を保存しています。復旧ファイルを選んで解除してください。"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "暗号化してアップロード", exact: true }),
    ).toHaveCount(0);

    let uploadCreates = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
        uploadCreates++;
    });
    await page.goto("/files");
    const lockedUpload = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "アップロード", exact: true }).click();
    await (await lockedUpload).setFiles(fixture(media[0].name));
    await expect(
      page.getByText(
        "暗号化鍵がロックされています。設定画面で解除してからアップロードしてください。",
      ),
    ).toBeVisible();
    expect(uploadCreates).toBe(0);

    await setIdentity(page, false);
    await page.goto("/encryption");
    await unlockRecoveryFile(page, adminRecovery);
    const users = await page.evaluate(async () =>
      fetch("/api/v1/admin/users").then((response) => response.json()),
    );
    const member = users.users.find(
      (user: { email: string }) => user.email === "browser-member@example.invalid",
    );
    expect(member?.id).toBeTruthy();
    await page.getByLabel("暗号化ファイルの所有者").selectOption({
      label: "browser-member@example.invalid",
    });
    await expect(
      page.getByText("管理者として読み取り専用で閲覧しています。閲覧履歴を記録します。"),
    ).toBeVisible();
    const adminRow = page
      .locator(".encryption-list li")
      .filter({ hasText: `暗号化ファイル · ${nodes[0]!.name.slice(0, 8)}` });
    await adminRow.getByRole("button", { name: "復号して開く", exact: true }).click();
    const adminPreview = page.getByRole("region", { name: "復号プレビュー" });
    await expect(
      adminPreview.getByRole("heading", { name: media[0]!.name, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expectDecryptedBytes(page, originals[0]!);
    await downloadAndCompare(page, adminPreview, originals[0]!, directory, "admin-image");
    await expect
      .poll(() =>
        page.evaluate(
          async ({ ownerId, nodeId }) => {
            const response = await fetch("/api/v1/admin/audit");
            if (!response.ok) return false;
            const audit = await response.json();
            return audit.events.some(
              (event: { ownerId: string; nodeId: string; action: string }) =>
                event.ownerId === ownerId && event.nodeId === nodeId && event.action === "preview",
            );
          },
          { ownerId: member.id, nodeId: nodes[0]!.id },
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          async ({ ownerId, nodeId }) => {
            const response = await fetch("/api/v1/admin/audit");
            if (!response.ok) return false;
            const audit = await response.json();
            return audit.events.some(
              (event: { ownerId: string; nodeId: string; action: string }) =>
                event.ownerId === ownerId && event.nodeId === nodeId && event.action === "download",
            );
          },
          { ownerId: member.id, nodeId: nodes[0]!.id },
        ),
      )
      .toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing plaintext media migrates as a verified encrypted copy without removing the source", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(resolve(tmpdir(), "ncf-encryption-migration-"));
  const originalName = `legacy-${randomUUID()}.avif`;
  const originalBytes = await readFile(fixture("avif-still-16x12.avif"));
  try {
    await setIdentity(page, false);
    await page.goto("/");
    const uploaded = await writeTestBytes(page, originalName, new Uint8Array(originalBytes));
    await processTestMedia(page, uploaded.id);
    const source = await rootFile(page, originalName);
    expect(source.name).toBe(originalName);
    expect(source.size).toBe(originalBytes.byteLength);
    expect(source.mime).toBe("image/avif");
    const originalIdentity = {
      id: source.id,
      currentBlobId: source.currentBlobId,
      name: source.name,
      size: source.size,
    };

    await page.goto("/encryption");
    await saveRecoveryFile(page, directory);
    const migrateButton = page
      .locator(".encryption-list li")
      .filter({ hasText: originalName })
      .getByRole("button", { name: "暗号化コピーを作成", exact: true });
    await expect(migrateButton).toBeVisible();
    const before = new Set((await encryptNodes(page)).map((node) => node.id));
    await simulateMissingContentLength(page, source, 200);
    await migrateButton.click();
    await expect(
      page.getByRole("status").filter({ hasText: "暗号化コピーの送信を開始しました" }),
    ).toBeVisible();
    await expect
      .poll(async () => (await encryptNodes(page)).filter((node) => !before.has(node.id)).length, {
        timeout: 60_000,
        intervals: [250, 500, 1000],
      })
      .toBe(1);
    await expectMissingContentLengthSimulation(page, 1);

    const encrypted = (await encryptNodes(page)).find((node) => !before.has(node.id));
    expect(encrypted).toBeTruthy();
    expect(encrypted!.name).toMatch(/^[A-Za-z0-9_-]{22}\.ncf$/);
    expect(encrypted!.id).not.toBe(originalIdentity.id);
    expect(encrypted!.size).toBeGreaterThan(originalBytes.byteLength);
    const currentSource = await rootFile(page, originalName);
    expect(currentSource).toMatchObject(originalIdentity);

    const encryptedRow = page
      .locator(".encryption-list li")
      .filter({ hasText: `暗号化ファイル · ${encrypted!.name.slice(0, 8)}` });
    await encryptedRow.getByRole("button", { name: "復号して開く", exact: true }).click();
    const preview = page.getByRole("region", { name: "復号プレビュー" });
    await expect(preview.getByRole("heading", { name: originalName, exact: true })).toBeVisible();
    await expectDecryptedBytes(page, originalBytes, {
      imageDimensions: { width: 16, height: 12 },
      verifyPlayback: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external private media decrypts and seeks in the browser", async ({ page }) => {
  test.skip(!externalManifestPath(), "NCF_USER_MEDIA_MANIFEST is not configured");
  test.setTimeout(1_200_000);
  const files = await readExternalMedia();
  const directory = await mkdtemp(resolve(tmpdir(), "ncf-encrypted-external-media-"));
  try {
    await setIdentity(page, false);
    await page.goto("/encryption");
    await saveRecoveryFile(page, directory);
    const publicKeyDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "公開鍵を保存", exact: true }).click();
    const publicKeyPath = resolve(directory, "admin-public-key.json");
    await (await publicKeyDownload).saveAs(publicKeyPath);

    await setIdentity(page, true);
    await page.goto("/encryption");
    await saveRecoveryFile(page, directory);
    const keyChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "管理者公開鍵ファイルを確認", exact: true }).click();
    await (await keyChooser).setFiles(publicKeyPath);
    await expect(page.getByRole("group", { name: "未固定の管理者公開鍵候補" })).toBeVisible();
    await page.getByRole("button", { name: "この公開鍵を固定", exact: true }).click();

    const uploaded = new Map<string, EncryptedNode>();
    for (const mediaFile of files)
      uploaded.set(mediaFile.kind, await uploadEncryptedFile(page, mediaFile));
    await page.getByRole("button", { name: "完了した項目を閉じる", exact: true }).click();

    for (const mediaFile of files) {
      const node = uploaded.get(mediaFile.kind)!;
      expect(node.name).toMatch(/^[A-Za-z0-9_-]{22}\.ncf$/);
      const header = await encryptedHeader(page, node);
      expect(header.envelope.recipients).toHaveLength(2);
      expect(JSON.stringify(header)).not.toContain(mediaFile.name);

      const row = page
        .locator(".encryption-list li")
        .filter({ hasText: `暗号化ファイル · ${node.name.slice(0, 8)}` });
      await row.getByRole("button", { name: "復号して開く", exact: true }).click();
      const preview = page.getByRole("region", { name: "復号プレビュー" });
      await expect(
        preview.getByRole("heading", { name: mediaFile.name, exact: true }),
      ).toBeVisible();
      if (mediaFile.kind === "image") {
        const image = preview.locator("img");
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBe(mediaFile.width);
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalHeight))
          .toBe(mediaFile.height);
        await expectDecryptedBytes(page, await readFile(mediaFile.path), {
          imageDimensions: { width: mediaFile.width!, height: mediaFile.height! },
          verifyPlayback: false,
        });
      } else {
        const element = preview.locator(mediaFile.kind === "audio" ? "audio" : "video");
        await expect(element).toHaveAttribute("src", /\/__client_media\//);
        await expectDecryptedBytes(page, await readFile(mediaFile.path), {
          verifyPlayback: false,
        });
        await playAndSeekEncrypted(element, mediaFile);
      }
      await preview.getByRole("button", { name: "閉じる", exact: true }).click();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy unsigned container requires owner review and explicit adoption", async ({ page }) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(resolve(tmpdir(), "ncf-legacy-adoption-"));
  const plainName = `legacy-review-${randomUUID()}.avif`;
  const original = await readFile(fixture("avif-still-16x12.avif"));
  try {
    await setIdentity(page, false);
    await page.goto("/encryption");
    const adminRecoveryPath = await saveRecoveryFile(page, directory);
    const adminId = await page.evaluate(async () =>
      fetch("/api/v1/me").then(async (response) => ((await response.json()) as { id: string }).id),
    );
    const adminRecovery = JSON.parse(await readFile(adminRecoveryPath, "utf8")) as {
      recipientVault: Parameters<typeof unlockRecipientVault>[0];
      recoveryKey: string;
    };
    const admin = await unlockRecipientVault(
      adminRecovery.recipientVault,
      adminRecovery.recoveryKey,
      adminId,
    );
    const publicKeyDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "公開鍵を保存", exact: true }).click();
    const publicKeyPath = resolve(directory, "legacy-admin-public-key.json");
    await (await publicKeyDownload).saveAs(publicKeyPath);

    await setIdentity(page, true);
    await page.goto("/encryption");
    const memberRecoveryPath = await saveRecoveryFile(page, directory);
    const memberId = await page.evaluate(async () =>
      fetch("/api/v1/me").then(async (response) => ((await response.json()) as { id: string }).id),
    );
    const memberRecovery = JSON.parse(await readFile(memberRecoveryPath, "utf8")) as {
      recipientVault: Parameters<typeof unlockRecipientVault>[0];
      recoveryKey: string;
    };
    const member = await unlockRecipientVault(
      memberRecovery.recipientVault,
      memberRecovery.recoveryKey,
      memberId,
    );
    const keyChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "管理者公開鍵ファイルを確認", exact: true }).click();
    await (await keyChooser).setFiles(publicKeyPath);
    await expect(page.getByRole("group", { name: "未固定の管理者公開鍵候補" })).toBeVisible();
    await page.getByRole("button", { name: "この公開鍵を固定", exact: true }).click();

    const writer: ContainerWriterFactory = async (name) => {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      return {
        async write(bytes) {
          parts.push(new Uint8Array(bytes));
        },
        async close() {
          return new File(parts, name);
        },
        async discard() {
          parts.length = 0;
        },
      };
    };
    const legacy = await createEncryptedContainer(
      new File([new Uint8Array(original)], plainName, { type: "image/avif" }),
      [member.publicKey, admin.publicKey],
      writer,
      undefined,
      { legacyUnsigned: true },
    );
    const uploaded = await writeTestBytes(
      page,
      legacy.opaqueName,
      new Uint8Array(await legacy.file.arrayBuffer()),
    );
    expect(uploaded.encryption).toBeNull();
    expect(uploaded.name).toBe(legacy.opaqueName);
    await page.getByRole("button", { name: "一覧を更新", exact: true }).click();
    const row = page.locator(".encryption-list li").filter({ hasText: legacy.opaqueName });
    await expect(row.getByText("未暗号化")).toBeVisible();
    await row.getByRole("button", { name: "旧形式を確認", exact: true }).click();

    const review = page.getByRole("dialog", { name: "旧形式ファイルの確認" });
    await expect(
      review.getByRole("heading", { name: `旧形式の内容確認: ${plainName}` }),
    ).toBeVisible();
    await expect(review.getByText(/過去の送信者を証明できません/)).toBeVisible();
    const image = review.locator("img");
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(16);
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalHeight))
      .toBe(12);
    const previewUrl = await image.getAttribute("src");
    if (!previewUrl) throw new Error("legacy_review_preview_missing");
    const reviewHash = await page.evaluate(async (url) => {
      const bytes = await fetch(url).then((response) => response.arrayBuffer());
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }, previewUrl);
    expect(reviewHash).toBe(createHash("sha256").update(original).digest("hex"));

    const expectRevoked = async (url: string) => {
      await expect
        .poll(() =>
          page.evaluate(async (url) => {
            try {
              await fetch(url);
              return false;
            } catch {
              return true;
            }
          }, url),
        )
        .toBe(true);
    };
    const reopenReview = async () => {
      await row.getByRole("button", { name: "旧形式を確認", exact: true }).click();
      await expect(review).toBeVisible();
      const url = await review.locator("img").getAttribute("src");
      if (!url) throw new Error("legacy_review_preview_missing");
      return url;
    };

    await review.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expectRevoked(previewUrl);

    const lockedUrl = await reopenReview();
    await page.getByRole("button", { name: "この端末でロック", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expectRevoked(lockedUrl);
    await unlockRecoveryFile(page, memberRecoveryPath);

    const unmountedUrl = await reopenReview();
    await page.locator('a.nav-link[href="/files"]').click();
    await expect(review).toHaveCount(0);
    await expectRevoked(unmountedUrl);
    await page.locator('a.nav-link[href="/encryption"]').click();
    await expect(
      page.getByRole("status").filter({
        hasText: "現在のアカウント署名鍵をサーバー登録情報と照合しました。",
      }),
    ).toBeVisible();
    const adoptedUrl = await reopenReview();

    const adopt = review.getByRole("button", { name: "この旧形式に所有者署名を登録", exact: true });
    await expect(adopt).toBeDisabled();
    await review
      .getByLabel("この内容を確認しました。過去の送信者は証明できないことを理解しています。")
      .check();
    await expect(adopt).toBeEnabled();
    await adopt.click();
    await expect(
      page.getByRole("status").filter({ hasText: "過去の送信者は証明されません" }),
    ).toBeVisible();
    await expect(review).toHaveCount(0);
    await expectRevoked(adoptedUrl);
    await expect
      .poll(async () => {
        const current = await rootFile(page, legacy.opaqueName);
        return current.encryption?.formatVersion ?? null;
      })
      .toBe(1);

    const adoptedRow = page
      .locator(".encryption-list li")
      .filter({ hasText: `暗号化ファイル · ${legacy.opaqueName.slice(0, 8)}` });
    await adoptedRow.getByRole("button", { name: "復号して開く", exact: true }).click();
    const normalPreview = page.getByRole("region", { name: "復号プレビュー" });
    await expect(
      normalPreview.getByRole("heading", { name: plainName, exact: true }),
    ).toBeVisible();
    await expectDecryptedBytes(page, original, {
      imageDimensions: { width: 16, height: 12 },
      verifyPlayback: false,
    });

    await setIdentity(page, false);
    await page.goto("/encryption");
    await saveRecoveryFile(page, directory);
    const users = await page.evaluate(async () =>
      fetch("/api/v1/admin/users").then((response) => response.json()),
    );
    const memberUser = users.users.find((user: { id: string }) => user.id === memberId);
    expect(memberUser?.id).toBe(memberId);
    await page.getByLabel("暗号化ファイルの所有者").selectOption({ label: memberUser.email });
    const adminRow = page
      .locator(".encryption-list li")
      .filter({ hasText: `暗号化ファイル · ${legacy.opaqueName.slice(0, 8)}` });
    await adminRow.getByRole("button", { name: "復号して開く", exact: true }).click();
    const adminPreview = page.getByRole("region", { name: "復号プレビュー" });
    await expect(adminPreview.getByRole("heading", { name: plainName, exact: true })).toBeVisible();
    const verified = await page.evaluate(
      async ({ memberId, nodeId }) => {
        const response = await fetch(`/api/v1/admin/users/${memberId}/nodes/${nodeId}`);
        if (!response.ok) return false;
        const body = await response.json();
        return body.encryption?.adminReceiptState === "verified";
      },
      { memberId, nodeId: uploaded.id },
    );
    expect(verified).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const previewRoute of ["drive", "novels"] as const)
  test(`cached unlock restores filenames without content reads and opens encrypted text in ${previewRoute}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(resolve(tmpdir(), "ncf-cached-unlock-"));
    const name = `小説-${randomUUID()}.txt`;
    const original = Buffer.from("第一章\n\n鍵を解除すると読める物語です。\n".repeat(100));
    try {
      await setIdentity(page, false);
      await page.goto("/encryption");
      await saveRecoveryFile(page, directory);
      await expect(
        page.getByRole("button", { name: "暗号化してアップロード", exact: true }),
      ).toBeEnabled();
      await page.getByRole("link", { name: "マイドライブ", exact: true }).click();
      await expect(page.getByText("新規アップロードには端末の暗号化鍵が必要です。")).toHaveCount(0);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "アップロード", exact: true }).click();
      await (await chooser).setFiles({ name, mimeType: "text/plain", buffer: original });
      await expect(
        page.locator(".upload-task").filter({ hasText: "アップロード完了" }),
      ).toHaveCount(1, { timeout: 30_000 });
      await expect(
        page.getByRole("button", { name: `${name} ファイル`, exact: true }),
      ).toBeVisible();
      // A reload must restore the original filename from locally verified encrypted headers,
      // even when downloading headers again is unavailable.
      await page.route("**/api/v1/content-session", (route) => route.abort("failed"));
      await page.reload();
      await expect(page.getByRole("button", { name: `${name} ファイル`, exact: true })).toBeVisible(
        {
          timeout: 30_000,
        },
      );
      await expect(
        page.locator(".file-name").filter({ hasText: /[a-f0-9-]{32,}\.ncf/ }),
      ).toHaveCount(0);
      await page.unroute("**/api/v1/content-session");
      if (previewRoute === "novels") {
        await page.getByRole("link", { name: "小説", exact: true }).click();
        // Reload so the Service Worker's client URL is /novels, not the earlier /files document.
        await page.reload();
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/__test__/legacy-media-worker.js", {
            scope: "/",
          });
          await navigator.serviceWorker.ready;
        });
        await expect
          .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
          .toContain("/__test__/legacy-media-worker.js");
        await page.locator(".novel-card").filter({ hasText: name }).click();
      } else {
        await page.getByRole("button", { name: `${name} ファイル`, exact: true }).click();
      }
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("本文")).toContainText("鍵を解除すると読める物語です。", {
        timeout: 35_000,
      });
      await expect
        .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
        .toContain("/public-assets/client-media-worker.js");
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "ダウンロード", exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(name);
      expect(await readFile((await file.path())!)).toEqual(original);
      await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
      await page.getByRole("link", { name: "小説", exact: true }).click();
      await expect(page.locator(".novel-card").filter({ hasText: name })).toBeVisible();
      await page.getByRole("link", { name: "暗号化ファイル", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "この端末で暗号化鍵を解除しました" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "この端末でロック", exact: true }).click();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "暗号化してアップロード", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("link", { name: "マイドライブ", exact: true }).click();
      await expect(page.getByRole("button", { name: `${name} ファイル`, exact: true })).toHaveCount(
        0,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
