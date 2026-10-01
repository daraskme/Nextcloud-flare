import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function mockSettingsAccount(page: import("@playwright/test").Page, role: string) {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        id: "settings-user",
        email: "settings@example.test",
        role,
        spaceId: "settings-space",
        rootNodeId: "settings-root",
        epoch: 1,
        quotaBytes: 1_000_000,
        usedBytes: 0,
        reservedBytes: 0,
        contentOrigin: "https://content.ncf.test:8879",
      },
    }),
  );
  await page.route("**/api/v1/csrf", (route) =>
    route.fulfill({ json: { token: "settings-csrf" } }),
  );
  await page.route("**/api/v1/app-passwords", (route) =>
    route.fulfill({ json: { passwords: [] } }),
  );
}

test("admin manages pending invites and sees Access and email-delivery guidance", async ({
  page,
}) => {
  await mockSettingsAccount(page, "app_admin");
  const invites = [
    {
      id: "invite-existing",
      email: "existing@example.test",
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 86_400_000,
      revokedAt: null,
      claimedAt: null,
      claimedUserId: null,
    },
  ];
  const posts: unknown[] = [];
  let failFirstCreate = true;
  await page.route("**/api/v1/admin/invites", async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ status: 200, json: { invites } });
    if (method === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      if (failFirstCreate) {
        failFirstCreate = false;
        return route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          body: JSON.stringify({ title: "not_ready" }),
        });
      }
      const created = {
        id: "invite-created",
        email: String(body.email),
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        revokedAt: null,
        claimedAt: null,
        claimedUserId: null,
      };
      invites.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ status: 405 });
  });
  const revoked: string[] = [];
  await page.route("**/api/v1/admin/invites/**", async (route) => {
    if (route.request().method() !== "DELETE") return route.fulfill({ status: 405 });
    const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    revoked.push(id);
    const index = invites.findIndex((invite) => invite.id === id);
    if (index >= 0) invites.splice(index, 1);
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/settings/webdav");
  await expect(page.getByRole("heading", { name: "利用者の招待", exact: true })).toBeVisible();
  await expect(
    page.getByText("Cloudflare Access の許可設定にも追加", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("招待メールは送信されません", { exact: false })).toBeVisible();
  await expect(page.getByText("有効期間は7日間", { exact: false })).toBeVisible();
  await expect(page.getByText("一般利用者として登録", { exact: false })).toBeVisible();
  await expect(page.getByText("existing@example.test", { exact: true })).toBeVisible();

  await page.getByLabel("メールアドレス", { exact: true }).fill("new@example.test");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("現在サービスを利用できません");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await expect(page.getByText("new@example.test", { exact: true })).toBeVisible();
  expect(posts).toEqual([{ email: "new@example.test" }, { email: "new@example.test" }]);

  await page.getByRole("button", { name: "existing@example.testの招待を取り消す" }).click();
  await expect(page.getByText("existing@example.test", { exact: true })).toHaveCount(0);
  expect(revoked).toEqual(["invite-existing"]);
});

test("does not show invite management to a member", async ({ page }) => {
  await mockSettingsAccount(page, "member");
  await page.goto("/settings/webdav");
  await expect(page.getByRole("heading", { name: "WebDAV 設定", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "利用者の招待", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("メールアドレス", { exact: true })).toHaveCount(0);
});

test("creates a root-scoped app password, reveals its secret once, and revokes it", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const folderName = `DAV root ${suffix}`;
  const passwordName = `DAV client ${suffix}`;
  await page.goto("/files");
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(folderName);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "新しいフォルダー", exact: true })
    .click();
  await expect(page.locator(".file-name").filter({ hasText: folderName })).toBeVisible();

  const createBodies: Record<string, unknown>[] = [];
  let rejectNext = true;
  await page.route("**/api/v1/app-passwords", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createBodies.push(route.request().postDataJSON());
    if (rejectNext) {
      rejectNext = false;
      return route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "not_ready" }),
      });
    }
    return route.continue();
  });

  await page.getByRole("link", { name: "WebDAV 設定", exact: true }).click();
  await expect(page.getByRole("heading", { name: "WebDAV 設定", exact: true })).toBeVisible();
  await expect(page.getByText(`${new URL(page.url()).origin}/dav`, { exact: true })).toBeVisible();
  await page.getByLabel("名前", { exact: true }).fill(passwordName);
  await page.getByLabel("有効期間", { exact: false }).fill("30");
  await page.getByRole("checkbox", { name: "作成 ファイルとフォルダーの新規作成" }).check();
  await page.getByRole("checkbox", { name: "更新 既存ファイルの置換と名前・場所の変更" }).check();
  await page.getByRole("checkbox", { name: "削除 ファイルとフォルダーの削除" }).check();
  await page.getByLabel("ルートフォルダーを限定する", { exact: false }).check();
  await page.getByRole("button", { name: folderName, exact: true }).click();
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("現在サービスを利用できません");

  await page.getByRole("button", { name: "作成する", exact: true }).click();
  const credential = page.getByTestId("one-time-credential");
  await expect(credential).toBeVisible();
  const username = await page.getByTestId("app-password-username").inputValue();
  const secret = await page.getByTestId("app-password-secret").inputValue();
  expect(username).toMatch(/^ap_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(createBodies).toHaveLength(2);
  expect(createBodies[1]).toMatchObject({
    name: passwordName,
    scopes: ["node:read", "node:create", "node:write", "node:delete"],
    ttlDays: 30,
  });
  const listed = await page.evaluate(async () => {
    const response = await fetch("/api/v1/app-passwords");
    return { cache: response.headers.get("Cache-Control"), body: await response.text() };
  });
  expect(listed.cache).toBe("private, no-store");
  expect(listed.body).not.toContain(secret);
  expect(JSON.parse(listed.body)).toMatchObject({
    passwords: [{ id: username, name: passwordName, rootNodeId: createBodies[1]!.rootNodeId }],
  });
  const browserState = await page.evaluate((value) => {
    const storage = [
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
      location.href,
    ].join("\n");
    return { containsSecret: storage.includes(value), href: location.href };
  }, secret);
  expect(browserState).toEqual({
    containsSecret: false,
    href: `${new URL(page.url()).origin}/settings/webdav`,
  });

  const dav = () =>
    request.fetch("https://127.0.0.1:8879/dav", {
      method: "OPTIONS",
      headers: {
        host: "app.ncf.test:8879",
        "X-Test-Without-Auth": "1",
        Authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`,
      },
    });
  expect((await dav()).status()).toBe(200);

  await page.getByRole("button", { name: "保存しました。閉じる", exact: true }).click();
  await expect(credential).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  const row = page.getByRole("listitem").filter({ hasText: passwordName });
  await expect(row).toContainText("読み取り・作成・更新・削除");
  await row.getByRole("button", { name: `${passwordName}を失効` }).click();
  const revoke = page.getByRole("dialog", { name: "アプリパスワードを失効" });
  await revoke.getByRole("button", { name: "失効する", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await dav()).status()).toBe(401);
});

test("ignores a late app-password creation response after navigation", async ({ page }) => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/app-passwords", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route
      .fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "ap_00000000000000000000000000",
          credentialId: "ap:ap_00000000000000000000000000",
          name: "late response",
          rootNodeId: null,
          createdAt: 1,
          expiresAt: 2,
          scopes: ["node:read"],
          secret: "stale-secret-that-must-not-appear",
        }),
      })
      .catch(() => undefined);
  });
  await page.goto("/settings/webdav");
  await page.getByLabel("名前", { exact: true }).fill("late response");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await started;
  await page.getByRole("link", { name: "マイドライブ", exact: true }).click();
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await page.getByRole("link", { name: "WebDAV 設定", exact: true }).click();
  await expect(page.getByTestId("one-time-credential")).toHaveCount(0);
  await expect(page.getByText("stale-secret-that-must-not-appear", { exact: true })).toHaveCount(0);
});

test("keeps the WebDAV settings form accessible on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/files");
  await page.getByRole("button", { name: "ナビゲーションを開く" }).click();
  await page.getByRole("link", { name: "WebDAV 設定", exact: true }).click();
  await expect(page.getByRole("heading", { name: "WebDAV 設定", exact: true })).toBeVisible();
  await expect(page.getByLabel("名前", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "許可する操作" })).toBeVisible();
  await expect(page.getByLabel("ルートフォルダーを限定する", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
