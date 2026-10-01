import { expect, type Page, type Route, test } from "@playwright/test";

const now = Date.now();
const directMount = {
  shareId: "sh_direct",
  shareVersion: 1,
  mountId: "sh_direct",
  mountName: "direct-project",
  actions: ["read", "download"],
  root: {
    id: "shared-root",
    spaceId: "owner-space",
    ownerId: "owner",
    name: "共有プロジェクト",
    kind: "folder",
    revision: 1,
  },
  owner: { id: "owner", email: "owner@example.invalid" },
  provenance: { kind: "direct", recipientVersion: 1 },
};
const groupMount = {
  shareId: "sh_group",
  shareVersion: 3,
  mountId: "sh_group",
  mountName: "group-plans",
  actions: ["read"],
  root: {
    id: "group-root",
    spaceId: "owner-space",
    ownerId: "owner",
    name: "グループ計画",
    kind: "folder",
    revision: 2,
  },
  owner: { id: "owner", email: "owner@example.invalid" },
  provenance: {
    kind: "group",
    groupId: "group-engineering",
    groupName: "Engineering",
    membershipVersion: 4,
  },
};

async function mockFolderReads(page: Page) {
  await page.route("**/api/v1/nodes/*/path", async (route) => {
    const nodeId = route.request().url().split("/").at(-2)!;
    const shared = nodeId === "shared-root" || nodeId === "shared-child";
    const rootId = shared ? "shared-root" : nodeId === "group-root" ? "group-root" : nodeId;
    await route.fulfill({
      json: {
        nodeId,
        treeGeneration: 1,
        path: shared
          ? [
              { id: "private-owner-root", name: "所有者の非公開ルート", kind: "root", revision: 1 },
              { id: "shared-root", name: "共有プロジェクト", kind: "folder", revision: 1 },
              ...(nodeId === "shared-child"
                ? [{ id: "shared-child", name: "仕様", kind: "folder", revision: 1 }]
                : []),
            ]
          : [{ id: rootId, name: "マイドライブ", kind: "root", revision: 1 }],
      },
    });
  });
  await page.route("**/api/v1/nodes/*/children*", async (route) => {
    const nodeId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    await route.fulfill({
      json: {
        parentId: nodeId,
        treeGeneration: 1,
        children:
          nodeId === "shared-root"
            ? [
                {
                  id: "shared-child",
                  parentId: "shared-root",
                  name: "仕様",
                  kind: "folder",
                  revision: 1,
                  currentBlobId: null,
                  updatedAt: now,
                  size: null,
                  mime: null,
                },
                {
                  id: "shared-file",
                  parentId: "shared-root",
                  name: "計画.txt",
                  kind: "file",
                  revision: 1,
                  currentBlobId: "blob",
                  updatedAt: now,
                  size: 42,
                  mime: "text/plain",
                },
              ]
            : [],
        nextCursor: null,
      },
    });
  });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("owner creates, inspects, changes and revokes a private internal share", async ({ page }) => {
  const shares: Record<string, unknown>[] = [
    {
      id: "sh_public",
      rootNodeId: "public-root",
      rootName: "公開リンクの秘密",
      kind: "link",
      version: 1,
      disabledAt: null,
      expiresAt: now + 60_000,
      createdAt: now,
      passwordProtected: false,
      reservedBytes: 0,
      reservationLimit: 0,
      actions: ["read", "download"],
    },
  ];
  await page.route("**/api/v1/groups", (route) =>
    route.fulfill({
      json: {
        groups: [
          {
            id: "group-engineering",
            name: "Engineering",
            version: 1,
            createdAt: now,
            updatedAt: now,
            memberEmails: ["member@example.invalid"],
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/shared-with-me", (route) => route.fulfill({ json: { shares: [] } }));
  await mockFolderReads(page);
  await page.route(/\/api\/v1\/shares(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { shares } });
    if (request.method() === "POST") {
      expect(request.postDataJSON()).toMatchObject({
        kind: "internal",
        recipientEmail: "member@example.invalid",
        actions: ["read", "download"],
      });
      const created = {
        id: "sh_created",
        rootNodeId: request.postDataJSON().rootNodeId,
        rootName: "マイドライブ",
        kind: "internal",
        version: 1,
        disabledAt: null,
        expiresAt: now + 30 * 86_400_000,
        createdAt: now,
        passwordProtected: false,
        actions: ["read", "download"],
        recipientUserId: "member",
        recipientEmail: "member@example.invalid",
        recipientGroupId: null,
        recipientGroupName: null,
        mountId: "sh_created",
        mountName: "created-drive",
      };
      shares.unshift(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (request.method() === "PATCH") {
      const share = shares.find((value) => value.id === "sh_created")!;
      share.actions = request.postDataJSON().actions;
      share.version = Number(share.version) + 1;
      return route.fulfill({ json: share });
    }
    if (request.method() === "DELETE") {
      const share = shares.find((value) => value.id === "sh_created")!;
      share.disabledAt = now;
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await page.goto("/shares");
  await expect(page.getByRole("heading", { name: "内部共有", exact: true })).toBeVisible();
  await expect(page.getByText("公開リンクの秘密")).toHaveCount(0);
  await page.getByRole("button", { name: "内部共有を作成" }).click();
  await page.getByLabel("相手のメールアドレス").fill("member@example.invalid");
  await page.getByRole("button", { name: "共有を作成", exact: true }).click();
  await expect(page.getByText("member@example.invalid")).toBeVisible();
  await expect(page.getByText("閲覧・ダウンロード", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ダウンロードを停止" }).click();
  await expect(page.getByText("閲覧のみ", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "共有を取り消す" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "共有を取り消す", exact: true })
    .click();
  await expect(page.getByText("取り消し済み")).toBeVisible();
});

test("recipient sees direct/group provenance and browses a read-only mount", async ({ page }) => {
  await page.route("**/api/v1/shares", (route) => route.fulfill({ json: { shares: [] } }));
  await page.route("**/api/v1/groups", (route) => route.fulfill({ json: { groups: [] } }));
  await page.route("**/api/v1/shared-with-me", (route) =>
    route.fulfill({ json: { shares: [directMount, groupMount] } }),
  );
  await mockFolderReads(page);
  await page.goto("/shares");
  await expect(page.getByText("あなたに直接")).toBeVisible();
  await expect(page.getByText("Engineering", { exact: true })).toBeVisible();
  await expect(page.getByText("閲覧・ダウンロード", { exact: true })).toBeVisible();
  await expect(page.getByText("閲覧のみ", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("heading", { name: "内部共有", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("article")
    .filter({ hasText: "共有プロジェクト" })
    .getByRole("link", { name: "共有フォルダーを開く" })
    .click();
  await expect(page).toHaveURL(/\/shared\/sh_direct$/);
  await expect(page.getByRole("heading", { name: "共有プロジェクト", exact: true })).toBeVisible();
  await expect(page.getByText("所有者の非公開ルート")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "計画.txtの操作" })).toHaveCount(0);
  await page.getByRole("button", { name: "仕様", exact: false }).click();
  await expect(page).toHaveURL(/\/shared\/sh_direct\/shared-child$/);
  await expect(page.getByRole("heading", { name: "このフォルダーは空です" })).toBeVisible();
  await expect(page.getByText("現在表示できるファイルやフォルダーはありません。")).toBeVisible();
  await expect(page.getByText("アップロードから追加できます")).toHaveCount(0);
  await page.goto("/shared/missing/child");
  await expect(page.getByRole("heading", { name: "共有フォルダー", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "この共有は利用できません" })).toBeVisible();
});

test("permission, revocation and stale mount responses cannot restore obsolete access", async ({
  page,
}) => {
  let current = [{ ...directMount }];
  let calls = 0;
  let releaseStale!: () => void;
  const stale = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  await page.route("**/api/v1/shares", (route) => route.fulfill({ json: { shares: [] } }));
  await page.route("**/api/v1/groups", (route) => route.fulfill({ json: { groups: [] } }));
  await page.route("**/api/v1/shared-with-me", async (route) => {
    calls++;
    if (calls === 2) {
      await stale;
      return route.fulfill({ json: { shares: [directMount] } });
    }
    await route.fulfill({ json: { shares: current } });
  });
  await page.goto("/shares");
  await expect(page.getByText("閲覧・ダウンロード", { exact: true })).toBeVisible();
  current = [
    {
      ...directMount,
      shareVersion: 2,
      actions: ["read"],
    },
  ];
  const refresh = page.getByRole("button", { name: "内部共有を更新" });
  await refresh.click();
  await refresh.click();
  await expect(page.getByText("閲覧のみ", { exact: true })).toBeVisible();
  releaseStale();
  await expect(page.getByText("閲覧のみ", { exact: true })).toBeVisible();
  current = [];
  await refresh.click();
  await expect(page.getByText("共有されたフォルダーはありません")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("アクセスが変更されました");
});
