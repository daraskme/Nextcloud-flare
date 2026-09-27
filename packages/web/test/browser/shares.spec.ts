import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Earlier browser scenarios may have logged out. Issue a fresh Access fingerprint;
  // never clear revocation rows or assume this file runs before the logout scenario.
  const response = await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  expect(response.status()).toBe(200);
});

async function openShare(page: Page, name: string) {
  await page.goto("/files");
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: `${name}の操作` }).click();
  await page.getByRole("menuitem", { name: "共有を管理" }).click();
  await expect(page.getByText("設定済みの共有はありません。", { exact: true })).toBeVisible();
}
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

test("internal shares: create, update and revoke through the real API on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openShare(page, "共有するフォルダー");
  const dialog = page.getByRole("dialog");
  const email = page.getByLabel("共有相手のメールアドレス", { exact: true });
  await email.fill("missing@example.invalid");
  await dialog.getByRole("button", { name: "共有を作成", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("共有相手を確認できません");
  await expect(email).toHaveValue("missing@example.invalid");
  await email.fill("recipient@example.invalid");
  await dialog.getByRole("button", { name: "共有を作成", exact: true }).click();
  await expect(dialog.getByText("共有を作成しました。", { exact: true })).toBeVisible();
  await expect(dialog.locator(".share-row")).toHaveCount(1);
  await expect(dialog.locator(".share-row")).toContainText("閲覧");
  await dialog.getByRole("button", { name: "変更", exact: true }).click();
  await page.getByLabel("権限", { exact: true }).selectOption("edit");
  await page.getByLabel("有効期限（任意）", { exact: true }).fill("2099-01-01T12:00");
  await dialog.getByRole("button", { name: "共有を更新", exact: true }).click();
  await expect(dialog.locator(".share-row")).toContainText("編集");
  await expect(dialog.locator(".share-row")).toContainText("2099");
  await page.screenshot({ path: testInfo.outputPath("share-management-mobile.png") });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "共有するフォルダーの操作" }).click();
  await page.getByRole("menuitem", { name: "共有を管理" }).click();
  await expect(dialog.locator(".share-row")).toContainText("編集");
  await dialog.getByRole("button", { name: "共有を停止", exact: true }).click();
  await expect(dialog.getByText("共有を停止しました。", { exact: true })).toBeVisible();
  await expect(dialog.locator(".share-row")).toHaveCount(0);
});

test("lost share creation response retains input and requires list review without replaying POST", async ({
  page,
}) => {
  await openShare(page, "共有の応答喪失");
  let posts = 0;
  await page.route("**/api/v1/shares", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const response = await route.fetch({
      url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
      headers: {
        ...(await route.request().allHeaders()),
        host: "app.ncf.test:8879",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(response.status()).toBe(201);
    await route.abort("connectionfailed");
  });
  const dialog = page.getByRole("dialog");
  await page
    .getByLabel("共有相手のメールアドレス", { exact: true })
    .fill("recipient@example.invalid");
  await dialog.getByRole("button", { name: "共有を作成", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("結果を確認できませんでした");
  await expect(page.getByLabel("共有相手のメールアドレス", { exact: true })).toHaveValue(
    "recipient@example.invalid",
  );
  await expect(dialog.getByRole("button", { name: "共有を作成", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "共有一覧を更新", exact: true }).click();
  await expect(dialog.locator(".share-row")).toHaveCount(1);
  expect(posts).toBe(1);
});

test("an outdated share editor cannot overwrite a concurrent change", async ({ page }) => {
  await openShare(page, "共有の同時変更");
  const dialog = page.getByRole("dialog");
  await page
    .getByLabel("共有相手のメールアドレス", { exact: true })
    .fill("recipient@example.invalid");
  await dialog.getByRole("button", { name: "共有を作成", exact: true }).click();
  await expect(dialog.locator(".share-row")).toHaveCount(1);
  await dialog.getByRole("button", { name: "変更", exact: true }).click();
  expect(
    await page.evaluate(async () => {
      const { items } = await fetch("/api/v1/shares").then((r) => r.json());
      const share = items.find((s: { name: string }) => s.name === "共有の同時変更");
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
            kind: "internal",
            rootNodeId: share.rootNodeId,
            role: "edit",
            recipients: ["recipient@example.invalid"],
          }),
        })
      ).status;
    }),
  ).toBe(200);
  await dialog.getByRole("button", { name: "共有を更新", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("共有が別の操作で変更されています");
  await dialog.getByRole("button", { name: "共有一覧を更新", exact: true }).click();
  await expect(dialog.locator(".share-row")).toContainText("編集");
  await dialog.getByRole("button", { name: "変更", exact: true }).click();
  await expect(page.getByLabel("権限", { exact: true })).toHaveValue("edit");
  await dialog.getByRole("button", { name: "共有を停止", exact: true }).click();
  await expect(dialog.locator(".share-row")).toHaveCount(0);
});
