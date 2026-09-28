import { type Browser, expect, type Page, type Route, test } from "@playwright/test";

test.setTimeout(180000);
test.beforeEach(async ({ page }) => {
  expect(
    (
      await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
        headers: { Host: "app.ncf.test:8879" },
      })
    ).status(),
  ).toBe(200);
});
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));
async function openLinks(page: Page, name: string) {
  await page.goto("/files");
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: `${name}の操作` }).click();
  await page.getByRole("menuitem", { name: "公開リンクを管理", exact: true }).click();
  await expect(page.getByText("公開リンクはありません。", { exact: true })).toBeVisible();
}
async function guestContext(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
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
async function openPublic(page: Page, url: string, name: string, password = "") {
  await page.goto(url);
  const heading = page.getByRole("heading", { name, exact: true });
  for (let i = 0; i < 3; i++) {
    const open = page.getByRole("button", { name: /共有を開く|秒後に再試行できます/ });
    await expect(heading.or(open)).toBeVisible({ timeout: 60000 });
    if (await heading.isVisible()) return;
    await page.getByLabel("共有パスワード", { exact: true }).fill(password);
    await expect(open).toBeEnabled({ timeout: 70000 });
    await open.click();
  }
  await expect(heading).toBeVisible();
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
test("owner creates and copies a public link, preserves/removes password, rotates and stops it on mobile", async ({
  page,
  browser,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://app.ncf.test:8879",
  });
  const name = `リンク管理-${crypto.randomUUID().slice(0, 6)}`;
  await openLinks(page, name);
  const dialog = page.getByRole("dialog"),
    row = dialog.locator(".share-row");
  await page.getByLabel("有効期限（任意）", { exact: true }).fill("2099-01-01T12:00");
  await page.getByLabel("パスワード（任意）", { exact: true }).fill(" 共有🔑 ");
  await page.getByRole("button", { name: "閲覧リンクを作成", exact: true }).click();
  await expect(page.getByLabel("共有URL", { exact: true })).toBeVisible();
  const original = await page.getByLabel("共有URL", { exact: true }).inputValue();
  expect(original).toMatch(/^https:\/\/app\.ncf\.test:8879\/s\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "URLをコピー", exact: true }).click();
  await expect(page.getByText("共有URLをコピーしました。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(new URL(original).hash.slice(1));
  await expect(row).toContainText("パスワードあり");
  await expect(row).toContainText("2099");
  await page.screenshot({ path: "/tmp/ncf-owner-link-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const guest = await guestContext(browser);
  try {
    const visitor = await guest.newPage();
    await openPublic(visitor, original, name, " 共有🔑 ");
    await row.getByRole("button", { name: "設定を変更", exact: true }).click();
    await page.getByLabel("有効期限（任意）", { exact: true }).fill("2100-01-01T12:00");
    await page.getByRole("button", { name: "リンク設定を保存", exact: true }).click();
    await expect(row).toContainText("2100");
    await expect(row).toContainText("パスワードあり");
    await expect(page.getByLabel("共有URL", { exact: true })).toHaveCount(0);
    await openPublic(visitor, original, name, " 共有🔑 ");
    await row.getByRole("button", { name: "設定を変更", exact: true }).click();
    await page.getByLabel("パスワード設定", { exact: true }).selectOption("set");
    await page.getByLabel("新しいパスワード", { exact: true }).fill("更新🔑");
    await page.getByRole("button", { name: "リンク設定を保存", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText(
      "リンク設定を更新しました。利用中の閲覧セッションは終了します。URLは変わりません。",
    );
    await expect(row).toContainText("パスワードあり");
    await openPublic(visitor, original, name, "更新🔑");
    await row.getByRole("button", { name: "設定を変更", exact: true }).click();
    await page.getByLabel("パスワード設定", { exact: true }).selectOption("remove");
    await page.getByRole("button", { name: "リンク設定を保存", exact: true }).click();
    await expect(row).toContainText("パスワードなし");
    await row.getByRole("button", { name: "リンクを再発行", exact: true }).click();
    await expect(
      page.getByText(
        "以前のURLと利用中の閲覧セッションは使えなくなります。新しいURLを共有相手へ渡してください。",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "再発行する", exact: true }).click();
    await expect(page.getByLabel("共有URL", { exact: true })).toBeVisible();
    const rotated = await page.getByLabel("共有URL", { exact: true }).inputValue();
    expect(rotated).not.toBe(original);
    expect(new URL(rotated).pathname).toBe(new URL(original).pathname);
    await visitor.goto(original);
    await expect(visitor.getByRole("button", { name: "共有を開く", exact: true })).toBeVisible();
    await expect(visitor.getByRole("heading", { name, exact: true })).toHaveCount(0);
    expect(new URL(visitor.url()).hash).toBe("");
    await openPublic(visitor, rotated, name);
    expect(new URL(visitor.url()).hash).toBe("");
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: `${name}の操作` }).click();
    await page.getByRole("menuitem", { name: "公開リンクを管理", exact: true }).click();
    await expect(row).toHaveCount(1);
    await expect(page.getByLabel("共有URL", { exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "リンクを停止", exact: true }).click();
    await page.getByRole("button", { name: "停止する", exact: true }).click();
    await expect(row).toHaveCount(0);
    await visitor.getByRole("button", { name: "更新", exact: true }).click();
    await expect(visitor.getByRole("heading", { name, exact: true })).toHaveCount(0);
  } finally {
    await guest.close();
  }
});
test("lost create and rotation replies require list review without replay or secret persistence", async ({
  page,
}) => {
  await openLinks(page, `応答喪失-${crypto.randomUUID().slice(0, 6)}`);
  let posts = 0,
    patches = 0;
  await page.route("**/api/v1/shares", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    expect((await localFetch(route)).status()).toBe(201);
    await route.abort("connectionfailed");
  });
  await page.getByRole("button", { name: "閲覧リンクを作成", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("結果を確認できませんでした");
  await expect(page.getByRole("button", { name: "閲覧リンクを作成", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "リンク一覧を更新", exact: true }).click();
  await expect(page.locator(".share-row")).toHaveCount(1);
  expect(posts).toBe(1);
  await expect(page.getByLabel("共有URL", { exact: true })).toHaveCount(0);
  await page.route("**/api/v1/shares/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    expect((await localFetch(route)).status()).toBe(200);
    await route.abort("connectionfailed");
  });
  await page.getByRole("button", { name: "リンクを再発行", exact: true }).click();
  await page.getByRole("button", { name: "再発行する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("結果を確認できませんでした");
  await expect(page.getByRole("button", { name: "リンクを再発行", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "リンク一覧を更新", exact: true }).click();
  expect(patches).toBe(1);
  expect(posts).toBe(1);
  await page.unroute("**/api/v1/shares/*");
  await page.getByRole("button", { name: "リンクを再発行", exact: true }).click();
  await page.getByRole("button", { name: "再発行する", exact: true }).click();
  await expect(page.getByLabel("共有URL", { exact: true })).toBeVisible();
  await expect(page.locator(".share-row")).toHaveCount(1);
});
test("stale owner settings cannot overwrite a concurrent public-link change", async ({ page }) => {
  const name = `同時変更-${crypto.randomUUID().slice(0, 6)}`;
  await openLinks(page, name);
  await page.getByRole("button", { name: "閲覧リンクを作成", exact: true }).click();
  await expect(page.locator(".share-row")).toHaveCount(1);
  await page.getByRole("button", { name: "設定を変更", exact: true }).click();
  expect(
    await page.evaluate(async (name) => {
      const { items } = await fetch("/api/v1/shares?kind=link").then((r) => r.json());
      const share = items.find((s: { name: string }) => s.name === name);
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      return (
        await fetch(`/api/v1/shares/${share.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "If-Match": `"share-${share.version}"`,
          },
          body: JSON.stringify({
            kind: "link",
            rootNodeId: share.rootNodeId,
            role: "read",
            password: "changed",
          }),
        })
      ).status;
    }, name),
  ).toBe(200);
  await page.getByRole("button", { name: "リンク設定を保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("リンクが別の操作で変更されています");
  await page.getByRole("button", { name: "リンク一覧を更新", exact: true }).click();
  await expect(page.locator(".share-row")).toContainText("パスワードあり");
  await expect(page.getByRole("button", { name: "リンク設定を保存", exact: true })).toHaveCount(0);
});
