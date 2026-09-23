import { open } from "node:fs/promises";
import { expect, type Route, test } from "@playwright/test";
import { fileContent, openOverwrite, rootFile, writeTestFile } from "./uploadHelpers";

// Node fetch inherits neither Chromium's host resolver nor its later Fetch Metadata headers.
const localFetch = async (route: Route) => {
  expect(new URL(route.request().url()).origin).toBe("https://app.ncf.test:8879");
  return route.fetch({
    url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
    headers: {
      ...(await route.request().allHeaders()),
      host: "app.ncf.test:8879",
      "sec-fetch-site": "same-origin",
    },
  });
};

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("real Files API: create, rename, upload, open, trash, restore, copy and move", async ({
  page,
}) => {
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("ブラウザーテスト");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "新しいフォルダー", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "ブラウザーテスト", exact: false })
    .filter({ hasNot: page.locator("svg") })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "ブラウザーテスト", exact: true })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooser).setFiles({
    name: "こんにちは.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Nextcloud flare browser upload\n"),
  });
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("button", { name: "こんにちは.txtの操作" })).toBeVisible();
  await page.getByRole("button", { name: "こんにちは.txtの操作" }).click();
  await page.getByRole("menuitem", { name: "名前を変更" }).click();
  await page.getByLabel("名前", { exact: true }).fill("保存したメモ.txt");
  await page.getByRole("dialog").getByRole("button", { name: "名前を変更", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存したメモ.txtの操作" })).toBeVisible();
  await page.getByRole("button", { name: "保存したメモ.txtの操作" }).click();
  await page.getByRole("menuitem", { name: "ごみ箱に移動" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "ごみ箱に移動", exact: true }).click();
  await page.getByRole("link", { name: "ごみ箱", exact: true }).click();
  await expect(page.getByText("保存したメモ.txt", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => fetch("/__test__/control").then((r) => r.json()))).toMatchObject(
    { maintenance: false, gcPaused: false },
  );
  await page.getByRole("button", { name: "復元", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "復元先を選択", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => fetch("/__test__/control").then((r) => r.json()))).toMatchObject(
    { maintenance: false, gcPaused: false },
  );
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "マイドライブ", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "保存したメモ.txtの操作" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "保存したメモ.txtの操作" })).toBeVisible();
  await page.getByRole("button", { name: "保存したメモ.txtの操作" }).click();
  await page.getByRole("menuitem", { name: "コピー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("コピーしたメモ.txt");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "ブラウザーテスト", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "上の階層", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "ブラウザーテスト", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "コピー先を選択", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "コピーしたメモ.txtの操作" })).toBeVisible();
  await page.getByRole("button", { name: "コピーしたメモ.txtの操作" }).click();
  await page.getByRole("menuitem", { name: "移動", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "ブラウザーテスト", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "移動先を選択", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "コピーしたメモ.txtの操作" })).toHaveCount(0);
  await page.getByRole("button", { name: "保存したメモ.txtの操作" }).click();
  const opened = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: "ファイルを開く・保存" }).click();
  const popup = await opened;
  const download = await popup.waitForEvent("download");
  expect(download.suggestedFilename()).toBe("保存したメモ.txt");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe("Nextcloud flare browser upload\n");
  await popup.close();
});

test("a lost restore response replays the same operation after GC has resumed", async ({
  page,
}) => {
  await page.goto("/files");
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("復元の応答喪失");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "復元の応答喪失の操作" }).click();
  await page.getByRole("menuitem", { name: "ごみ箱に移動" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "ごみ箱に移動", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name: "ごみ箱", exact: true }).click();
  const keys: string[] = [];
  await page.route("**/api/v1/trash/*/restore", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    if (keys.length === 1) {
      expect((await localFetch(route)).status()).toBe(200);
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "復元", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "復元先を選択", exact: true }).click();
  await expect(page.getByRole("button", { name: "同じ操作の結果を確認" })).toBeVisible();
  expect(await page.evaluate(() => fetch("/__test__/control").then((r) => r.json()))).toMatchObject(
    { maintenance: false, gcPaused: false },
  );
  await page.reload();
  await page.getByRole("button", { name: "結果を確認", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("ncf-pending-operation")))
    .toBeNull();
  await expect(page.getByText("復元の応答喪失", { exact: true })).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "マイドライブ", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "復元の応答喪失の操作" })).toHaveCount(1);
});

test("mobile layout, grid and keyboard dialog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/files");
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("モバイルのフォルダー");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "グリッド表示" }).click();
  await expect(
    page.getByRole("button", { name: "モバイルのフォルダー", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "ごみ箱", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ごみ箱", exact: true })).toBeVisible();
});

test("a lost mutation response survives reload and reuses its original idempotency key", async ({
  page,
}) => {
  await page.goto("/files");
  const keys: string[] = [];
  await page.route("**/api/v1/nodes", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    if (keys.length === 1) {
      expect((await localFetch(route)).status()).toBe(201);
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("応答喪失でも一つ");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "新しいフォルダー", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "同じ操作の結果を確認" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "結果を確認", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("ncf-pending-operation")))
    .toBeNull();
  await expect(
    page.getByRole("button", { name: "応答喪失でも一つの操作", exact: true }),
  ).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(await page.evaluate(() => sessionStorage.getItem("ncf-pending-operation"))).toBeNull();
});

test("filenames render as text and stale content is hidden after authentication expires", async ({
  page,
}) => {
  await page.route("**/api/v1/nodes/*/children", async (route) => {
    const response = await localFetch(route);
    const json = await response.json();
    json.children = [
      {
        id: "unsafe-name",
        name: '<img src=x onerror="window.injected=true">',
        kind: "file",
        revision: 1,
        currentBlobId: null,
        updatedAt: Date.now(),
        size: 0,
        mime: null,
      },
    ];
    await route.fulfill({ response, json });
  });
  await page.goto("/files");
  await expect(page.locator(".file-name").first()).toContainText("<img src=x");
  expect(await page.evaluate(() => Reflect.get(window, "injected"))).toBeUndefined();
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/problem+json",
      body: JSON.stringify({ title: "unauthorized", status: 401 }),
    }),
  );
  await page.getByRole("button", { name: "一覧を更新" }).click();
  await expect(page.getByRole("heading", { name: "スペースに接続できません" })).toBeVisible();
  await expect(page.locator(".file-name")).toHaveCount(0);
});

test("private pages and every built chunk require Access and never fall back from unrelated paths", async ({
  page,
  request,
}) => {
  const response = await page.goto("/files");
  expect(response?.headers()["cache-control"]).toBe("private, no-store");
  expect(response?.headers()["content-security-policy"]).toContain(
    "connect-src 'self' https://content.ncf.test:8879",
  );
  expect(response?.headers()["content-security-policy"]).not.toContain(
    "script-src 'self' 'unsafe-inline'",
  );
  const chunks = await page
    .locator('script[src],link[rel="modulepreload"],link[rel="stylesheet"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("src") ?? element.getAttribute("href")!),
    );
  expect(chunks.length).toBeGreaterThan(3);
  for (const path of ["/", "/files", "/trash", ...chunks]) {
    const status = await page.evaluate(
      async (path) => (await fetch(path, { headers: { "X-Test-Without-Auth": "1" } })).status,
      path,
    );
    expect(status, path).toBe(401);
  }
  for (const path of [
    "/index.html",
    "/.vite/manifest.json",
    "/private-assets/missing.js",
    "/unknown",
    "/public/unknown",
    "/service/unknown",
  ]) {
    const result = await page.evaluate(async (path) => {
      const r = await fetch(path);
      return { status: r.status, html: (await r.text()).includes('<div id="root">') };
    }, path);
    expect(result.status, path).toBeGreaterThanOrEqual(400);
    expect(result.html, path).toBe(false);
  }
  const head = await request.head("https://127.0.0.1:8879/files", {
    headers: { host: "app.ncf.test:8879" },
  });
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  const post = await request.post("https://127.0.0.1:8879/files", {
    headers: { host: "app.ncf.test:8879" },
  });
  expect(post.status()).toBe(404);
  const wrongHost = await request.get(`https://127.0.0.1:8879${chunks[0]}`, {
    headers: { host: "content.ncf.test:8879" },
  });
  expect(wrongHost.status()).toBeGreaterThanOrEqual(400);
  expect(await wrongHost.text()).not.toContain('<div id="root">');
});

test("multipart reload reuses the upload and attempt, skips confirmed bytes and rejects a different file", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const filePath = info.outputPath("再開できる大きなファイル.bin");
  const file = await open(filePath, "w");
  await file.write(Buffer.from("multipart browser fixture"));
  await file.truncate(96 * 1024 * 1024 + 37);
  await file.close();
  const attempts: string[] = [];
  let creates = 0;
  let firstParts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
      creates++;
    if (request.url().endsWith("/parts/1")) firstParts++;
  });
  await page.route("**/api/v1/uploads/*/parts/2", async (route) => {
    attempts.push(route.request().headers()["upload-attempt-id"]!);
    if (attempts.length === 1) await route.abort("connectionfailed");
    else await route.continue();
  });
  await page.goto("/files");
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooser).setFiles(filePath);
  await expect(page.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible({
    timeout: 90_000,
  });
  await page.reload();
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
  await (await chooser).setFiles({
    name: "違うファイル.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("different"),
  });
  await expect(
    page.getByText("名前・サイズ・更新日時・内容が一致する元のファイルを選んでください"),
  ).toBeVisible();
  expect(creates).toBe(1);
  expect(attempts).toHaveLength(1);
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
  await (await chooser).setFiles(filePath);
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  expect(creates).toBe(1);
  expect(firstParts).toBe(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  await expect(
    page.getByRole("button", { name: "再開できる大きなファイル.binの操作" }),
  ).toBeVisible();
  const storage = await page.evaluate(async () => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    return { used: me.usedBytes, reserved: me.reservedBytes };
  });
  expect(storage.used).toBeGreaterThanOrEqual(96 * 1024 * 1024 + 37);
  expect(storage.reserved).toBe(0);
  await page.getByRole("button", { name: "完了した項目を閉じる" }).click();
  await page.screenshot({
    path: info.outputPath("files-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("files-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("an uncertain single upload is not resent and can be cancelled; purge needs explicit confirmation", async ({
  page,
}) => {
  let sends = 0;
  await page.route("**/api/v1/uploads/*/content", async (route) => {
    sends++;
    await route.abort("connectionfailed");
  });
  await page.goto("/files");
  const source = {
    name: "中止する送信.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("cancel"),
  };
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooser).setFiles(source);
  await expect(page.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible();
  expect(sends).toBe(1);
  await page.getByRole("button", { name: "中止する送信.txtを中止" }).click();
  await expect(
    page.getByText("中止を受け付けました。使用容量は回収後に反映されます"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "中止する送信.txtの操作" })).toHaveCount(0);
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("完全削除の確認");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "完全削除の確認の操作" }).click();
  await page.getByRole("menuitem", { name: "ごみ箱に移動" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "ごみ箱に移動", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name: "ごみ箱", exact: true }).click();
  await page.getByRole("button", { name: "完全削除の確認を完全に削除" }).click();
  const submit = page.getByRole("dialog").getByRole("button", { name: "完全に削除", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByLabel("完全に削除することを確認しました").check();
  await submit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("完全削除の確認", { exact: true })).toHaveCount(0);
});

test("overwrite confirms the destination, recovers a lost completion and accepts an empty file", async ({
  page,
}, info) => {
  await page.goto("/files");
  const name = "上書き先.txt";
  const before = await writeTestFile(page, name, "original");
  await page.reload();
  const value = "replacement from a differently named local file\n";
  const filePath = info.outputPath("ローカルの原稿.txt");
  const file = await open(filePath, "w");
  await file.write(value);
  await file.close();
  const creates: Record<string, unknown>[] = [];
  const matches: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
      creates.push(request.postDataJSON());
    if (request.method() === "PUT" && request.url().endsWith("/content"))
      matches.push(request.headers()["if-match"]!);
  });
  await openOverwrite(page, name);
  await expect(page.getByRole("button", { name: "上書きを開始" })).toBeDisabled();
  await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles(filePath);
  await page.screenshot({ path: info.outputPath("overwrite-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("overwrite-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  expect(creates).toHaveLength(0);
  expect(await fileContent(page, before)).toBe("original");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openOverwrite(page, name);
  await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles(filePath);
  let completions = 0;
  await page.route("**/api/v1/uploads/*/complete", async (route) => {
    if (++completions === 1) {
      expect((await localFetch(route)).status()).toBe(200);
      await route.abort("connectionfailed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "上書きを開始" }).click();
  await expect(page.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible();
  const after = await rootFile(page, name);
  expect(after).toMatchObject({
    id: before.id,
    name,
    revision: before.revision + 1,
    size: Buffer.byteLength(value),
  });
  expect(after.currentBlobId).not.toBe(before.currentBlobId);
  expect(await fileContent(page, after)).toBe(value);
  await page.reload();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
  await (await chooser).setFiles(filePath);
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible();
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({ name, targetId: before.id, targetRevision: before.revision });
  expect(matches).toEqual([`"b-${before.currentBlobId}"`]);
  expect(completions).toBe(1);
  await page.getByRole("button", { name: "完了した項目を閉じる" }).click();
  await openOverwrite(page, name);
  await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles({
    name: "空のファイル.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0),
  });
  await page.getByRole("button", { name: "上書きを開始" }).click();
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible();
  const empty = await rootFile(page, name);
  expect(empty).toMatchObject({ id: before.id, name, revision: after.revision + 1, size: 0 });
  expect(await fileContent(page, empty)).toBe("");
  expect(matches).toEqual([`"b-${before.currentBlobId}"`, `"b-${after.currentBlobId}"`]);
});

test("overwrite rejects a changed destination before enqueue and during transfer without replacing newer content", async ({
  page,
}) => {
  await page.goto("/files");
  const name = "競合を守る.txt";
  const before = await writeTestFile(page, name, "first");
  await page.reload();
  await openOverwrite(page, name);
  const local = {
    name: "selected.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("stale replacement"),
  };
  await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles(local);
  const changed = await writeTestFile(page, name, "changed before confirmation", before);
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
      creates++;
  });
  await page.getByRole("button", { name: "上書きを開始" }).click();
  await expect(page.getByRole("alert")).toContainText("上書き先が変更されています");
  expect(creates).toBe(0);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByRole("region", { name: "アップロード状況" })).toHaveCount(0);
  await page.reload();
  await openOverwrite(page, name);
  await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles(local);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let held = false;
  let status = 0;
  await page.route("**/api/v1/uploads/*/content", async (route) => {
    if (held) return route.continue();
    held = true;
    expect(route.request().headers()["if-match"]).toBe(`"b-${changed.currentBlobId}"`);
    await blocked;
    const response = await localFetch(route);
    status = response.status();
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "上書きを開始" }).click();
  await expect.poll(() => held).toBe(true);
  const newer = await writeTestFile(page, name, "newer concurrent content", changed);
  unblock();
  await expect(page.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible();
  expect(status).toBe(409);
  expect(await rootFile(page, name)).toMatchObject({
    revision: newer.revision,
    currentBlobId: newer.currentBlobId,
  });
  expect(await fileContent(page, newer)).toBe("newer concurrent content");
  await page.getByRole("button", { name: `${name}を中止`, exact: true }).click();
  await expect(
    page.getByText("中止を受け付けました。使用容量は回収後に反映されます"),
  ).toBeVisible();
  expect(await fileContent(page, newer)).toBe("newer concurrent content");
});

for (const mode of ["single", "multipart"] as const) {
  test(`${mode} overwrite recovers a lost creation receipt after a newer update and can be cancelled`, async ({
    page,
  }, info) => {
    await page.goto("/files");
    const name = `受付応答の再確認-${mode}.bin`;
    const before = await writeTestFile(page, name, "original");
    await page.reload();
    const filePath = info.outputPath(`local-${mode}.bin`);
    const file = await open(filePath, "w");
    await file.write("stale local content");
    if (mode === "multipart") await file.truncate(96 * 1024 * 1024 + 37);
    await file.close();
    let key: string | undefined;
    let original: { id: string; capability: string } | undefined;
    let recovered = false;
    let creates = 0;
    let writes = 0;
    page.on("request", (request) => {
      if (
        original &&
        new URL(request.url()).pathname.startsWith(`/api/v1/uploads/${original.id}/`) &&
        ["PUT", "POST"].includes(request.method())
      )
        writes++;
    });
    await page.route("**/api/v1/uploads", async (route) => {
      const request = route.request();
      const requestKey = request.headers()["idempotency-key"]!;
      if (key && requestKey !== key) return route.continue();
      key ??= requestKey;
      creates++;
      expect(request.postDataJSON()).toMatchObject({
        mode,
        name,
        targetId: before.id,
        targetRevision: before.revision,
      });
      const response = await localFetch(route);
      if (!original) {
        expect(response.status()).toBe(201);
        original = await response.json();
        await route.abort("connectionfailed");
      } else {
        expect(response.status()).toBe(mode === "single" ? 201 : 202);
        expect(await response.json()).toMatchObject(original);
        recovered = true;
        await route.fulfill({ response });
      }
    });
    await openOverwrite(page, name);
    await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles(filePath);
    await page.getByRole("button", { name: "上書きを開始" }).click();
    await expect(page.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible();
    expect(original).toBeDefined();
    const newer = await writeTestFile(page, name, "newer content must survive", before);
    await page.reload();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
    await (await chooser).setFiles(filePath);
    await expect(
      page.getByText(
        "上書き先が変更されています。この送信を中止し、一覧を更新して選び直してください。",
        { exact: true },
      ),
    ).toBeVisible();
    expect(recovered).toBe(true);
    expect(creates).toBe(2);
    expect(writes).toBe(0);
    await page.getByRole("button", { name: `${name}を中止`, exact: true }).click();
    await expect(
      page.getByText("中止を受け付けました。使用容量は回収後に反映されます"),
    ).toBeVisible();
    expect(await rootFile(page, name)).toMatchObject({
      revision: newer.revision,
      currentBlobId: newer.currentBlobId,
    });
    expect(await fileContent(page, newer)).toBe("newer content must survive");
    await page.reload();
    await expect(page.getByRole("region", { name: "アップロード状況" })).toHaveCount(0);
  });
}

test("multipart overwrite preserves its confirmed target and attempt across reload", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await page.goto("/files");
  const name = "分割で上書き.bin";
  const before = await writeTestFile(page, name, "original multipart target");
  await page.reload();
  const filePath = info.outputPath("選択した分割データ.bin");
  const value = "multipart replacement fixture";
  const file = await open(filePath, "w");
  await file.write(value);
  const size = 96 * 1024 * 1024 + 37;
  await file.truncate(size);
  await file.close();
  const creates: Record<string, unknown>[] = [];
  const matches: string[] = [];
  const attempts: string[] = [];
  let firstParts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
      creates.push(request.postDataJSON());
    if (/\/parts\/\d+$/.test(request.url())) matches.push(request.headers()["if-match"]!);
    if (request.url().endsWith("/parts/1")) firstParts++;
  });
  await page.route("**/api/v1/uploads/*/parts/2", async (route) => {
    attempts.push(route.request().headers()["upload-attempt-id"]!);
    if (attempts.length === 1) await route.abort("connectionfailed");
    else await route.continue();
  });
  await openOverwrite(page, name);
  await page.getByLabel("上書きするファイル", { exact: true }).setInputFiles(filePath);
  await page.getByRole("button", { name: "上書きを開始" }).click();
  await expect(page.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible({
    timeout: 90_000,
  });
  expect(await fileContent(page, before)).toBe("original multipart target");
  await page.reload();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
  await (await chooser).setFiles(filePath);
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    targetId: before.id,
    targetRevision: before.revision,
    name,
    mode: "multipart",
  });
  expect(firstParts).toBe(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  expect(matches).toEqual(Array(3).fill(`"b-${before.currentBlobId}"`));
  const after = await rootFile(page, name);
  expect(after).toMatchObject({ id: before.id, name, revision: before.revision + 1, size });
  expect(await fileContent(page, after, `bytes=0-${value.length - 1}`)).toBe(value);
});

test("body-less DAV mutations and content ticket cancellation work over real HTTP", async ({
  page,
  request,
}) => {
  await page.goto("/files");
  const issued = await page.evaluate(async () => {
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/app-passwords", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        name: "DAV transport",
        scopes: ["node:read", "node:create", "node:write", "node:delete"],
      }),
    });
    return { status: response.status, credential: await response.json() };
  });
  expect(issued.status).toBe(201);
  const send = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    data?: string,
  ) =>
    request.fetch(`https://127.0.0.1:8879${path}`, {
      method,
      headers: {
        host: "app.ncf.test:8879",
        "X-Test-Without-Auth": "1",
        Authorization: `Basic ${Buffer.from(`${issued.credential.id}:${issued.credential.secret}`).toString("base64")}`,
        ...headers,
      },
      ...(data === undefined ? {} : { data }),
    });
  const folder = "/dav/dav-transport";
  const file = `${folder}/source.txt`;
  const copy = `${folder}/copy.txt`;
  const moved = `${folder}/moved.txt`;
  const key = { "Idempotency-Key": "browser-empty-mkcol" };
  expect((await send("MKCOL", folder, key, " ")).status()).toBe(415);
  expect((await send("MKCOL", folder, key)).status()).toBe(201);
  const payload = "DAV transport fixture\n";
  expect((await send("PUT", file, { "Content-Type": "text/plain" }, payload)).status()).toBe(201);
  const locked = await send(
    "LOCK",
    file,
    { "Content-Type": "application/xml", Depth: "0", Timeout: "Second-60" },
    '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
  );
  expect(locked.status()).toBe(200);
  const token = locked.headers()["lock-token"]!;
  expect(token).toMatch(/^<opaquelocktoken:/);
  expect((await send("UNLOCK", file, { "Lock-Token": token }, "{}")).status()).toBe(400);
  expect((await send("UNLOCK", file, { "Lock-Token": token })).status()).toBe(204);
  const copyHeaders = {
    Destination: `https://app.ncf.test:8879${copy}`,
    Overwrite: "F",
    Depth: "0",
  };
  expect((await send("COPY", file, copyHeaders, "{}")).status()).toBe(400);
  expect((await send("COPY", file, copyHeaders)).status()).toBe(201);
  const moveHeaders = {
    Destination: `https://app.ncf.test:8879${moved}`,
    Overwrite: "F",
    Depth: "infinity",
  };
  expect((await send("MOVE", copy, moveHeaders, "{}")).status()).toBe(400);
  expect((await send("MOVE", copy, moveHeaders)).status()).toBe(201);
  expect(await (await send("GET", moved)).text()).toBe(payload);

  const ticket = await page.evaluate(async () => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const children = async (id: string) => {
      const response = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}/children`);
      if (!response.ok) throw new Error(`children_http_${response.status}`);
      return (await response.json()).children as { id: string; name: string }[];
    };
    const root = await children(me.rootNodeId);
    const folder = root.find((node) => node.name === "dav-transport")!;
    const source = (await children(folder.id)).find((node) => node.name === "source.txt")!;
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf.token };
    const created = await fetch("/api/v1/content-session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        targets: [{ spaceId: me.spaceId, nodeId: source.id }],
        purpose: "content",
        ttlSeconds: 300,
      }),
    });
    const issued = await created.json();
    const exchange = async () =>
      (
        await fetch(`${me.contentOrigin}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ticket: issued.ticket }),
        })
      ).status;
    const before = await exchange();
    const url = `/api/v1/tickets/${issued.ticketId}`;
    const rejected = await fetch(url, { method: "DELETE", headers, body: "{}" });
    const afterRejected = await exchange();
    const cancelled = await fetch(url, { method: "DELETE", headers });
    return {
      issued: created.status,
      before,
      rejected: rejected.status,
      afterRejected,
      cancelled: cancelled.status,
      afterCancelled: await exchange(),
    };
  });
  expect(ticket).toEqual({
    issued: 201,
    before: 201,
    rejected: 400,
    afterRejected: 201,
    cancelled: 204,
    afterCancelled: 400,
  });
  expect((await send("DELETE", moved, {}, "{}")).status()).toBe(400);
  expect(await (await send("GET", moved)).text()).toBe(payload);
  expect((await send("DELETE", moved)).status()).toBe(204);
  expect((await send("GET", moved)).status()).toBe(404);
  expect((await send("DELETE", folder)).status()).toBe(204);
});

test("concurrent DAV requests share KDF capacity and a revoked app password stops working", async ({
  page,
  request,
}) => {
  await page.goto("/files");
  const issued = await page.evaluate(async () => {
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/app-passwords", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({ name: "Browser DAV", scopes: ["node:read"] }),
    });
    return { status: response.status, credential: await response.json() };
  });
  expect(issued.status).toBe(201);
  const dav = (secret: string) =>
    request.fetch("https://127.0.0.1:8879/dav", {
      method: "OPTIONS",
      headers: {
        host: "app.ncf.test:8879",
        "X-Test-Without-Auth": "1",
        Authorization: `Basic ${Buffer.from(`${issued.credential.id}:${secret}`).toString("base64")}`,
      },
    });
  // These are separate real Worker fetch events, not concurrent calls in a single test context.
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => dav(issued.credential.secret)),
  );
  for (const response of responses) {
    expect(response.status()).toBe(200);
    expect(response.headers().dav).toBe("1");
    expect(response.headers()["cache-control"]).toBe("private, no-store");
  }
  const wrong = await dav(Buffer.alloc(32).toString("base64url"));
  expect(wrong.status()).toBe(401);
  expect(wrong.headers()["www-authenticate"]).toContain("Basic");
  const revoked = await page.evaluate(async (credentialId) => {
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    return (
      await fetch(`/api/v1/app-passwords/${encodeURIComponent(credentialId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      })
    ).status;
  }, issued.credential.credentialId);
  expect(revoked).toBe(204);
  expect((await dav(issued.credential.secret)).status()).toBe(401);
});

test("search finds nested names and preserves their destination for overwrite and navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/files");
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = `カタカナ++😀資料-${suffix}.txt`;
  const file = await writeTestFile(page, name, "before search overwrite");
  const scope = await page.evaluate(
    async ({ file, suffix }) => {
      const json = async (path: string, init?: RequestInit) => {
        const response = await fetch(path, init);
        if (!response.ok) throw new Error(`seed_${response.status}_${path}`);
        return response.json();
      };
      const me = await json("/api/v1/me");
      const csrf = await json("/api/v1/csrf", { method: "POST" });
      const mutation = (path: string, body: unknown) =>
        json(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf.token,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });
      const outer = await mutation("/api/v1/nodes", {
        spaceId: me.spaceId,
        parentId: me.rootNodeId,
        kind: "folder",
        name: `検索範囲-${suffix}`,
      });
      const inner = await mutation("/api/v1/nodes", {
        spaceId: me.spaceId,
        parentId: outer.result.nodeId,
        kind: "folder",
        name: "奥のフォルダー",
      });
      await mutation(`/api/v1/nodes/${file.id}/move`, {
        spaceId: me.spaceId,
        destinationParentId: inner.result.nodeId,
        name: file.name,
      });
      return { outer: outer.result.nodeId as string, inner: inner.result.nodeId as string };
    },
    { file, suffix },
  );
  await page.reload();
  await expect(page.getByRole("button", { name: `${name}の操作`, exact: true })).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "このフォルダー内を検索" })
    .fill(`ｶﾀｶﾅ++😀資料-${suffix}`);
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByRole("button", { name: `${name}の操作`, exact: true })).toBeVisible();
  await expect(page.getByText(/サブフォルダーも含む/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("search-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("search-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openOverwrite(page, name);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("dialog").getByRole("button", { name: "ファイルを選択" }).click();
  await (await chooser).setFiles({
    name: "置換元.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("search overwrite stayed in its folder"),
  });
  await page.getByRole("dialog").getByRole("button", { name: "上書きを開始", exact: true }).click();
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const current = await page.evaluate(
    async ({ scope, name }) => {
      const response = await fetch(
        `/api/v1/search?scopeId=${scope.outer}&q=${encodeURIComponent(name)}`,
      );
      if (!response.ok) throw new Error(`search_${response.status}`);
      return (await response.json()).items[0];
    },
    { scope, name },
  );
  expect(current.parentId).toBe(scope.inner);
  expect(await fileContent(page, current)).toBe("search overwrite stayed in its folder");
  await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "保存場所を開く", exact: true }).click();
  await expect(page.getByRole("heading", { name: "奥のフォルダー", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "検索を終了", exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "このフォルダー内を検索" }).fill("++😀");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByRole("button", { name: `${name}の操作`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "名前を変更", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(`更新済み-${suffix}.txt`);
  await page.getByRole("dialog").getByRole("button", { name: "名前を変更", exact: true }).click();
  await expect(page.getByRole("heading", { name: "一致する項目がありません" })).toBeVisible();
  await page.getByRole("button", { name: "検索を終了", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `更新済み-${suffix}.txtの操作`, exact: true }),
  ).toBeVisible();
});

test("search pages real API results and hides stale rows after a tree change or denied refresh", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/files");
  const scope = await page.evaluate(async () => {
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(path, init);
      if (!response.ok) throw new Error(`seed_${response.status}_${path}`);
      return response.json();
    };
    const me = await json("/api/v1/me");
    const csrf = await json("/api/v1/csrf", { method: "POST" });
    const create = (parentId: string, name: string) =>
      json("/api/v1/nodes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf.token,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ spaceId: me.spaceId, parentId, name, kind: "folder" }),
      });
    const root = await create(me.rootNodeId, `ページ検索-${crypto.randomUUID().slice(0, 8)}`);
    for (let i = 0; i < 201; i++)
      await create(root.result.nodeId, `Match ${String(i).padStart(3, "0")}`);
    return root.result.nodeId as string;
  });
  await page.goto(`/files/${scope}`);
  await page.getByRole("searchbox", { name: "このフォルダー内を検索" }).fill("match");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.locator(".list-summary strong")).toHaveText("200");
  await page.getByRole("button", { name: "さらに読み込む" }).click();
  await expect(page.locator(".list-summary strong")).toHaveText("201");
  await expect(page.getByRole("button", { name: "さらに読み込む" })).toHaveCount(0);
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.locator(".list-summary strong")).toHaveText("200");
  await page.evaluate(async (scope) => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/nodes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        spaceId: me.spaceId,
        parentId: scope,
        name: "Match newer",
        kind: "folder",
      }),
    });
    if (!response.ok) throw new Error(`mutate_${response.status}`);
  }, scope);
  await page.getByRole("button", { name: "さらに読み込む" }).click();
  await expect(page.getByRole("alert")).toContainText("検索中に項目が更新されました");
  await expect(page.getByRole("button", { name: "Match 000の操作", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "一覧を読み直す" }).click();
  await expect(page.getByRole("button", { name: "Match 000の操作", exact: true })).toBeVisible();
  await page.route("**/api/v1/search?*", (route) =>
    route.continue({ headers: { ...route.request().headers(), "X-Test-Without-Auth": "1" } }),
  );
  await page.getByRole("button", { name: "一覧を更新", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Match 000の操作", exact: true })).toHaveCount(0);
});

test("logout clears saved uploads and pending operations in all open tabs", async ({
  page,
  context,
}) => {
  await page.goto("/files");
  await expect(page.getByRole("button", { name: "新規フォルダー", exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/files");
  await expect(other.getByRole("button", { name: "新規フォルダー", exact: true })).toBeVisible();
  for (const tab of [page, other])
    await tab.evaluate(() =>
      sessionStorage.setItem(
        "ncf-pending-operation",
        JSON.stringify({ sensitive: "saved mutation" }),
      ),
    );
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("ncf-uploads", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("uploads", "readwrite");
      tx.objectStore("uploads").put({ localId: "logout-fixture", capability: "test-only" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await page.getByRole("button", { name: "アカウントメニュー" }).click();
  await page.getByRole("menuitem", { name: "ログアウト", exact: true }).click();
  for (const tab of [page, other]) {
    await expect(tab).toHaveURL(/\/cdn-cgi\/access\/logout$/);
    expect(await tab.evaluate(() => sessionStorage.getItem("ncf-pending-operation"))).toBeNull();
  }
  const count = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("ncf-uploads", 1);
      r.onsuccess = () => resolve(r.result);
    });
    const result = await new Promise<number>((resolve) => {
      const r = database.transaction("uploads", "readonly").objectStore("uploads").count();
      r.onsuccess = () => resolve(r.result);
    });
    database.close();
    return result;
  });
  expect(count).toBe(0);
});
