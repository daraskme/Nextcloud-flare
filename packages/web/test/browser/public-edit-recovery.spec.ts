import { expect, type Page, test } from "@playwright/test";
import { create, localFetch, open, setup } from "./publicShareHelpers";

test.setTimeout(180000);
async function journal(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ncf-public-edits", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ records: unknown[]; closed: IDBValidKey[] }>((resolve, reject) => {
        const tx = db.transaction(["edits", "closed_sessions"], "readonly");
        const records = tx.objectStore("edits").getAll(),
          closed = tx.objectStore("closed_sessions").getAllKeys();
        tx.oncomplete = () => resolve({ records: records.result, closed: closed.result });
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
const pending = (page: Page) => page.getByRole("button", { name: "結果を確認", exact: true });
for (const method of ["POST", "PATCH", "DELETE"] as const) {
  test(`lost ${method} resumes after reload with its original key, body and share session`, async ({
    page,
    browser,
  }) => {
    const t = await setup(page, browser);
    try {
      await create(t.guest, "元の対象");
      await expect(t.guest.getByRole("button", { name: "元の対象", exact: true })).toBeVisible();
      if (method === "POST")
        await t.guest.getByRole("button", { name: "元の対象", exact: true }).click();
      const calls: {
        method: string;
        key: string | undefined;
        session: string | undefined;
        body: unknown;
        url: string;
      }[] = [];
      await t.guest.route("**/api/v1/public/shares/*/nodes{,/*}", async (route) => {
        if (route.request().method() !== method) return route.continue();
        calls.push({
          method,
          key: route.request().headers()["idempotency-key"],
          session: route.request().headers()["share-session"],
          body: route.request().postDataJSON(),
          url: route.request().url(),
        });
        const response = await localFetch(route);
        expect(response.status()).toBe(method === "POST" ? 201 : 200);
        if (calls.length === 1) await route.abort("connectionfailed");
        else await route.fulfill({ response });
      });
      if (method === "POST") await create(t.guest, "一度だけ作成");
      else if (method === "PATCH") {
        await t.guest.getByRole("button", { name: "元の対象の名前を変更", exact: true }).click();
        await t.guest.getByLabel("名前", { exact: true }).fill("一度だけ改名");
        await t.guest.getByRole("button", { name: "名前を保存", exact: true }).click();
      } else {
        await t.guest.getByRole("button", { name: "元の対象をごみ箱へ移動", exact: true }).click();
        await t.guest.getByRole("button", { name: "ごみ箱へ移動する", exact: true }).click();
      }
      await expect(pending(t.guest)).toBeEnabled();
      const before = await journal(t.guest);
      expect(before.records).toHaveLength(1);
      expect(JSON.stringify(before)).not.toContain(new URL(t.url).hash.slice(1));
      await t.guest.reload();
      await expect(pending(t.guest)).toBeEnabled();
      expect(calls).toHaveLength(1);
      expect((await journal(t.guest)).records).toEqual(before.records);
      await expect(
        t.guest.getByRole("button", { name: "新規フォルダー", exact: true }),
      ).toBeDisabled();
      if (method !== "DELETE")
        await expect(t.guest.getByLabel("名前", { exact: true })).toBeDisabled();
      await t.guest.screenshot({
        path: `/tmp/ncf-public-edit-recovery-${method.toLowerCase()}.png`,
        fullPage: true,
      });
      expect(await t.guest.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await pending(t.guest).click();
      await expect.poll(async () => (await journal(t.guest)).records.length).toBe(0);
      await expect(pending(t.guest)).toHaveCount(0);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      await expect.poll(async () => (await journal(t.guest)).records.length).toBe(0);
      if (method === "POST") {
        await t.guest.getByRole("button", { name: "元の対象", exact: true }).click();
        await expect(
          t.guest.getByRole("button", { name: "一度だけ作成", exact: true }),
        ).toHaveCount(1);
      } else if (method === "PATCH")
        await expect(
          t.guest.getByRole("button", { name: "一度だけ改名", exact: true }),
        ).toHaveCount(1);
      else {
        await expect(t.guest.getByRole("button", { name: "元の対象", exact: true })).toHaveCount(0);
        await page.goto("/trash");
        await expect(page.getByRole("article").filter({ hasText: "元の対象" })).toHaveCount(1);
      }
    } finally {
      await t.context.close();
    }
  });
}

test("a persisted operation ID is checked after reload without resending POST", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    let writes = 0,
      reads = 0;
    await t.guest.route("**/api/v1/public/shares/*/nodes", async (route) => {
      writes++;
      const response = await localFetch(route),
        { id } = await response.json();
      expect(response.status()).toBe(201);
      await route.fulfill({
        status: 503,
        headers: { "Content-Type": "application/problem+json", "Operation-Id": id },
        body: JSON.stringify({ title: "commit_unknown" }),
      });
    });
    await t.guest.route("**/api/v1/operations/*", async (route) => {
      reads++;
      await route.continue();
    });
    await create(t.guest, "照会だけで再開");
    await expect(pending(t.guest)).toBeEnabled();
    const rows = await journal(t.guest);
    expect(rows.records[0]).toMatchObject({
      operationId: expect.stringMatching(/^op_[a-f0-9]{64}$/),
    });
    await t.guest.reload();
    await expect(pending(t.guest)).toBeEnabled();
    expect({ writes, reads }).toEqual({ writes: 1, reads: 0 });
    await pending(t.guest).click();
    await expect.poll(async () => (await journal(t.guest)).records.length).toBe(0);
    await expect(pending(t.guest)).toHaveCount(0);
    expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
    await expect(t.guest.getByRole("button", { name: "照会だけで再開", exact: true })).toHaveCount(
      1,
    );
  } finally {
    await t.context.close();
  }
});

test("failed durable storage dispatches no edit and keeps recovery errors visible", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await expect(
      t.guest.getByRole("button", { name: "新規フォルダー", exact: true }),
    ).toBeEnabled();
    await t.guest.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        ...args: Parameters<IDBDatabase["transaction"]>
      ) {
        if (this.name === "ncf-public-edits" && args[1] === "readwrite")
          throw new DOMException("storage disabled", "SecurityError");
        return original.apply(this, args);
      };
    });
    let writes = 0;
    t.guest.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/nodes")) writes++;
    });
    await create(t.guest, "保存できない操作");
    await expect(
      t.guest.getByRole("button", { name: "確認記録を再読込", exact: true }),
    ).toBeVisible();
    expect(writes).toBe(0);
    await t.guest.reload();
    await expect(
      t.guest.getByRole("button", { name: "新規フォルダー", exact: true }),
    ).toBeEnabled();
    await expect(pending(t.guest)).toHaveCount(0);
    await expect(
      t.guest.getByRole("button", { name: "保存できない操作", exact: true }),
    ).toHaveCount(0);
  } finally {
    await t.context.close();
  }
});

test("two tabs cannot replay one journal concurrently and both observe its completion", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  let release!: () => void;
  try {
    let writes = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await t.context.route("**/api/v1/public/shares/*/nodes", async (route) => {
      writes++;
      const response = await localFetch(route);
      if (writes === 1) await route.abort("failed");
      else {
        await held;
        await route.fulfill({ response });
      }
    });
    await create(t.guest, "別タブでも一度");
    await expect(pending(t.guest)).toBeEnabled();
    const other = await t.context.newPage();
    await other.goto(t.url);
    await expect(pending(other)).toBeEnabled();
    await pending(t.guest).click();
    await expect.poll(() => writes).toBe(2);
    await pending(other).click();
    await expect(other.getByRole("alert")).toContainText("別のタブ");
    expect(writes).toBe(2);
    release();
    await expect(pending(t.guest)).toHaveCount(0);
    await expect(pending(other)).toHaveCount(0);
    await expect(other.getByRole("button", { name: "新規フォルダー", exact: true })).toBeEnabled();
  } finally {
    release?.();
    await t.context.close();
  }
});

test("logout removes pending edits and a late mutation response cannot restore them", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  let release!: () => void;
  try {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted = false;
    await t.guest.route("**/api/v1/public/shares/*/nodes", async (route) => {
      const response = await localFetch(route);
      expect(response.status()).toBe(201);
      accepted = true;
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await create(t.guest, "遅い応答");
    await expect.poll(() => accepted).toBe(true);
    const before = await journal(t.guest);
    expect(before.records).toHaveLength(1);
    const other = await t.context.newPage();
    await other.goto(t.url);
    await expect(pending(other)).toBeVisible();
    await other.getByRole("button", { name: "共有を閉じる", exact: true }).click();
    await expect(t.guest.getByText(/共有を閉じました/)).toBeVisible();
    await expect.poll(async () => (await journal(t.guest)).records.length).toBe(0);
    release();
    await expect.poll(async () => (await journal(other)).closed.length).toBe(1);
    expect((await journal(t.guest)).records).toHaveLength(0);
    await expect(pending(t.guest)).toHaveCount(0);
  } finally {
    release?.();
    await t.context.close();
  }
});

test("a new share session never adopts the old journal and a stale tab cannot erase its successor", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    let writes = 0;
    await t.context.route("**/api/v1/public/shares/*/nodes", async (route) => {
      writes++;
      const response = await localFetch(route);
      expect(response.status()).toBe(201);
      await route.abort("failed");
    });
    await create(t.guest, "古い操作");
    await expect(pending(t.guest)).toBeEnabled();
    await t.context.clearCookies({ name: /^__Host-ncf_(?:share|unlock)_/ });
    const other = await t.context.newPage();
    await open(other, t.url, t.name);
    await expect(other.getByRole("button", { name: "新規フォルダー", exact: true })).toBeEnabled();
    await expect(pending(other)).toHaveCount(0);
    expect(writes).toBe(1);
    await create(other, "新しい操作");
    await expect(pending(other)).toBeEnabled();
    const records = (await journal(other)).records;
    expect(records).toHaveLength(2);
    await t.guest.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(pending(t.guest)).toBeEnabled();
    expect((await journal(t.guest)).records).toEqual(records);
    expect(writes).toBe(2);
    await expect(other.getByLabel("名前", { exact: true })).toHaveValue("新しい操作");
    t.guest.once("dialog", (dialog) => dialog.accept());
    await t.guest.getByRole("button", { name: "記録を削除", exact: true }).click();
    await expect.poll(async () => (await journal(other)).records.length).toBe(1);
    await expect(pending(other)).toBeEnabled();
  } finally {
    await t.context.close();
  }
});
