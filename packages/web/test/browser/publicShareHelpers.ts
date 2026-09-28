import { type Browser, expect, type Page, type Route } from "@playwright/test";
import { searchFiles } from "./fileHelpers";
export async function setup(owner: Page, browser: Browser) {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  const name = `公開編集-${crypto.randomUUID().slice(0, 8)}`;
  await owner.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await owner.getByLabel("名前", { exact: true }).fill(name);
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await searchFiles(owner, name);
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
export async function open(page: Page, url: string, name: string) {
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
export async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.getByRole("button", { name: "フォルダーを作成", exact: true }).click();
}
export async function localFetch(route: Route) {
  return route.fetch({
    url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
    headers: {
      ...(await route.request().allHeaders()),
      host: "app.ncf.test:8879",
      "sec-fetch-site": "same-origin",
    },
  });
}
