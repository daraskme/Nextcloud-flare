import { open } from "node:fs/promises";
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";
import { searchFiles } from "./fileHelpers";
import { fileContent, writeTestFile } from "./uploadHelpers";

async function setup(
  owner: Page,
  label: string,
  role: "read" | "edit" = "read",
  secondFile = false,
) {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  await expect(owner.getByRole("button", { name: "新規フォルダー", exact: true })).toBeVisible();
  return owner.evaluate(
    async ({ label, role, secondFile }) => {
      const json = async (path: string, init?: RequestInit) => {
        const response = await fetch(path, init);
        if (!response.ok) throw new Error(`setup_${response.status}_${path}`);
        return response.json();
      };
      const me = await json("/api/v1/me"),
        { token } = await json("/api/v1/csrf", { method: "POST" });
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": token };
      const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
        json(path, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": crypto.randomUUID(), ...extra },
          body: JSON.stringify(body),
        });
      const folder = async (parentId: string, name: string) =>
        (await post("/api/v1/nodes", { kind: "folder", spaceId: me.spaceId, parentId, name }))
          .result.nodeId as string;
      const hidden = await folder(me.rootNodeId, `非共有の親-${label}`);
      const root = await folder(hidden, `受信フォルダー-${label}`);
      const child = await folder(root, `子フォルダー-${label}`);
      const text = `Shared content ${label}\n`,
        filename = `共有メモ-${label}.txt`;
      const upload = await post("/api/v1/uploads", {
        mode: "single",
        spaceId: me.spaceId,
        parentId: child,
        name: filename,
        declared_size: new TextEncoder().encode(text).length,
      });
      await json(`/api/v1/uploads/${upload.id}/content`, {
        method: "PUT",
        headers: { "Upload-Capability": upload.capability },
        body: text,
      });
      await post(
        `/api/v1/uploads/${upload.id}/complete`,
        {},
        { "Upload-Capability": upload.capability },
      );
      if (secondFile) {
        const extra = await post("/api/v1/uploads", {
          mode: "single",
          spaceId: me.spaceId,
          parentId: child,
          name: `追加-${label}.txt`,
          declared_size: 4,
        });
        await json(`/api/v1/uploads/${extra.id}/content`, {
          method: "PUT",
          headers: { "Upload-Capability": extra.capability },
          body: "more",
        });
        await post(
          `/api/v1/uploads/${extra.id}/complete`,
          {},
          { "Upload-Capability": extra.capability },
        );
      }
      const { children } = await json(`/api/v1/nodes/${child}/children`);
      const file = children.find((n: { name: string }) => n.name === filename);
      if (!file) throw new Error("shared_file_missing");
      const input = {
        kind: "internal",
        recipients: ["recipient@example.invalid"],
        role,
        expiresAt: null,
      };
      const share = await post("/api/v1/shares", { ...input, rootNodeId: root });
      const fileShare = await post("/api/v1/shares", { ...input, rootNodeId: file.id });
      return {
        share,
        fileShare,
        hidden,
        root,
        child,
        file,
        filename,
        text,
        spaceId: me.spaceId,
        contentOrigin: me.contentOrigin,
      };
    },
    { label, role, secondFile },
  );
}

async function recipientContext(browser: Browser) {
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
  });
  await context.addCookies([
    {
      name: "ncf-test-user",
      value: "recipient",
      url: "https://app.ncf.test:8879",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
  });
  return context;
}
async function localFetch(route: Route) {
  return route.fetch({
    url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
    headers: {
      ...(await route.request().allHeaders()),
      host: "app.ncf.test:8879",
      "sec-fetch-site": "same-origin",
    },
  });
}
async function stop(owner: Page, id: string, version: number) {
  return owner.evaluate(
    async ({ id, version }) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      return (
        await fetch(`/api/v1/shares/${id}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "If-Match": `"share-${version}"`,
          },
        })
      ).status;
    },
    { id, version },
  );
}

test("recipient browses within the shared root, downloads through the selected share and loses access after revocation", async ({
  page,
  browser,
}, info) => {
  const data = await setup(page, "閲覧と停止");
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    await context.addCookies([
      {
        name: "ncf-test-user",
        value: "recipient",
        url: "https://app.ncf.test:8879",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
    const recipient = await context.newPage();
    const tickets: {
      share: { id: string; version: number };
      targets: { spaceId: string; nodeId: string }[];
    }[] = [];
    recipient.on("request", (request) => {
      if (request.url().endsWith("/api/v1/content-session")) tickets.push(request.postDataJSON());
    });
    await recipient.goto("/shared");
    await expect(
      recipient.getByRole("heading", { name: "共有された項目", exact: true }),
    ).toBeVisible();
    await recipient.getByRole("link", { name: /受信フォルダー-閲覧と停止/ }).click();
    await expect(
      recipient.getByRole("heading", { name: "受信フォルダー-閲覧と停止", exact: true }),
    ).toBeVisible();
    await expect(recipient.getByText("非共有の親-閲覧と停止", { exact: true })).toHaveCount(0);
    await expect(
      recipient.getByRole("button", { name: "新規フォルダー", exact: true }),
    ).toHaveCount(0);
    await recipient.getByRole("link", { name: /子フォルダー-閲覧と停止/ }).click();
    await recipient.reload();
    await expect(
      recipient.getByRole("heading", { name: "子フォルダー-閲覧と停止", exact: true }),
    ).toBeVisible();
    await expect(recipient.getByText("非共有の親-閲覧と停止", { exact: true })).toHaveCount(0);
    await recipient.screenshot({ path: info.outputPath("shared-mobile.png") });
    const popupPromise = recipient.waitForEvent("popup");
    await recipient
      .getByRole("button", { name: new RegExp(data.filename) })
      .filter({ hasText: "開く・保存" })
      .click();
    const popup = await popupPromise,
      download = await popup.waitForEvent("download");
    const stream = await download.createReadStream(),
      chunks: Buffer[] = [];
    for await (const part of stream!) chunks.push(Buffer.from(part));
    expect(Buffer.concat(chunks).toString()).toBe(data.text);
    expect(tickets).toEqual([
      {
        share: data.share,
        targets: [{ spaceId: data.spaceId, nodeId: data.file.id }],
        purpose: "content",
        ttlSeconds: 300,
      },
    ]);
    await popup.close();
    expect(await stop(page, data.share.id, 1)).toBe(200);
    const status = await recipient.evaluate(
      async (url) => (await fetch(url, { credentials: "include" })).status,
      `${data.contentOrigin}/c/${data.file.id}/${data.file.currentBlobId}`,
    );
    expect([401, 403, 404]).toContain(status);
    await recipient.getByRole("button", { name: "共有を更新", exact: true }).click();
    await expect(recipient.getByRole("alert")).toContainText("アクセスできません");
    await expect(recipient.getByRole("button", { name: new RegExp(data.filename) })).toHaveCount(0);
    await recipient.getByRole("link", { name: "共有された項目へ戻る", exact: true }).click();
    await expect(recipient.getByRole("link", { name: /受信フォルダー-閲覧と停止/ })).toHaveCount(0);
    await expect(recipient.getByRole("link", { name: new RegExp(data.filename) })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a directly shared file exposes no parent path and a recipient cannot manage its grant", async ({
  page,
  browser,
}) => {
  const data = await setup(page, "単一ファイル");
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
  });
  try {
    await context.addCookies([
      {
        name: "ncf-test-user",
        value: "recipient",
        url: "https://app.ncf.test:8879",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
    const recipient = await context.newPage();
    await recipient.goto(`/shared/${data.fileShare.id}`);
    await expect(
      recipient
        .getByRole("button", { name: new RegExp(data.filename) })
        .filter({ hasText: "開く・保存" }),
    ).toBeVisible();
    const crumbs = recipient.getByLabel("パンくず");
    await expect(crumbs).toContainText(data.filename);
    await expect(crumbs).not.toContainText("受信フォルダー");
    await expect(crumbs).not.toContainText("子フォルダー");
    await expect(crumbs).not.toContainText("非共有の親");
    const result = await recipient.evaluate(
      async ({ share, root }) => {
        const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
        const denied = await fetch(`/api/v1/shares/${share.id}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "If-Match": `"share-${share.version}"`,
          },
        });
        const escaped = await fetch(
          `/api/v1/nodes/${root}/path?shareId=${share.id}&shareVersion=${share.version}`,
        );
        return [denied.status, escaped.status];
      },
      { share: data.fileShare, root: data.root },
    );
    expect(result).toEqual([404, 404]);
    await recipient.goto(`/shared/${data.fileShare.id}/${data.root}`);
    await expect(recipient.getByRole("alert")).toContainText("アクセスできません");
    await expect(recipient.getByText("非共有の親-単一ファイル", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("recipient creates and renames with selected scope, including recovery after a lost response and reload", async ({
  page,
  browser,
}, info) => {
  const data = await setup(page, "編集と再送", "edit"),
    context = await recipientContext(browser);
  try {
    const recipient = await context.newPage();
    const requests: { body: Record<string, unknown>; key: string }[] = [];
    let lose = true;
    await recipient.route("**/api/v1/nodes", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"]!,
      });
      if (lose) {
        lose = false;
        expect((await localFetch(route)).status()).toBe(201);
        await route.abort("connectionfailed");
      } else await route.continue();
    });
    await recipient.goto(`/shared/${data.share.id}`);
    await recipient.getByRole("button", { name: "新規フォルダー", exact: true }).click();
    const dialog = recipient.getByRole("dialog", { name: "新しいフォルダー", exact: true });
    await dialog.getByLabel("名前", { exact: true }).fill("受信者が作成");
    await dialog.getByRole("button", { name: "新しいフォルダー", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await recipient.reload();
    // Reload already lists the committed folder. Its presence does not prove
    // that the replay has finished (the replay first needs a fresh CSRF token).
    const replay = recipient.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/nodes" &&
        response.request().method() === "POST" &&
        response.request().headers()["idempotency-key"] === requests[0]!.key,
    );
    await recipient.getByRole("button", { name: "結果を確認", exact: true }).click();
    expect((await replay).status()).toBe(201);
    await expect(recipient.getByRole("button", { name: "結果を確認", exact: true })).toBeHidden();
    await expect(recipient.getByRole("link", { name: /受信者が作成/ })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]!.body).toMatchObject({
      spaceId: data.spaceId,
      parentId: data.root,
      share: data.share,
    });
    await recipient.getByRole("button", { name: "受信者が作成の名前を変更", exact: true }).click();
    await recipient
      .getByRole("dialog")
      .getByLabel("名前", { exact: true })
      .fill("共有で改名したフォルダー");
    await recipient
      .getByRole("dialog")
      .getByRole("button", { name: "名前を変更", exact: true })
      .click();
    await expect(recipient.getByRole("link", { name: /共有で改名したフォルダー/ })).toBeVisible();
    await recipient.setViewportSize({ width: 390, height: 844 });
    await recipient.screenshot({ path: info.outputPath("shared-edit-mobile.png"), fullPage: true });
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const children = await page.evaluate(
      async (id) => (await fetch(`/api/v1/nodes/${id}/children`).then((r) => r.json())).children,
      data.root,
    );
    expect(
      children.filter((n: { name: string }) => n.name === "共有で改名したフォルダー"),
    ).toHaveLength(1);
    expect(await stop(page, data.share.id, data.share.version)).toBe(200);
    await recipient.getByRole("button", { name: "新規フォルダー", exact: true }).click();
    await recipient
      .getByRole("dialog")
      .getByLabel("名前", { exact: true })
      .fill("停止後の書き込み");
    await recipient
      .getByRole("dialog")
      .getByRole("button", { name: "新しいフォルダー", exact: true })
      .click();
    await expect(recipient.getByRole("dialog").getByRole("alert")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("shared multipart resumes the same upload after reload and charges its owner", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(150_000);
  const data = await setup(page, "分割再開", "edit"),
    context = await recipientContext(browser);
  try {
    const recipient = await context.newPage(),
      filePath = info.outputPath("共有の大きなファイル.bin");
    const file = await open(filePath, "w");
    await file.write(Buffer.from("shared multipart fixture"));
    await file.truncate(96 * 1024 * 1024 + 37);
    await file.close();
    const creates: Record<string, unknown>[] = [],
      attempts: string[] = [];
    let firstParts = 0;
    recipient.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
        creates.push(request.postDataJSON());
      if (request.url().endsWith("/parts/1")) firstParts++;
    });
    await recipient.route("**/api/v1/uploads/*/parts/2", async (route) => {
      attempts.push(route.request().headers()["upload-attempt-id"]!);
      if (attempts.length === 1) await route.abort("connectionfailed");
      else await route.continue();
    });
    await recipient.goto(`/shared/${data.share.id}`);
    const before = await recipient.evaluate(() => fetch("/api/v1/me").then((r) => r.json()));
    await recipient
      .getByLabel("共有先にアップロードするファイル", { exact: true })
      .setInputFiles(filePath);
    await expect(recipient.getByRole("button", { name: "元のファイルを選択・再確認" })).toBeVisible(
      { timeout: 90_000 },
    );
    await recipient.reload();
    const chooser = recipient.waitForEvent("filechooser");
    await recipient.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
    await (await chooser).setFiles(filePath);
    await expect(recipient.getByText("アップロード完了", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      mode: "multipart",
      spaceId: data.spaceId,
      parentId: data.root,
      share: data.share,
    });
    expect(firstParts).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    const after = await recipient.evaluate(() => fetch("/api/v1/me").then((r) => r.json()));
    expect(after.usedBytes).toBe(before.usedBytes);
    expect(after.reservedBytes).toBe(before.reservedBytes);
    const owner = await page.evaluate(() => fetch("/api/v1/me").then((r) => r.json()));
    expect(owner.usedBytes).toBeGreaterThanOrEqual(96 * 1024 * 1024 + 37);
    await expect(
      recipient.getByRole("button", { name: "共有の大きなファイル.binを上書き", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("directly shared file overwrite keeps its parent private and recovers a lost completion", async ({
  page,
  browser,
}, info) => {
  const data = await setup(page, "単体上書き", "edit"),
    context = await recipientContext(browser);
  try {
    const recipient = await context.newPage(),
      filePath = info.outputPath("置換する原稿.txt");
    const value = "shared replacement\n",
      file = await open(filePath, "w");
    await file.write(value);
    await file.close();
    const creates: Record<string, unknown>[] = [];
    let completions = 0;
    recipient.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/uploads")
        creates.push(request.postDataJSON());
    });
    await recipient.route("**/api/v1/uploads/*/complete", async (route) => {
      if (++completions === 1) {
        expect((await localFetch(route)).status()).toBe(200);
        await route.abort("connectionfailed");
      } else await route.continue();
    });
    await recipient.goto(`/shared/${data.fileShare.id}`);
    await expect(
      recipient.getByRole("button", { name: `${data.filename}の名前を変更`, exact: true }),
    ).toHaveCount(0);
    await recipient.getByRole("button", { name: `${data.filename}を上書き`, exact: true }).click();
    await recipient.getByLabel("上書きするファイル", { exact: true }).setInputFiles(filePath);
    await recipient.getByRole("button", { name: "上書きを開始", exact: true }).click();
    await expect(
      recipient.getByRole("button", { name: "元のファイルを選択・再確認" }),
    ).toBeVisible();
    await recipient.reload();
    const chooser = recipient.waitForEvent("filechooser");
    await recipient.getByRole("button", { name: "元のファイルを選択・再確認" }).click();
    await (await chooser).setFiles(filePath);
    await expect(recipient.getByText("アップロード完了", { exact: true })).toBeVisible();
    expect(completions).toBe(1);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      share: data.fileShare,
      spaceId: data.spaceId,
      targetId: data.file.id,
      targetRevision: data.file.revision,
    });
    expect(creates[0]).not.toHaveProperty("parentId");
    const after = await page.evaluate(
      (id) => fetch(`/api/v1/nodes/${id}`).then((r) => r.json()),
      data.file.id,
    );
    expect(after.revision).toBe(data.file.revision + 1);
    expect(await fileContent(page, after)).toBe(value);
    await expect(recipient.getByLabel("パンくず")).not.toContainText("子フォルダー");
  } finally {
    await context.close();
  }
});

test("recipient copies and moves within its share, recovers a lost trash response, and the owner restores it", async ({
  page,
  browser,
}, info) => {
  const data = await setup(page, "共有内整理", "edit"),
    context = await recipientContext(browser);
  try {
    const recipient = await context.newPage();
    await recipient.setViewportSize({ width: 390, height: 844 });
    await recipient.goto(`/shared/${data.share.id}`);
    await recipient.getByLabel("子フォルダー-共有内整理のその他の操作", { exact: true }).click();
    await recipient.getByRole("button", { name: "コピー", exact: true }).click();
    const copyDialog = recipient.getByRole("dialog", { name: "コピー先を選択", exact: true });
    await expect(copyDialog).toContainText("受信フォルダー-共有内整理");
    await expect(copyDialog).not.toContainText("非共有の親");
    await expect(copyDialog.getByRole("button", { name: "上の階層" })).toHaveCount(0);
    await copyDialog.getByLabel("名前", { exact: true }).fill("共有でコピーしたフォルダー");
    await copyDialog.getByRole("button", { name: "コピー先を選択", exact: true }).click();
    await expect(copyDialog).toHaveCount(0);
    await recipient.getByRole("link", { name: /共有でコピーしたフォルダー/ }).click();
    await recipient.getByLabel(`${data.filename}のその他の操作`, { exact: true }).click();
    await recipient.getByRole("button", { name: "移動", exact: true }).click();
    const moveDialog = recipient.getByRole("dialog", { name: "移動先を選択", exact: true });
    await expect(moveDialog).toContainText("受信フォルダー-共有内整理");
    await moveDialog.getByLabel("名前", { exact: true }).fill("共有で移動したメモ.txt");
    await moveDialog.getByRole("button", { name: "移動先を選択", exact: true }).click();
    await expect(moveDialog).toHaveCount(0);
    await recipient.goto(`/shared/${data.share.id}`);
    await expect(
      recipient.getByRole("button", { name: /共有で移動したメモ.txt.*開く/ }),
    ).toBeVisible();
    const trashRequests: { body: unknown; key: string }[] = [];
    let lose = true;
    await recipient.route("**/api/v1/nodes/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      trashRequests.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"]!,
      });
      if (lose) {
        lose = false;
        const response = await localFetch(route);
        expect(response.status()).toBe(200);
        return route.abort("failed");
      }
      return route.continue();
    });
    await recipient.getByLabel("共有で移動したメモ.txtのその他の操作", { exact: true }).click();
    await recipient.screenshot({
      path: info.outputPath("shared-organize-mobile.png"),
      fullPage: true,
    });
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await recipient.getByRole("button", { name: "ごみ箱に移動", exact: true }).click();
    const trashDialog = recipient.getByRole("dialog", { name: "ごみ箱に移動", exact: true });
    await expect(trashDialog).toContainText("復元は所有者が行えます");
    await trashDialog.getByRole("button", { name: "ごみ箱に移動", exact: true }).click();
    await expect(trashDialog.getByRole("alert")).toBeVisible();
    await recipient.reload();
    await recipient.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(recipient.getByRole("button", { name: "結果を確認", exact: true })).toHaveCount(0);
    expect(trashRequests).toHaveLength(2);
    expect(trashRequests[1]).toEqual(trashRequests[0]);
    expect(trashRequests[0]!.body).toEqual({ spaceId: data.spaceId, share: data.share });
    await expect(recipient.getByText("共有で移動したメモ.txt", { exact: true })).toHaveCount(0);
    await page.goto("/trash");
    const row = page.getByRole("article").filter({ hasText: "共有で移動したメモ.txt" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "復元", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "復元先を選択", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/files");
    await searchFiles(page, "共有で移動したメモ.txt");
    await expect(
      page.getByRole("button", { name: "共有で移動したメモ.txtの操作", exact: true }),
    ).toBeVisible();
    await recipient.goto(`/shared/${data.share.id}`);
    await expect(recipient.getByText("共有で移動したメモ.txt", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

async function deliverCopy(page: Page, id: string, steps?: number) {
  const response = await page.request.post(
    `https://127.0.0.1:8879/__test__/copy/${id}${steps ? `?steps=${steps}` : ""}`,
    { headers: { Host: "app.ncf.test:8879" } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

test("cross-owner copy from a read-only shared root survives lost acceptance, storage failure and reload", async ({
  page: owner,
  browser,
}, info) => {
  const f = await setup(owner, "コピー受付", "read", true);
  const context = await recipientContext(browser),
    page = await context.newPage();
  try {
    await page.goto(`/shared/${f.share.id}`);
    const received: { key: string; jobId: string; body: Record<string, unknown> }[] = [];
    await page.route(`**/api/v1/nodes/${f.root}/copy`, async (route) => {
      const response = await localFetch(route);
      expect(response.status()).toBe(202);
      received.push({
        key: route.request().headers()["idempotency-key"]!,
        jobId: (await response.json()).result.jobId,
        body: route.request().postDataJSON(),
      });
      if (received.length === 1) await route.abort("connectionfailed");
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "このフォルダーをコピー" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("保存するドライブ")).toHaveValue("mine");
    await expect(dialog.getByLabel("保存するドライブ")).toHaveAttribute("aria-busy", "false");
    await expect(
      dialog
        .getByLabel("保存するドライブ")
        .locator(`option[value="${f.share.id}:${f.share.version}"]`),
    ).toHaveCount(0);
    await dialog.getByLabel("名前", { exact: true }).fill("自分のドライブへのコピー");
    await dialog.getByRole("button", { name: "コピー先を選択", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "同じ操作の結果を確認" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    // A receipt must not erase the pending intent if saving its job reference fails.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "ncf-copy-jobs") {
          Storage.prototype.setItem = original;
          throw new DOMException("test storage full", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await page.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect.poll(() => received.length).toBe(2);
    await expect(page.getByRole("button", { name: "結果を確認", exact: true })).toBeEnabled();
    expect(
      await page.evaluate(() => sessionStorage.getItem("ncf-pending-operation")),
    ).not.toBeNull();
    await page.getByRole("button", { name: "結果を確認", exact: true }).click();
    const panel = page.getByRole("region", { name: "コピー状況" });
    await expect(panel.getByText("コピーの開始を待っています", { exact: true })).toBeVisible();
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.jobId)).size).toBe(1);
    expect(new Set(received.map((r) => r.key)).size).toBe(1);
    const me = await page.evaluate(() => fetch("/api/v1/me").then((r) => r.json()));
    expect(received[0]!.body).toMatchObject({
      spaceId: f.spaceId,
      share: { id: f.share.id, version: f.share.version },
      destination: { spaceId: me.spaceId, share: null },
      destinationParentId: me.rootNodeId,
    });
    expect(await page.evaluate(() => sessionStorage.getItem("ncf-pending-operation"))).toBeNull();
    const jobId = received[0]!.jobId;
    expect(await deliverCopy(page, jobId, 1)).toMatchObject({ state: "yielded", steps: 1 });
    await panel.getByRole("button", { name: "進捗を更新" }).click();
    await expect(panel.getByText("コピー中", { exact: true })).toBeVisible();
    const status = await page.evaluate(
      (id) => fetch(`/api/v1/jobs/${id}`).then((r) => r.json()),
      jobId,
    );
    expect(status.completedBlobs).toBe(1);
    expect(status.completedBytes).toBeGreaterThan(0);
    expect(status.completedBytes).toBeLessThan(status.totalBytes);
    await expect(panel.getByRole("progressbar")).toHaveAttribute(
      "value",
      String(status.completedBytes),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("copy-progress-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.reload();
    await expect(panel.getByText("コピー中", { exact: true })).toBeVisible();
    expect(received).toHaveLength(3);
    expect(await deliverCopy(page, jobId)).toBe("completed");
    await panel.getByRole("button", { name: "進捗を更新" }).click();
    await expect(panel.getByText("コピー完了", { exact: true })).toBeVisible();
    await panel.getByRole("link", { name: "保存先を開く" }).click();
    await expect(
      page.getByRole("button", { name: "自分のドライブへのコピー フォルダー", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "自分のドライブへのコピー フォルダー", exact: true })
      .click();
    await page
      .getByRole("button", { name: "子フォルダー-コピー受付 フォルダー", exact: true })
      .click();
    const copied = await page.evaluate(async () => {
      const parent = location.pathname.split("/").at(-1);
      return (await fetch(`/api/v1/nodes/${parent}/children`).then((r) => r.json())).children;
    });
    expect(copied).toHaveLength(2);
    expect(
      await fileContent(
        page,
        copied.find((n: { name: string }) => n.name === f.filename),
      ),
    ).toBe(f.text);
    expect(received).toHaveLength(3);
  } finally {
    await context.close();
  }
});

test("copy into an edit share cancels and retries once across lost replies and reload", async ({
  page: owner,
  browser,
}, info) => {
  const f = await setup(owner, "保存先コピー", "edit");
  const context = await recipientContext(browser),
    page = await context.newPage();
  try {
    await page.goto("/files");
    const name = "共有へコピーする原稿.txt";
    const source = await writeTestFile(page, name, "destination selection");
    await page.reload();
    const bodies: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === `/api/v1/nodes/${source.id}/copy`)
        bodies.push(r.postDataJSON());
    });
    await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "コピー", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog
        .getByLabel("保存するドライブ")
        .locator(`option[value="${f.share.id}:${f.share.version}"]`),
    ).toHaveCount(1);
    await dialog.getByLabel("保存するドライブ").selectOption(`${f.share.id}:${f.share.version}`);
    await expect(dialog.getByText("受信フォルダー-保存先コピー", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("copy-destination-desktop.png") });
    await dialog.getByRole("button", { name: "コピー先を選択", exact: true }).click();
    const panel = page.getByRole("region", { name: "コピー状況" });
    await expect(panel.getByText("コピーの開始を待っています", { exact: true })).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      destination: { spaceId: f.spaceId, share: { id: f.share.id, version: f.share.version } },
      destinationParentId: f.root,
    });
    expect(bodies[0]).not.toHaveProperty("share");
    const jobId = (await panel.locator("article").getAttribute("data-job-id"))!;
    await page.route(`**/api/v1/jobs/${jobId}/cancel`, async (route) => {
      expect((await localFetch(route)).status()).toBe(200);
      await route.abort("connectionfailed");
    });
    await panel.getByRole("button", { name: "コピーを取り消す" }).click();
    await expect(panel.getByText("コピーを取り消しました", { exact: true })).toBeVisible();
    await expect(panel.getByText(/容量の精算を待っています/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "コピーを再試行", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(panel.getByText("コピーを取り消しました", { exact: true })).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(await deliverCopy(page, jobId)).toBe("failed");
    await panel.getByRole("button", { name: "進捗を更新" }).click();
    await expect(panel.getByText(/容量の精算を待っています/)).toHaveCount(0);
    expect(bodies).toHaveLength(1);
    const retries: string[] = [];
    let successor = "",
      blockRead = true;
    await page.route(`**/api/v1/jobs/${jobId}`, (route) =>
      blockRead ? route.abort("connectionfailed") : route.continue(),
    );
    await page.route(`**/api/v1/jobs/${jobId}/retry`, async (route) => {
      retries.push(route.request().headers()["idempotency-key"]!);
      expect(route.request().postDataJSON()).toEqual({});
      const response = await localFetch(route);
      expect(response.status()).toBe(202);
      successor = (await response.json()).result.jobId;
      await route.abort("connectionfailed");
    });
    await panel.getByRole("button", { name: "コピーを再試行", exact: true }).click();
    await expect.poll(() => successor).toMatch(/^copy_[a-f0-9]{64}$/);
    expect(successor).not.toBe(jobId);
    expect(
      await page.evaluate(
        (id) =>
          JSON.parse(sessionStorage.getItem("ncf-copy-jobs")!).find(
            (r: { id: string }) => r.id === id,
          ).retryKey,
        jobId,
      ),
    ).toBe(retries[0]);
    // Reload can discover the accepted job even if saving its receipt is still
    // denied. Restoring storage and refreshing unchanged status must retry save.
    await page.addInitScript((originalId) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          key === "ncf-copy-jobs" &&
          JSON.parse(value).some((r: { id: string }) => r.id !== originalId)
        )
          throw new Error("tracking_storage_denied");
        return set.call(this, key, value);
      };
      (window as unknown as { restoreCopyStorage: () => void }).restoreCopyStorage = () => {
        Storage.prototype.setItem = set;
      };
    }, jobId);
    blockRead = false;
    await page.reload();
    const child = panel.locator(`article[data-job-id="${successor}"]`);
    await expect(panel.getByRole("alert")).toContainText("コピー状況を保存できません");
    await expect(child).toHaveCount(0);
    await page.evaluate(() =>
      (window as unknown as { restoreCopyStorage: () => void }).restoreCopyStorage(),
    );
    await panel.getByRole("button", { name: "進捗を更新" }).click();
    await expect(child.getByText("コピーの開始を待っています", { exact: true })).toBeVisible();
    await expect(panel.getByText(/再試行を受け付けました/)).toBeVisible();
    expect(retries).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("copy-retry-recovery.png"), fullPage: true });
    expect(await deliverCopy(page, successor)).toBe("completed");
    await child.getByRole("button", { name: "進捗を更新" }).click();
    await expect(child.getByText("コピー完了", { exact: true })).toBeVisible();
    await child.getByRole("link", { name: "保存先を開く" }).click();
    await expect(
      page.getByRole("button").filter({ hasText: name }).filter({ hasText: "開く・保存" }),
    ).toBeVisible();
    expect(retries).toHaveLength(1);
  } finally {
    await context.close();
  }
});

for (const loss of ["share", "login"] as const) {
  test(`copy tracking after ${loss} changes never enqueues a replacement`, async ({
    page: owner,
    browser,
  }) => {
    const f = await setup(owner, `コピー失効-${loss}`);
    const context = await recipientContext(browser),
      page = await context.newPage();
    try {
      await page.goto(`/shared/${f.fileShare.id}`);
      let copies = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/copy")) copies++;
      });
      await page.getByRole("button", { name: `${f.filename}をコピー`, exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "コピー先を選択", exact: true })
        .click();
      const panel = page.getByRole("region", { name: "コピー状況" });
      await expect(panel.getByText("コピーの開始を待っています", { exact: true })).toBeVisible();
      if (loss === "share")
        expect(await stop(owner, f.fileShare.id, f.fileShare.version)).toBe(200);
      else
        expect(
          (
            await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
              headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
            })
          ).status(),
        ).toBe(200);
      await page.reload();
      await expect(panel.getByRole("alert")).toContainText("アクセスできません");
      await expect(panel.getByRole("button", { name: "コピーを取り消す" })).toHaveCount(0);
      await expect(panel.getByRole("link", { name: "保存先を開く" })).toHaveCount(0);
      expect(copies).toBe(1);
      await panel.getByRole("button", { name: "表示を閉じる" }).click();
      await expect(panel).toHaveCount(0);
      expect(copies).toBe(1);
    } finally {
      await context.close();
    }
  });
}
