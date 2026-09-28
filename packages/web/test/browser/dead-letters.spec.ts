import { expect, test } from "@playwright/test";

test("administrator reads real DLQ receipts with pagination and hides them after access fails", async ({
  page,
}) => {
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      fetch("/__test__/dead-letters", { method: "POST" }).then((r) => r.json()),
    ),
  ).toEqual({ acked: 52, retried: 0 });
  await page.getByRole("button", { name: "アカウントメニュー" }).click();
  await page.getByRole("menuitem", { name: "配信失敗の記録" }).click();
  const dialog = page.getByRole("dialog"),
    list = dialog.getByRole("list", { name: "配信失敗の一覧" });
  await expect(list.getByRole("listitem")).toHaveCount(50);
  await expect(dialog.getByText("メッセージ形式が不正").first()).toBeVisible();
  await expect(dialog.getByText("元の処理が見つかりません").first()).toBeVisible();
  await expect(dialog.getByText("secret-dlq-document.txt")).toHaveCount(0);
  await dialog.getByRole("button", { name: "続きを読み込む" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(52);
  await expect(dialog.getByRole("button", { name: "続きを読み込む" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("dead-letters-mobile.png") });
  await page.route("**/api/v1/admin/dlq**", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      body: JSON.stringify({ error: "forbidden" }),
    }),
  );
  await dialog.getByRole("button", { name: "更新", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await dialog.getByRole("button", { name: "閉じる", exact: true }).last().click();
});

test("a member cannot open or directly read administrator delivery records", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "ncf-test-user",
      value: "recipient",
      domain: "app.ncf.test",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "アカウントメニュー" }).click();
  await expect(page.getByRole("menuitem", { name: "配信失敗の記録" })).toHaveCount(0);
  expect(await page.evaluate(() => fetch("/api/v1/admin/dlq").then((r) => r.status))).toBe(403);
});
