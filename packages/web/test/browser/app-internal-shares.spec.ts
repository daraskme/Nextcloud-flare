import { expect, type Page, type Route, test } from "@playwright/test";

const now = Date.now();
const directMount = {
  shareId: "sh_direct",
  shareVersion: 1,
  mountId: "sh_direct",
  mountName: "direct-project",
  actions: ["read", "download", "create", "edit"],
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
    groupVersion: 2,
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
  const patches: Record<string, unknown>[] = [];
  const shares: Record<string, unknown>[] = [
    {
      id: "sh_delegated",
      rootNodeId: "delegated-root",
      rootName: "委任済みフォルダー",
      kind: "internal",
      version: 2,
      disabledAt: null,
      expiresAt: now + 60_000,
      createdAt: now,
      passwordProtected: false,
      actions: ["read"],
      recipientUserId: "downstream",
      recipientEmail: "downstream@example.invalid",
      recipientGroupId: null,
      recipientGroupName: null,
      mountId: "sh_delegated",
      mountName: "delegated-folder",
      sourceShareId: "sh_source",
      delegatedByUserId: "member",
      delegationDepth: 2,
      resharePolicy: {
        enabled: true,
        actions: ["read"],
        maxDepth: 3,
        maxFanout: 6,
        expiresAt: null,
        version: 2,
      },
    },
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
        actions: ["read", "download", "create", "edit"],
        resharePolicy: {
          enabled: true,
          actions: ["read", "download", "create", "edit"],
          maxDepth: 2,
          maxFanout: 7,
          ttlDays: 14,
        },
      });
      const body = request.postDataJSON();
      const created = {
        id: "sh_created",
        rootNodeId: body.rootNodeId,
        rootName: "マイドライブ",
        kind: "internal",
        version: 1,
        disabledAt: null,
        expiresAt: now + 30 * 86_400_000,
        createdAt: now,
        passwordProtected: false,
        actions: body.actions,
        recipientUserId: "member",
        recipientEmail: "member@example.invalid",
        recipientGroupId: null,
        recipientGroupName: null,
        mountId: "sh_created",
        mountName: "created-drive",
        sourceShareId: null,
        delegatedByUserId: null,
        delegationDepth: 0,
        resharePolicy: {
          ...body.resharePolicy,
          expiresAt: now + 14 * 86_400_000,
          version: 1,
        },
      };
      shares.unshift(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (request.method() === "PATCH") {
      const share = shares.find((value) => value.id === "sh_created")!;
      const body = request.postDataJSON();
      patches.push(body);
      if (body.actions) {
        share.actions = body.actions;
        share.version = Number(share.version) + 1;
      }
      if (body.resharePolicy) {
        share.resharePolicy = {
          ...body.resharePolicy,
          expiresAt: body.resharePolicy.ttlDays
            ? now + body.resharePolicy.ttlDays * 86_400_000
            : null,
          version:
            Number((share.resharePolicy as { version?: number } | undefined)?.version ?? 0) + 1,
        };
      }
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
  await expect(page.getByText("委任深度").locator("..")).toContainText("2");
  await expect(page.getByText("共有元 ID").locator("..")).toContainText("sh_source");
  await expect(page.getByText("委任者 ID").locator("..")).toContainText("member");
  await page.getByRole("button", { name: "内部共有を作成" }).click();
  await page.getByLabel("相手のメールアドレス").fill("member@example.invalid");
  await page.getByLabel("ファイルとフォルダーの作成を許可").check();
  await page.getByLabel("ファイル名と内容の編集を許可").check();
  await page.getByLabel("再共有ポリシーを設定").check();
  await page.getByLabel("作成", { exact: true }).check();
  await page.getByLabel("編集", { exact: true }).check();
  await page.getByLabel("最大委任深度").selectOption("2");
  await page.getByLabel("最大ファンアウト").fill("7");
  await page.getByLabel("ポリシー独自の有効期限を設定").check();
  await page.getByLabel("ポリシー有効期間（日）").fill("14");
  await page.getByRole("button", { name: "共有を作成", exact: true }).click();
  await expect(page.getByText("member@example.invalid")).toBeVisible();
  await expect(page.getByText("閲覧・ダウンロード・作成・編集", { exact: true })).toBeVisible();
  const createdCard = page.getByRole("article").filter({ hasText: "member@example.invalid" });
  await expect(createdCard.getByText("最大深度 2")).toBeVisible();
  await expect(createdCard.getByText("最大ファンアウト 7")).toBeVisible();
  await createdCard.getByRole("button", { name: "再共有ポリシーを編集" }).click();
  const policyDialog = page.getByRole("dialog");
  await policyDialog.getByLabel("最大ファンアウト").fill("9");
  await policyDialog.getByLabel("ダウンロード").uncheck();
  await policyDialog.getByLabel("ポリシー独自の有効期限を設定").uncheck();
  await policyDialog.getByRole("button", { name: "ポリシーを保存" }).click();
  await expect(createdCard.getByText("最大ファンアウト 9")).toBeVisible();
  await expect(createdCard.getByText("操作: 閲覧・作成・編集")).toBeVisible();
  await createdCard.getByRole("button", { name: "編集を停止" }).click();
  expect(patches.at(-1)).toEqual({
    actions: ["read", "download", "create"],
    resharePolicy: {
      enabled: true,
      actions: ["read", "create"],
      maxDepth: 2,
      maxFanout: 9,
    },
  });
  await expect(createdCard.getByText("閲覧・ダウンロード・作成", { exact: true })).toBeVisible();
  await createdCard.getByRole("button", { name: "ダウンロードを停止" }).click();
  await expect(createdCard.getByText("閲覧・作成", { exact: true })).toBeVisible();
  await createdCard.getByRole("button", { name: "共有を取り消す" }).click();
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
  await expect(page.getByText("閲覧・ダウンロード・作成・編集", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "仕様 フォルダー", exact: true }).click();
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
  await expect(page.getByText("閲覧・ダウンロード・作成・編集", { exact: true })).toBeVisible();
  current = [
    {
      ...directMount,
      shareVersion: 2,
      actions: ["read", "download"],
    },
  ];
  const refresh = page.getByRole("button", { name: "内部共有を更新" });
  await refresh.click();
  await refresh.click();
  await expect(page.getByText("閲覧・ダウンロード", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("アクセスが変更されました");
  releaseStale();
  await expect(page.getByText("閲覧・ダウンロード", { exact: true })).toBeVisible();
  current = [];
  await refresh.click();
  await expect(page.getByText("共有されたフォルダーはありません")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("アクセスが変更されました");
});
