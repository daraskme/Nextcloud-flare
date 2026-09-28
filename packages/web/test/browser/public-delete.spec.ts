import { expect, test } from "@playwright/test";
import { searchFiles } from "./fileHelpers";
import { create, localFetch, setup } from "./publicShareHelpers";

test.setTimeout(180000);
test("guest confirms deletion on mobile, and the owner restores the folder from trash", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await create(t.guest, "削除と復元の対象");
    const remove = t.guest.getByRole("button", {
      name: "削除と復元の対象をごみ箱へ移動",
      exact: true,
    });
    await remove.click();
    await expect(
      t.guest.getByText(
        "「削除と復元の対象」と中の項目を共有した方のごみ箱へ移動します。復元は共有した方に依頼してください。",
      ),
    ).toBeVisible();
    await t.guest.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(remove).toBeEnabled();
    await remove.click();
    await t.guest.screenshot({ path: "/tmp/ncf-public-delete-mobile.png", fullPage: true });
    expect(await t.guest.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await t.guest.getByRole("button", { name: "ごみ箱へ移動する", exact: true }).click();
    await expect(remove).toHaveCount(0);
    await expect(t.guest.getByRole("button", { name: "更新", exact: true })).toBeEnabled();
    await page.goto("/trash");
    const row = page.getByRole("article").filter({ hasText: "削除と復元の対象" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "復元", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "復元先を選択", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/files");
    await searchFiles(page, "削除と復元の対象");
    await expect(
      page.getByRole("button", { name: "削除と復元の対象の操作", exact: true }),
    ).toBeVisible();
    await t.guest.reload();
    await expect(
      t.guest.getByRole("button", { name: "新規フォルダー", exact: true }),
    ).toBeEnabled();
    await expect(remove).toHaveCount(0);
    await expect(
      t.guest.getByRole("button", { name: `${t.name}をごみ箱へ移動`, exact: true }),
    ).toHaveCount(0);
  } finally {
    await t.context.close();
  }
});
test("lost delete reply is retried only explicitly with the same original key and revision", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await create(t.guest, "一度だけ削除");
    const calls: { key: string | undefined; body: unknown; session: string | undefined }[] = [];
    await t.guest.route("**/api/v1/public/shares/*/nodes/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      calls.push({
        key: route.request().headers()["idempotency-key"],
        session: route.request().headers()["share-session"],
        body: route.request().postDataJSON(),
      });
      const response = await localFetch(route);
      expect(response.status()).toBe(200);
      if (calls.length === 1) await route.abort("connectionfailed");
      else await route.fulfill({ response });
    });
    await t.guest.getByRole("button", { name: "一度だけ削除をごみ箱へ移動", exact: true }).click();
    await t.guest.getByRole("button", { name: "ごみ箱へ移動する", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    expect(calls).toHaveLength(1);
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "更新", exact: true })).toBeEnabled();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]!.body).toEqual({ revision: 1 });
    await expect(t.guest.getByRole("button", { name: "一度だけ削除", exact: true })).toHaveCount(0);
    await page.goto("/trash");
    await expect(page.getByRole("article").filter({ hasText: "一度だけ削除" })).toHaveCount(1);
  } finally {
    await t.context.close();
  }
});
test("a known deletion operation is read back without sending a second DELETE", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await create(t.guest, "削除結果の確認");
    let writes = 0,
      reads = 0;
    await t.guest.route("**/api/v1/public/shares/*/nodes/*", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      writes++;
      const response = await localFetch(route);
      expect(response.status()).toBe(200);
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
      await route.continue();
    });
    await t.guest
      .getByRole("button", { name: "削除結果の確認をごみ箱へ移動", exact: true })
      .click();
    await t.guest.getByRole("button", { name: "ごみ箱へ移動する", exact: true }).click();
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "更新", exact: true })).toBeEnabled();
    expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
    await expect(t.guest.getByRole("button", { name: "削除結果の確認", exact: true })).toHaveCount(
      0,
    );
  } finally {
    await t.context.close();
  }
});
test("a folder changed after the confirmation opened is preserved", async ({ page, browser }) => {
  const t = await setup(page, browser);
  try {
    await create(t.guest, "変更される対象");
    await t.guest
      .getByRole("button", { name: "変更される対象をごみ箱へ移動", exact: true })
      .click();
    const other = await t.context.newPage();
    await other.goto(t.url);
    await other.getByRole("button", { name: "変更される対象", exact: true }).click();
    await create(other, "追加された子");
    await expect(other.getByRole("button", { name: "追加された子", exact: true })).toBeVisible();
    await t.guest.getByRole("button", { name: "ごみ箱へ移動する", exact: true }).click();
    await expect(
      t.guest.getByText(
        "共有の状態が変わったため、操作を確認できませんでした。共有リンクを開き直し、フォルダーの内容を確認してください。",
      ),
    ).toBeVisible();
    await t.guest.reload();
    await expect(
      t.guest.getByRole("button", { name: "変更される対象", exact: true }),
    ).toBeVisible();
    await t.guest.getByRole("button", { name: "変更される対象", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "追加された子", exact: true })).toBeVisible();
  } finally {
    await t.context.close();
  }
});
