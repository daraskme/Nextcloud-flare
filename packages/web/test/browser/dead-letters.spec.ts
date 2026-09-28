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

for (const committed of [false, true])
  test(`requeue intent survives a lost ${committed ? "committed" : "unsent"} reply and reload without duplicating work`, async ({
    page,
  }) => {
    await page.goto("/files");
    const name = `配信再開-${crypto.randomUUID().slice(0, 8)}`;
    const original = await page.evaluate(async (name) => {
      const me = await fetch("/api/v1/me").then((r) => r.json());
      const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const created = await fetch("/api/v1/nodes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf.token,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          spaceId: me.spaceId,
          parentId: me.rootNodeId,
          name,
          kind: "folder",
        }),
      }).then((r) => r.json());
      const response = await fetch(`/__test__/dead-letter-node/${created.result.nodeId}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`seed_${response.status}`);
      return response.json();
    }, name);
    expect(original).toMatchObject({ acked: 1, retried: 0 });
    const keys: string[] = [];
    await page.route("**/api/v1/admin/dlq/*/requeue", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (keys.length === 1) {
        if (committed) {
          const response = await route.fetch({
            url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
            headers: {
              ...(await route.request().allHeaders()),
              host: "app.ncf.test:8879",
              "sec-fetch-site": "same-origin",
            },
          });
          expect(response.status()).toBe(202);
        }
        await route.abort("failed");
      } else await route.continue();
    });
    const open = async () => {
      await page.getByRole("button", { name: "アカウントメニュー" }).click();
      await page.getByRole("menuitem", { name: "配信失敗の記録" }).click();
    };
    await open();
    const row = page
      .getByRole("dialog")
      .getByRole("listitem")
      .filter({ hasText: original.messageId });
    await row.getByRole("button", { name: "再配信を予約" }).click();
    await expect(page.getByText("受付を確認できませんでした。", { exact: false })).toBeVisible();
    await page.reload();
    await open();
    if (!committed) {
      await row.getByRole("button", { name: "再配信を予約" }).click();
      await expect(page.getByText("再配信を受け付けました。", { exact: false })).toBeVisible();
    }
    await expect(row.getByText("再配信受付", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "再配信を予約" })).toHaveCount(0);
    expect(keys).toEqual(Array(committed ? 1 : 2).fill(`dlq:${original.messageId}`));
    expect(
      await page.evaluate(
        async (id) =>
          fetch(`/__test__/dead-letter-dispatch/${id}`, { method: "POST" }).then((r) => r.json()),
        original.outboxId,
      ),
    ).toEqual({ acked: 1, retried: 0, audits: 1 });
    await page.getByRole("dialog").getByRole("button", { name: "更新", exact: true }).click();
    await expect(row.getByText("完了", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath(`dead-letter-requeue-${committed}.png`) });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
