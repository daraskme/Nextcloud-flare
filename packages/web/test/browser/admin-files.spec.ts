import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

async function mockMe(page: import("@playwright/test").Page, role: string) {
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        id: "viewer",
        email: "admin@example.test",
        role,
        spaceId: "viewer-space",
        rootNodeId: "viewer-root",
        epoch: 1,
        quotaBytes: 1000,
        usedBytes: 0,
        reservedBytes: 0,
        contentOrigin: "https://content.ncf.test:8879",
      },
    }),
  );
}

test("admin can browse owner folders and issue separate preview/download audits", async ({
  page,
}) => {
  await mockMe(page, "app_admin");
  const accessed: string[] = [];
  await page.route("**/api/v1/admin/users**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/admin/users")
      return route.fulfill({
        json: {
          users: [
            {
              id: "owner-a",
              email: "a@example.test",
              spaceId: "space-a",
              rootNodeId: "root-a",
              quotaBytes: 1000,
              usedBytes: 100,
              disabled: false,
            },
            {
              id: "owner-b",
              email: "b@example.test",
              spaceId: "space-b",
              rootNodeId: "root-b",
              quotaBytes: 1000,
              usedBytes: 100,
              disabled: false,
            },
          ],
          nextCursor: null,
        },
      });
    if (
      path === "/api/v1/admin/users/owner-a/nodes/root-a/path" ||
      path.endsWith("/nodes/folder-a/path")
    ) {
      const inFolder = path.endsWith("/folder-a/path");
      return route.fulfill({
        json: {
          path: inFolder
            ? [
                { id: "root-a", name: "a@example.test", kind: "root", revision: 1 },
                { id: "folder-a", name: "Documents", kind: "folder", revision: 1 },
              ]
            : [{ id: "root-a", name: "a@example.test", kind: "root", revision: 1 }],
        },
      });
    }
    if (path.endsWith("/nodes/root-a/children"))
      return route.fulfill({
        json: {
          parentId: "root-a",
          treeGeneration: 1,
          children: [
            {
              id: "folder-a",
              parentId: "root-a",
              ownerId: "owner-a",
              name: "Documents",
              kind: "folder",
              revision: 1,
              currentBlobId: null,
              updatedAt: 1000,
              size: null,
              mime: null,
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/nodes/folder-a/children"))
      return route.fulfill({
        json: {
          parentId: "folder-a",
          treeGeneration: 1,
          children: [
            {
              id: "file-a",
              parentId: "folder-a",
              ownerId: "owner-a",
              name: "notes.txt",
              kind: "file",
              revision: 1,
              currentBlobId: "blob-a",
              updatedAt: 1000,
              size: 12,
              mime: "text/plain",
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/content-session")) {
      const body = route.request().postDataJSON();
      accessed.push(body.action);
      expect(body.targets).toEqual([{ spaceId: "space-a", nodeId: "file-a" }]);
      return route.fulfill({
        status: 201,
        json: { ticket: `ticket-${body.action}`, ticketId: `ticket-id-${body.action}` },
      });
    }
    return route.fulfill({ status: 404, json: { title: "not_found" } });
  });
  await page.route("**/api/v1/csrf", (route) => route.fulfill({ json: { token: "csrf" } }));
  await page.route("**/api/v1/admin/audit**", (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: "audit-1",
            actorId: "viewer",
            ownerId: "owner-a",
            nodeId: "file-a",
            action: "preview",
            occurredAt: 1000,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("https://content.ncf.test:8879/c/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "safe fixture" }),
  );

  await page.goto("/admin/files");
  await expect(page.getByRole("link", { name: "全利用者のファイル" })).toBeVisible();
  await expect(page.getByText("管理者として閲覧中")).toBeVisible();
  await expect(page.getByText("a@example.test の個人ファイルを表示しています")).toBeVisible();
  await expect(page.getByRole("heading", { name: "閲覧履歴" })).toBeVisible();
  await expect(page.getByText("プレビュー", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Documents" }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  expect(await page.getByRole("button", { name: /編集|削除|共有|アップロード/ }).count()).toBe(0);

  const popups: import("@playwright/test").Page[] = [];
  page.on("popup", (popup) => popups.push(popup));
  await page.getByRole("button", { name: "プレビュー" }).click();
  await expect.poll(() => accessed).toEqual(["preview"]);
  await page.getByRole("button", { name: "ダウンロード" }).click();
  await expect.poll(() => accessed).toEqual(["preview", "download"]);
  await page.getByLabel("利用者", { exact: true }).selectOption("owner-b");
  await expect(page.getByText("b@example.test の個人ファイルを表示しています")).toBeVisible();
  expect(popups.length).toBeGreaterThan(0);
});

test("member direct URL shows no permission and makes no admin request", async ({ page }) => {
  await mockMe(page, "member");
  let adminCalls = 0;
  await page.route("**/api/v1/admin/**", (route) => {
    adminCalls++;
    return route.fulfill({ status: 403, json: { title: "forbidden" } });
  });
  await page.goto("/admin/files");
  await expect(page.getByRole("heading", { name: "この画面を利用できません" })).toBeVisible();
  await expect(page.getByRole("link", { name: "全利用者のファイル" })).toHaveCount(0);
  expect(adminCalls).toBe(0);
});
