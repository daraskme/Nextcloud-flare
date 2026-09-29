import { expect, type Page, test } from "@playwright/test";
import { decoded, uploadBook } from "./archiveHelpers";
import { login } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function folder(page: Page, parentId?: string) {
  return page.evaluate(async (parentId) => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const name = `本棚-${crypto.randomUUID().slice(0, 8)}`;
    const response = await fetch("/api/v1/nodes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        kind: "folder",
        spaceId: me.spaceId,
        parentId: parentId ?? me.rootNodeId,
        name,
      }),
    });
    if (!response.ok) throw new Error(`folder_${response.status}`);
    return { id: (await response.json()).result.nodeId as string, name };
  }, parentId);
}
async function share(page: Page, nodeId: string, internal = false) {
  return page.evaluate(
    async ({ nodeId, internal }) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const response = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          kind: internal ? "internal" : "link",
          rootNodeId: nodeId,
          role: "read",
          ...(internal ? { recipients: ["recipient@example.invalid"] } : {}),
        }),
      });
      if (!response.ok) throw new Error(`share_${response.status}`);
      return response.json();
    },
    { nodeId, internal },
  );
}
test("a copied book opens immediately and starts with its own reading position", async ({
  page,
}, info) => {
  await login(page);
  const book = await uploadBook(page),
    me = await page.evaluate(() => fetch("/api/v1/me").then((r) => r.json())),
    copyName = `コピー-${book.name}`;
  await page.goto(`/library/${me.rootNodeId}`);
  await page.getByRole("button", { name: `${book.name}を読む`, exact: true }).click();
  await decoded(page, 1);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await decoded(page, 2);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/files");
  await page.getByRole("button", { name: `${book.name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "コピー", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名前", { exact: true }).fill(copyName);
  await dialog.getByRole("button", { name: "コピー先を選択", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${copyName}の操作`, exact: true })).toBeVisible();
  await page.goto(`/library/${me.rootNodeId}`);
  await page.getByRole("button", { name: `${copyName}を読む`, exact: true }).click();
  await decoded(page, 1);
  await page.screenshot({ path: info.outputPath("copied-book-reader.png") });
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: `${book.name}を読む`, exact: true }).click();
  await decoded(page, 2);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: `${copyName}を読む`, exact: true }).click();
  await decoded(page, 1);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
});
test("registered bookshelves survive reload, open the saved reading position, and can be removed", async ({
  page,
}, info) => {
  await login(page);
  const shelf = await folder(page),
    book = await uploadBook(page, shelf.id);
  await page.goto(`/library/${shelf.id}`);
  await page.getByRole("button", { name: "このフォルダーを本棚に登録", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "このフォルダーの登録を解除", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "登録した本棚" })
      .getByRole("link", { name: shelf.name, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "このフォルダーの登録を解除", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: `${book.name}を読む`, exact: true }).click();
  await decoded(page, 1);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await decoded(page, 2);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "本棚", exact: true })).toContainText(
    "2ページまで読書",
  );
  await page.screenshot({ path: info.outputPath("bookshelf-desktop.png") });
  await page.getByRole("button", { name: `${book.name}を読む`, exact: true }).click();
  await decoded(page, 2);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await page.getByRole("button", { name: "このフォルダーの登録を解除", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "登録した本棚" })
      .getByRole("link", { name: shelf.name, exact: true }),
  ).toHaveCount(0);
});
test("public bookshelves navigate nested folders on mobile and respect revocation", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const shelf = await folder(page),
    child = await folder(page, shelf.id),
    book = await uploadBook(page, child.id),
    link = await share(page, shelf.id);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
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
    const guest = await context.newPage();
    await openPublic(guest, `https://app.ncf.test:8879/s/${link.id}#${link.secret}`, shelf.name);
    await guest.getByRole("button", { name: "本棚で表示", exact: true }).click();
    await guest.getByRole("button", { name: `${child.name}の本棚を開く`, exact: true }).click();
    await expect(
      guest.getByRole("button", { name: `${book.name}を読む`, exact: true }),
    ).toBeVisible();
    await guest.screenshot({ path: info.outputPath("bookshelf-public-mobile.png") });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.getByRole("button", { name: `${book.name}を読む`, exact: true }).click();
    await decoded(guest, 1);
    await guest.getByRole("button", { name: "書籍を閉じる" }).click();
    const status = await page.evaluate(async (id) => {
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
    }, link.id);
    expect(status).toBe(200);
    await guest.getByRole("button", { name: "本棚を更新", exact: true }).click();
    await expect(
      guest.getByRole("region", { name: "本棚", exact: true }).getByRole("alert"),
    ).toBeVisible();
    await expect(
      guest.getByRole("button", { name: `${book.name}を読む`, exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
test("an internal read-share recipient opens the shelf without owner registration controls", async ({
  page,
  browser,
}) => {
  await login(page);
  const shelf = await folder(page),
    child = await folder(page, shelf.id),
    book = await uploadBook(page, child.id),
    link = await share(page, shelf.id, true);
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
  });
  try {
    await context.addCookies([
      {
        name: "ncf-test-user",
        value: "recipient",
        domain: ".ncf.test",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
    const viewer = await context.newPage();
    await viewer.goto(`/shared/${link.id}`);
    await viewer.getByRole("button", { name: "本棚で表示", exact: true }).click();
    await viewer.getByRole("button", { name: `${child.name}の本棚を開く`, exact: true }).click();
    await expect(viewer.getByRole("region", { name: "登録した本棚" })).toHaveCount(0);
    await viewer.getByRole("button", { name: `${book.name}を読む`, exact: true }).click();
    await decoded(viewer, 1);
    await viewer.getByRole("button", { name: "書籍を閉じる" }).click();
    await expect(viewer.getByRole("region", { name: "本棚", exact: true })).toContainText(
      "1ページまで読書",
    );
  } finally {
    await context.close();
  }
});
test("an empty candidate window can continue and go back without retaining the next page's items", async ({
  page,
}) => {
  await login(page);
  const shelf = await folder(page),
    book = await uploadBook(page, shelf.id);
  const data = await page.evaluate(async (scopeRoot) => {
    const response = await fetch(`/api/v1/library/items?scopeRoot=${scopeRoot}`);
    if (!response.ok) throw new Error(`shelf_${response.status}`);
    return response.json();
  }, shelf.id);
  await page.route(`**/api/v1/library/items?scopeRoot=${shelf.id}*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      await route.fulfill({ json: data });
      return;
    }
    await route.fulfill({ json: { ...data, items: [], nextCursor: "test-window" } });
  });
  await page.goto(`/library/${shelf.id}`);
  await expect(page.getByRole("region", { name: "本棚", exact: true })).toContainText(
    "この範囲には書籍がありません",
  );
  await page.getByRole("button", { name: "次の一覧", exact: true }).click();
  await expect(page.getByRole("button", { name: `${book.name}を読む`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "前の一覧", exact: true }).click();
  await expect(page.getByRole("button", { name: `${book.name}を読む`, exact: true })).toHaveCount(
    0,
  );
});
