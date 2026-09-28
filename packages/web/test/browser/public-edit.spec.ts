import { type Browser, expect, type Page, type Route, test } from "@playwright/test";

test.setTimeout(180000);
async function setup(owner: Page, browser: Browser) {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  const name = `公開編集-${crypto.randomUUID().slice(0, 8)}`;
  await owner.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await owner.getByLabel("名前", { exact: true }).fill(name);
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await owner.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  await owner.getByRole("menuitem", { name: "公開リンクを管理", exact: true }).click();
  await expect(owner.getByRole("button", { name: "閲覧リンクを作成", exact: true })).toBeEnabled();
  await owner.getByLabel("共有権限", { exact: true }).selectOption("edit");
  await owner.getByRole("button", { name: "編集リンクを作成", exact: true }).click();
  await expect(owner.getByLabel("共有URL", { exact: true })).toBeVisible();
  const url = await owner.getByLabel("共有URL", { exact: true }).inputValue();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
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
  await open(guest, url, name);
  return { context, guest, url, name };
}
async function open(page: Page, url: string, name: string) {
  await page.goto(url);
  const heading = page.getByRole("heading", { name, exact: true });
  for (let i = 0; i < 3; i++) {
    const unlock = page.getByRole("button", { name: /共有を開く|秒後に再試行できます/ });
    await expect(heading.or(unlock)).toBeVisible({ timeout: 60000 });
    if (await heading.isVisible()) return;
    await expect(unlock).toBeEnabled({ timeout: 70000 });
    await unlock.click();
  }
  await expect(heading).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.getByRole("button", { name: "フォルダーを作成", exact: true }).click();
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
test("owner grants edit, guest creates and renames on mobile, and downgrade invalidates the editor", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await create(t.guest, "共同作業");
    await expect(t.guest.getByRole("button", { name: "共同作業", exact: true })).toBeVisible();
    await t.guest.getByRole("button", { name: "共同作業の名前を変更", exact: true }).click();
    await t.guest.getByLabel("名前", { exact: true }).fill("更新した資料");
    await t.guest.getByRole("button", { name: "名前を保存", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "更新した資料", exact: true })).toBeVisible();
    await t.guest.getByRole("button", { name: "更新した資料", exact: true }).click();
    await create(t.guest, "下の階層");
    await expect(t.guest.getByRole("button", { name: "下の階層", exact: true })).toBeVisible();
    expect(
      await t.guest.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      })),
    ).toEqual({ local: 0, session: 0, overflow: false });
    await t.guest.getByRole("button", { name: "新規フォルダー", exact: true }).click();
    await t.guest.getByLabel("名前", { exact: true }).fill("古い権限からの変更");
    await t.guest.screenshot({ path: "/tmp/ncf-public-edit-mobile.png", fullPage: true });
    const row = page.getByRole("dialog").locator(".share-row");
    await row.getByRole("button", { name: "設定を変更", exact: true }).click();
    expect(await page.getByLabel("共有権限", { exact: true }).inputValue()).toBe("edit");
    await page.getByLabel("共有権限", { exact: true }).selectOption("read");
    await page.getByRole("button", { name: "リンク設定を保存", exact: true }).click();
    await expect(row).toContainText("閲覧");
    await t.guest.getByRole("button", { name: "フォルダーを作成", exact: true }).click();
    await expect(t.guest.getByRole("alert")).toContainText("共有の状態が変わった");
    await expect(t.guest.getByText("下の階層", { exact: true })).toHaveCount(0);
    await open(t.guest, t.url, t.name);
    await expect(t.guest.getByRole("button", { name: "新規フォルダー", exact: true })).toHaveCount(
      0,
    );
    await expect(t.guest.getByRole("button", { name: /の名前を変更$/ })).toHaveCount(0);
    await t.guest.getByRole("button", { name: "更新した資料", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "下の階層", exact: true })).toBeVisible();
    await expect(
      t.guest.getByRole("button", { name: "古い権限からの変更", exact: true }),
    ).toHaveCount(0);
  } finally {
    await t.context.close();
  }
});
test("lost public mutation reply waits for explicit same-key retry and does not duplicate creation", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    const keys: string[] = [],
      bodies: string[] = [];
    await t.guest.route("**/api/v1/public/shares/*/nodes", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      bodies.push(route.request().postData()!);
      const result = await localFetch(route);
      expect(result.status()).toBe(201);
      if (keys.length === 1) await route.abort("failed");
      else await route.fulfill({ response: result });
    });
    await create(t.guest, "一度だけ作成");
    const check = t.guest.getByRole("button", { name: "結果を確認", exact: true });
    await expect(check).toBeVisible();
    expect(keys).toHaveLength(1);
    await expect(t.guest.getByLabel("名前", { exact: true })).toBeDisabled();
    await expect(
      t.guest.getByRole("button", { name: "新規フォルダー", exact: true }),
    ).toBeDisabled();
    await check.click();
    await expect(t.guest.getByRole("button", { name: "一度だけ作成", exact: true })).toHaveCount(1);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    await t.guest.reload();
    await expect(t.guest.getByRole("button", { name: "一度だけ作成", exact: true })).toHaveCount(1);
  } finally {
    await t.context.close();
  }
});
test("an unknown commit with an operation ID is checked without resending its mutation", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    let writes = 0,
      reads = 0;
    await t.guest.route("**/api/v1/public/shares/*/nodes", async (route) => {
      writes++;
      const response = await localFetch(route);
      expect(response.status()).toBe(201);
      const { id } = await response.json();
      await route.fulfill({
        status: 503,
        headers: {
          "Content-Type": "application/problem+json",
          "Operation-Id": id,
          "Retry-After": "1",
        },
        body: JSON.stringify({ error: "commit_unknown" }),
      });
    });
    await t.guest.route("**/api/v1/operations/*", async (route) => {
      reads++;
      expect(route.request().headers()["x-share-id"]).toBe(
        new URL(t.url).pathname.split("/").at(-1),
      );
      expect(route.request().headers()["share-session"]).toMatch(/^us_/);
      await route.continue();
    });
    await create(t.guest, "結果だけ確認");
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果だけ確認", exact: true })).toHaveCount(1);
    expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
  } finally {
    await t.context.close();
  }
});
