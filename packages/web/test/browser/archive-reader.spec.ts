import { expect, type Page, test } from "@playwright/test";
import { decoded, uploadBook } from "./archiveHelpers";
import { searchFiles } from "./fileHelpers";
import { login } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(240000);
async function openPrivate(page: Page, name: string) {
  await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "ファイルを開く・保存", exact: true }).click();
}
async function savedPosition(page: Page, nodeId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/library/${id}`);
    if (!response.ok) throw new Error(`book_${response.status}`);
    return (await response.json()).reading as { page: number; updatedAt: number } | null;
  }, nodeId);
}
async function saveElsewhere(page: Page, nodeId: string, nextPage: number) {
  return page.evaluate(
    async ({ id, next }) => {
      const book = await fetch(`/api/v1/library/${id}`).then((r) => r.json());
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const response = await fetch(`/api/v1/library/${id}/reading-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          blobId: book.blobId,
          generator: book.generator,
          indexHash: book.indexHash,
          page: next,
          previousUpdatedAt: book.reading?.updatedAt ?? null,
        }),
      });
      if (!response.ok) throw new Error(`save_${response.status}`);
      return response.json();
    },
    { id: nodeId, next: nextPage },
  );
}
test("Files reads natural PNG/AVIF pages, rejects a disguised script, and closes the reader", async ({
  page,
}, info) => {
  await login(page);
  const book = await uploadBook(page);
  await page.goto("/files");
  await searchFiles(page, book.name);
  await openPrivate(page, book.name);
  await decoded(page, 1);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await decoded(page, 2);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await savedPosition(page, book.nodeId))?.page).toBe(2);
  await openPrivate(page, book.name);
  await decoded(page, 2);
  await page.screenshot({ path: info.outputPath("private-reader.png") });
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "このページを表示できません",
  );
  expect(await page.evaluate(() => "archiveScript" in window)).toBe(false);
  expect((await savedPosition(page, book.nodeId))?.page).toBe(2);
  await page.getByRole("spinbutton", { name: "ページ番号" }).fill("1");
  await decoded(page, 1);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await savedPosition(page, book.nodeId))?.page).toBe(1);
});

test("a public read link displays the same reader on mobile and loses access after revocation", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const book = await uploadBook(page);
  const share = await page.evaluate(async (nodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId: nodeId, role: "read" }),
    });
    if (!response.ok) throw new Error(`share_${response.status}`);
    return response.json();
  }, book.nodeId);
  await saveElsewhere(page, book.nodeId, 2);
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
    const positionWrites: string[] = [];
    guest.on("request", (r) => {
      if (r.url().includes("/reading-state")) positionWrites.push(r.method());
    });
    await openPublic(guest, `https://app.ncf.test:8879/s/${share.id}#${share.secret}`, book.name);
    await guest.getByRole("button", { name: `${book.name}を読む` }).click();
    await decoded(guest, 1);
    await guest.getByRole("button", { name: "次のページ", exact: true }).click();
    await decoded(guest, 2);
    await guest.screenshot({ path: info.outputPath("public-reader-mobile.png") });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.getByRole("button", { name: "書籍を閉じる" }).click();
    await expect(guest.getByRole("dialog")).toHaveCount(0);
    expect(positionWrites).toEqual([]);
    expect((await savedPosition(page, book.nodeId))?.page).toBe(2);
    await guest.getByRole("button", { name: `${book.name}を読む` }).click();
    await decoded(guest, 1);
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
    }, share.id);
    expect(status).toBe(200);
    await guest.getByRole("button", { name: "再読み込み", exact: true }).click();
    await expect(guest.getByRole("dialog").getByRole("alert")).toBeVisible();
    await expect(guest.getByRole("dialog").locator("img")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("an internal read-share recipient opens a book within the selected share", async ({
  page,
  browser,
}) => {
  await login(page);
  const book = await uploadBook(page);
  const share = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const r = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({
        kind: "internal",
        rootNodeId,
        role: "read",
        recipients: ["recipient@example.invalid"],
      }),
    });
    if (!r.ok) throw new Error(`share_${r.status}`);
    return r.json();
  }, book.nodeId);
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
    await viewer.goto(`/shared/${share.id}`);
    await viewer.locator("button.shared-entry").filter({ hasText: book.name }).click();
    await decoded(viewer, 1);
    await viewer.getByRole("button", { name: "次のページ", exact: true }).click();
    await decoded(viewer, 2);
    await viewer.getByRole("button", { name: "書籍を閉じる" }).click();
    await expect(viewer.getByRole("dialog")).toHaveCount(0);
    await viewer.locator("button.shared-entry").filter({ hasText: book.name }).click();
    await decoded(viewer, 2);
    expect(await savedPosition(page, book.nodeId)).toBeNull();
  } finally {
    await context.close();
  }
});

test("a stale reader preserves the newer position and reports failed saves without removing its page", async ({
  page,
}, info) => {
  await login(page);
  const book = await uploadBook(page);
  await page.goto("/files");
  await searchFiles(page, book.name);
  await openPrivate(page, book.name);
  await decoded(page, 1);
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("読書位置を保存しました", {
    timeout: 15000,
  });
  await saveElsewhere(page, book.nodeId, 2);
  const conflict = page.waitForResponse(
    (r) => r.url().endsWith("/reading-state") && r.status() === 409,
  );
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await decoded(page, 2);
  await conflict;
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "別の画面で読書位置が更新されました",
  );
  await decoded(page, 2);
  expect((await savedPosition(page, book.nodeId))?.page).toBe(2);
  await page.screenshot({ path: info.outputPath("reading-conflict.png") });
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await decoded(page, 2);
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("読書位置を保存しました");
  await page.route("**/reading-state", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: '{"code":"not_ready"}',
    }),
  );
  await page.getByRole("button", { name: "前のページ", exact: true }).click();
  await decoded(page, 1);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "読書位置を保存できませんでした",
  );
  await decoded(page, 1);
  expect((await savedPosition(page, book.nodeId))?.page).toBe(2);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
