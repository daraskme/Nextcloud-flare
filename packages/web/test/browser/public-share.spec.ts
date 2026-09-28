import { type Browser, expect, type Page, test } from "@playwright/test";
import { searchFiles } from "./fileHelpers";

test.setTimeout(180000);
async function anonymousContext(browser: Browser, mobile = false) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(mobile ? { viewport: { width: 390, height: 844 } } : {}),
  });
  // Test identity must not add a custom header to content-host CORS requests.
  await context.addCookies([
    {
      name: "ncf-test-user",
      value: "anonymous",
      domain: ".ncf.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}
async function ownerLink(page: Page, fileOnly = false) {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  const name = `公開共有-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await searchFiles(page, name);
  await page.getByRole("button", { name: `${name} フォルダー`, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooser).setFiles({
    name: "共有メモ.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Public share download\n"),
  });
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("資料");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return page.evaluate(
    async ({ name, fileOnly }) => {
      const me = await fetch("/api/v1/me").then((r) => r.json());
      const children = await fetch(`/api/v1/nodes/${me.rootNodeId}/children`).then((r) => r.json());
      const folder = children.children.find((node: { name: string }) => node.name === name);
      const contents = await fetch(`/api/v1/nodes/${folder.id}/children`).then((r) => r.json());
      const file = contents.children.find((node: { name: string }) => node.name === "共有メモ.txt");
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const response = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          kind: "link",
          rootNodeId: fileOnly ? file.id : folder.id,
          role: "read",
          ...(fileOnly ? { password: "共有🔑" } : {}),
        }),
      });
      if (response.status !== 201) throw new Error(`link_create_${response.status}`);
      const saved: { id: string; secret: string } = await response.json();
      return { ...saved, root: fileOnly ? file.id : folder.id, name, outside: me.rootNodeId };
    },
    { name, fileOnly },
  );
}
async function openShared(page: Page, password = "") {
  const ready = page.getByRole("button", { name: "共有メモ.txtを開く・保存", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = page.getByRole("button", { name: /共有を開く|秒後に再試行できます/ });
    await expect(ready.or(open)).toBeVisible({ timeout: 60000 });
    if (await ready.isVisible()) return;
    if (password) await page.getByLabel("共有パスワード", { exact: true }).fill(password);
    await expect(open).toBeEnabled({ timeout: 70000 });
    await open.click();
  }
  await expect(ready).toBeVisible();
}
async function saveFile(page: Page) {
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "共有メモ.txtを開く・保存", exact: true }).click();
  const popup = await opened,
    download = await popup.waitForEvent("download");
  expect(download.suggestedFilename()).toBe("共有メモ.txt");
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const part of stream!) chunks.push(Buffer.from(part));
  expect(Buffer.concat(chunks).toString()).toBe("Public share download\n");
  await popup.close();
}
test("public build opens in two anonymous tabs, keeps its capability out of URLs and saves with a shared budget", async ({
  page,
  browser,
}) => {
  const link = await ownerLink(page);
  const context = await anonymousContext(browser, true);
  try {
    const one = await context.newPage(),
      two = await context.newPage();
    const requests: { url: string; referer: string }[] = [],
      errors: string[] = [];
    context.on("request", (request) =>
      requests.push({ url: request.url(), referer: request.headers().referer ?? "" }),
    );
    one.on("pageerror", (error) => errors.push(error.message));
    one.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) errors.push(message.text());
    });
    const url = `https://app.ncf.test:8879/s/${link.id}#${link.secret}`;
    await Promise.all([one.goto(url), two.goto(url)]);
    await Promise.all([openShared(one), openShared(two)]);
    expect(new URL(one.url()).hash).toBe("");
    expect(new URL(two.url()).hash).toBe("");
    expect(
      requests.some(
        (request) => request.url.includes(link.secret) || request.referer.includes(link.secret),
      ),
    ).toBe(false);
    expect(requests.some((request) => request.url.includes("private-assets"))).toBe(false);
    expect(
      await one.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
      })),
    ).toEqual({ local: 0, session: 0, width: 390, viewport: 390 });
    expect(await one.evaluate(async () => (await fetch("/api/v1/me")).status)).toBe(401);
    expect(
      await one.evaluate(
        async ({ id, outside }) =>
          (await fetch(`/api/v1/public/shares/${id}/children/${outside}`)).status,
        link,
      ),
    ).toBe(404);
    expect(
      await one.evaluate(
        async (id) =>
          (await fetch(`/__test__/share-session-count/${id}`).then((r) => r.json())).count,
        link.id,
      ),
    ).toBe(1);
    await one.screenshot({ path: "/tmp/ncf-public-share-mobile.png", fullPage: true });
    await one.getByRole("button", { name: "資料", exact: true }).click();
    await expect(one.getByText("このフォルダーは空です。", { exact: true })).toBeVisible();
    await one
      .getByRole("navigation", { name: "共有フォルダーの階層" })
      .getByRole("button", { name: link.name, exact: true })
      .click();
    await openShared(one);
    await saveFile(one);
    await saveFile(two);
    await two.reload();
    await openShared(two);
    await one.getByRole("button", { name: "共有を閉じる", exact: true }).click();
    await expect(
      two.getByText("共有を閉じました。もう一度開くには、共有リンクからアクセスしてください。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(two.getByText("共有メモ.txt", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("anonymous app delivery counts HEAD, Range and 304 and cannot outlive its ticket", async ({
  page,
  browser,
}) => {
  const link = await ownerLink(page, true);
  const context = await anonymousContext(browser);
  try {
    const guest = await context.newPage();
    await guest.goto(`https://app.ncf.test:8879/s/${link.id}#${link.secret}`);
    await openShared(guest, "共有🔑");
    const result = await guest.evaluate(async (id) => {
      const base = `/api/v1/public/shares/${id}`;
      const root = await fetch(base).then((r) => r.json());
      const { token } = await fetch(`${base}/csrf`, { method: "POST" }).then((r) => r.json());
      const created = await fetch(`${base}/content-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
          "Share-Session": root.sessionId,
        },
        body: JSON.stringify({ nodeIds: [root.root.id], ttlSeconds: 300, delivery: "app" }),
      });
      if (created.status !== 201) throw new Error(`public_delivery_${created.status}`);
      const saved = await created.json();
      const headers = { "Share-Session": root.sessionId, "Content-Session": saved.sessionId };
      const url = `${base}/content/${root.root.id}`;
      const head = await fetch(url, { method: "HEAD", headers });
      const partial = await fetch(url, { headers: { ...headers, Range: "bytes=0-5" } });
      const text = await partial.text();
      const unchanged = await fetch(url, {
        headers: { ...headers, "If-None-Match": head.headers.get("ETag")! },
      });
      const wrong = await fetch(url, { headers: { ...headers, "Share-Session": "another" } });
      const cancelled = await fetch(`${base}/tickets/${saved.ticketId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      });
      const after = await fetch(url, { method: "HEAD", headers });
      return {
        head: head.status,
        headBody: await head.text(),
        length: head.headers.get("Content-Length"),
        partial: partial.status,
        range: partial.headers.get("Content-Range"),
        text,
        unchanged: unchanged.status,
        wrong: wrong.status,
        cancelled: cancelled.status,
        after: after.status,
        noTicket: !("ticket" in saved),
        noCookie: created.headers.get("Set-Cookie") === null,
        privacy: [head, partial, unchanged, wrong, after].every(
          (r) =>
            r.headers.get("Cache-Control") === "private, no-store" &&
            r.headers.get("Referrer-Policy") === "no-referrer",
        ),
      };
    }, link.id);
    expect(result).toEqual({
      head: 200,
      headBody: "",
      length: "22",
      partial: 206,
      range: "bytes 0-5/22",
      text: "Public",
      unchanged: 304,
      wrong: 412,
      cancelled: 204,
      after: 404,
      noTicket: true,
      noCookie: true,
      privacy: true,
    });
  } finally {
    await context.close();
  }
});
test("password file link survives reload and owner revocation clears the public view", async ({
  page,
  browser,
}) => {
  const link = await ownerLink(page, true);
  const context = await anonymousContext(browser);
  try {
    const guest = await context.newPage();
    await guest.goto(`https://app.ncf.test:8879/s/${link.id}#${link.secret}`);
    await openShared(guest, "共有🔑");
    await expect(guest.getByRole("heading", { name: "共有メモ.txt", exact: true })).toBeVisible();
    await guest.reload();
    await openShared(guest);
    await saveFile(guest);
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
      }, link.id),
    ).toBe(200);
    await guest.getByRole("button", { name: "更新", exact: true }).click();
    await expect(guest.getByRole("alert")).toBeVisible();
    await expect(guest.getByText("共有メモ.txt", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
