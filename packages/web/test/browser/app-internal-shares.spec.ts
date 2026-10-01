import { expect, type Page, type Route, test } from "@playwright/test";
import type { SharedMount } from "../../src/lib/api";

const now = Date.now();
const directMount: SharedMount = {
  shareId: "sh_direct",
  shareVersion: 1,
  mountId: "sh_direct",
  mountName: "direct-project",
  actions: ["read", "download", "create", "edit"],
  expiresAt: now + 10 * 86_400_000,
  delegationDepth: 0,
  reshareAuthority: {
    policyVersion: 1,
    actions: ["read", "download", "create", "edit"],
    maxDepth: 2,
    maxFanout: 2,
    currentFanout: 0,
    expiresAt: now + 7 * 86_400_000,
  },
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
const groupMount: SharedMount = {
  shareId: "sh_group",
  shareVersion: 3,
  mountId: "sh_group",
  mountName: "group-plans",
  actions: ["read"],
  expiresAt: null,
  delegationDepth: 0,
  reshareAuthority: {
    policyVersion: 2,
    actions: ["read"],
    maxDepth: 2,
    maxFanout: 3,
    currentFanout: 0,
    expiresAt: null,
  },
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

test("owner creates, edits, inspects and disables a bounded share group", async ({ page }) => {
  let groupReads = 0;
  const groups: Record<string, unknown>[] = [];
  await page.route("**/api/v1/shares", (route) => route.fulfill({ json: { shares: [] } }));
  await page.route("**/api/v1/shared-with-me", (route) => route.fulfill({ json: { shares: [] } }));
  await page.route(/\/api\/v1\/groups(?:\/[^/?]+)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      groupReads++;
      if (groupReads === 1) return route.fulfill({ status: 503, json: { title: "not_ready" } });
      return route.fulfill({ json: { groups } });
    }
    if (request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        name: "Project Editors",
        memberEmails: ["alice@example.invalid"],
      });
      const created = {
        id: "group-project",
        name: "Project Editors",
        version: 1,
        createdAt: now,
        updatedAt: now,
        memberEmails: ["alice@example.invalid"],
      };
      groups.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (request.method() === "PATCH") {
      expect(request.postDataJSON()).toEqual({
        name: "Project Reviewers",
        memberEmails: ["alice@example.invalid", "bob@example.invalid"],
      });
      Object.assign(groups[0]!, {
        ...request.postDataJSON(),
        version: 2,
        updatedAt: now + 1,
      });
      return route.fulfill({ json: groups[0] });
    }
    expect(request.method()).toBe("DELETE");
    groups.splice(0);
    return route.fulfill({ status: 204 });
  });

  await page.goto("/shares");
  const groupSection = page.getByRole("region", { name: "共有グループ" });
  await expect(groupSection.getByRole("alert")).toBeVisible();
  await groupSection.getByRole("button", { name: "再試行" }).click();
  await expect(groupSection.getByText("共有グループはまだありません")).toBeVisible();
  await groupSection.getByRole("button", { name: "最初のグループを作成" }).click();
  await page.getByLabel("グループ名").fill("Project Editors");
  await page.getByPlaceholder("member@example.com").fill("alice@example.invalid");
  await page.getByRole("button", { name: "追加" }).click();
  await expect(page.getByText("1/100")).toBeVisible();
  await page.getByRole("button", { name: "グループを作成", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "Project Editors" });
  await expect(card.getByText("alice@example.invalid")).toBeVisible();
  await card.getByRole("button", { name: "名前とメンバーを編集" }).click();
  await page.getByLabel("グループ名").fill("Project Reviewers");
  await page.getByPlaceholder("member@example.com").fill("bob@example.invalid");
  await page.getByRole("button", { name: "追加" }).click();
  await page.getByRole("button", { name: "変更を保存" }).click();
  const renamed = page.getByRole("article").filter({ hasText: "Project Reviewers" });
  await expect(renamed.getByText("alice@example.invalid")).toBeVisible();
  await expect(renamed.getByText("bob@example.invalid")).toBeVisible();
  await renamed.getByRole("button", { name: "グループを無効化" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "グループを無効化", exact: true })
    .click();
  await expect(groupSection.getByText("共有グループはまだありません")).toBeVisible();
});

test("recipient creates bounded direct and known-group downstream shares", async ({ page }) => {
  let direct = structuredClone(directMount);
  const requests: { body: Record<string, unknown>; key: string | null }[] = [];
  await page.route("**/api/v1/groups", (route) => route.fulfill({ json: { groups: [] } }));
  await page.route("**/api/v1/shared-with-me", (route) =>
    route.fulfill({ json: { shares: [direct, groupMount] } }),
  );
  await page.route(/\/api\/v1\/shares(?:\/[^/?]+)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { shares: [] } });
    expect(request.method()).toBe("POST");
    requests.push({
      body: request.postDataJSON(),
      key: request.headers()["idempotency-key"] ?? null,
    });
    const authority = direct.reshareAuthority!;
    direct = {
      ...direct,
      reshareAuthority: {
        ...authority,
        currentFanout: authority.currentFanout + 1,
      },
    };
    return route.fulfill({
      status: 201,
      json: {
        id: `sh_child_${requests.length}`,
        kind: "internal",
        actions: request.postDataJSON().actions,
      },
    });
  });

  await page.goto("/shares");
  const card = page.getByRole("article").filter({ hasText: "共有プロジェクト" });
  await card.getByRole("button", { name: "再共有" }).click();
  const directDialog = page.getByRole("dialog");
  await expect(directDialog.getByLabel("有効期間（日）")).toHaveAttribute("max", "6");
  await directDialog.getByLabel("相手のメールアドレス").fill("next@example.invalid");
  await directDialog.getByLabel("作成", { exact: true }).uncheck();
  await directDialog.getByLabel("編集", { exact: true }).uncheck();
  await directDialog.getByLabel("有効期間（日）").fill("5");
  await directDialog.getByRole("button", { name: "再共有を作成" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]?.body).toEqual({
    kind: "internal",
    sourceShareId: "sh_direct",
    rootNodeId: "shared-root",
    spaceId: "owner-space",
    recipientEmail: "next@example.invalid",
    actions: ["read", "download"],
    ttlDays: 5,
  });
  expect(requests[0]?.key).toBeTruthy();

  await card.getByRole("button", { name: "再共有" }).click();
  const groupDialog = page.getByRole("dialog");
  await groupDialog.getByRole("button", { name: "既知のグループ" }).click();
  await groupDialog
    .getByLabel("共有元の所有者が管理する既知のグループ")
    .selectOption("group-engineering");
  await groupDialog.getByLabel("ダウンロード", { exact: true }).uncheck();
  await groupDialog.getByLabel("作成", { exact: true }).uncheck();
  await groupDialog.getByLabel("編集", { exact: true }).uncheck();
  await groupDialog.getByLabel("有効期間（日）").fill("3");
  await groupDialog.getByRole("button", { name: "再共有を作成" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.body).toEqual({
    kind: "internal",
    sourceShareId: "sh_direct",
    rootNodeId: "shared-root",
    spaceId: "owner-space",
    recipientGroupId: "group-engineering",
    actions: ["read"],
    ttlDays: 3,
  });
  expect(requests[1]?.key).toBeTruthy();
  expect(requests[1]?.key).not.toBe(requests[0]?.key);
  await expect(card.getByRole("button", { name: "再共有" })).toHaveCount(0);
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

test("recipient reshare controls fail closed when policy authority becomes stale", async ({
  page,
}) => {
  let current = structuredClone(directMount);
  await page.route("**/api/v1/shares", (route) => route.fulfill({ json: { shares: [] } }));
  await page.route("**/api/v1/groups", (route) => route.fulfill({ json: { groups: [] } }));
  await page.route("**/api/v1/shared-with-me", (route) =>
    route.fulfill({ json: { shares: [current] } }),
  );
  await page.goto("/shares");
  const card = page.getByRole("article").filter({ hasText: "共有プロジェクト" });
  await card.getByRole("button", { name: "再共有" }).click();
  current = {
    ...current,
    shareVersion: 2,
    actions: ["read"],
    reshareAuthority: null,
  };
  await page.getByLabel("相手のメールアドレス").fill("next@example.invalid");
  await page.getByRole("button", { name: "再共有を作成" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "再共有" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("アクセスが変更されました");
});
