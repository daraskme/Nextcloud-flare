import { open } from "node:fs/promises";
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";
import { fileContent } from "./uploadHelpers";

async function setup(owner: Page, label: string, role: "read" | "edit" = "read") {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  await expect(owner.getByRole("button", { name: "新規フォルダー", exact: true })).toBeVisible();
  return owner.evaluate(
    async ({ label, role }) => {
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
    { label, role },
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
    await recipient.getByRole("button", { name: new RegExp(data.filename) }).click();
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
    await expect(recipient.getByRole("button", { name: new RegExp(data.filename) })).toBeVisible();
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
    await recipient.getByRole("button", { name: "結果を確認", exact: true }).click();
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
    await expect(
      page.getByRole("button", { name: "共有で移動したメモ.txtの操作", exact: true }),
    ).toBeVisible();
    await recipient.goto(`/shared/${data.share.id}`);
    await expect(recipient.getByText("共有で移動したメモ.txt", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
