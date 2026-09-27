import { expect, type Page, test } from "@playwright/test";

async function setup(owner: Page, label: string) {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  await expect(owner.getByRole("button", { name: "新規フォルダー", exact: true })).toBeVisible();
  return owner.evaluate(async (label) => {
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
      (await post("/api/v1/nodes", { kind: "folder", spaceId: me.spaceId, parentId, name })).result
        .nodeId as string;
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
      role: "read",
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
  }, label);
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
