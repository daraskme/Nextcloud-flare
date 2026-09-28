import { open, writeFile } from "node:fs/promises";
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";
import { fileContent, rootFile, writeTestFile } from "./uploadHelpers";

test.setTimeout(180000);
async function setup(owner: Page, browser: Browser, fileOnly = false, role = "edit") {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  const name = `公開送信-${crypto.randomUUID().slice(0, 8)}.txt`;
  const node = fileOnly ? await writeTestFile(owner, name, "before") : null;
  const link = await owner.evaluate(
    async ({ node, role }) => {
      const me = await fetch("/api/v1/me").then((r) => r.json());
      const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const response = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        body: JSON.stringify({ kind: "link", rootNodeId: node?.id ?? me.rootNodeId, role }),
      });
      if (response.status !== 201) throw new Error(`link_create_${response.status}`);
      return response.json() as Promise<{ id: string; secret: string }>;
    },
    { node, role },
  );
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: "ncf-test-user",
      value: "anonymous",
      domain: ".ncf.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const guest = await context.newPage(),
    url = `https://app.ncf.test:8879/s/${link.id}#${link.secret}`;
  await guest.goto(url);
  for (let i = 0; i < 3; i++) {
    const ready = guest.getByRole("button", { name: "共有を閉じる", exact: true });
    const unlock = guest.getByRole("button", { name: /共有を開く|秒後に再試行できます/ });
    await expect(ready.or(unlock)).toBeVisible({ timeout: 60000 });
    if (await ready.isVisible()) break;
    await expect(unlock).toBeEnabled({ timeout: 70000 });
    await unlock.click();
  }
  await expect(guest.getByRole("button", { name: "共有を閉じる", exact: true })).toBeVisible();
  return { context, guest, url, link, node, name };
}
async function localFetch(route: Route) {
  return route.fetch({
    url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
    headers: {
      ...(await route.request().allHeaders()),
      host: "app.ncf.test:8879",
      "sec-fetch-site": "same-origin",
    },
  });
}
async function choose(page: Page, name: string, value: string, overwrite?: string) {
  await page
    .getByRole("button", { name: overwrite ? `${overwrite}を上書き` : "アップロード", exact: true })
    .click();
  await page
    .getByLabel(overwrite ? "上書きするファイル" : "送信するファイル", { exact: true })
    .setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(value),
    });
}
const stored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("ncf-public-uploads");
        request.onerror = () => reject(new Error("db failed"));
        request.onsuccess = () => {
          const db = request.result,
            rows = db.transaction("uploads").objectStore("uploads").count();
          rows.onsuccess = () => {
            resolve(rows.result);
            db.close();
          };
          rows.onerror = () => reject(new Error("read failed"));
        };
      }),
  );

test("guest uploads and confirms an overwrite on mobile, retaining the destination name", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await choose(t.guest, t.name, "new public content");
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await expect(
      t.guest.getByRole("button", { name: `${t.name}を上書き`, exact: true }),
    ).toBeEnabled();
    expect(await fileContent(page, await rootFile(page, t.name))).toBe("new public content");
    await choose(t.guest, "別名の原稿.txt", "replaced public content", t.name);
    await expect(
      t.guest.getByText(`「${t.name}」の内容を置き換えます。保存先の名前は変わりません。`),
    ).toBeVisible();
    await t.guest.screenshot({ path: "/tmp/ncf-public-upload-ui-mobile.png", fullPage: true });
    expect(await t.guest.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await t.guest.getByRole("button", { name: "上書きを開始", exact: true }).click();
    await expect(
      t.guest.getByRole("button", { name: `${t.name}を上書き`, exact: true }),
    ).toBeEnabled();
    expect(await fileContent(page, await rootFile(page, t.name))).toBe("replaced public content");
    await expect.poll(() => stored(t.guest)).toBe(0);
  } finally {
    await t.context.close();
  }
});
test("direct-file sharing supports an overwrite without a parent operand", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser, true);
  try {
    const creates: Record<string, unknown>[] = [];
    t.guest.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/uploads"))
        creates.push(r.postDataJSON());
    });
    await expect(t.guest.getByRole("button", { name: "アップロード", exact: true })).toHaveCount(0);
    await choose(t.guest, "内容だけ置換.txt", "replacement", t.name);
    await t.guest.getByRole("button", { name: "上書きを開始", exact: true }).click();
    await expect(
      t.guest.getByRole("button", { name: `${t.name}を上書き`, exact: true }),
    ).toBeEnabled();
    expect(creates).toHaveLength(1);
    expect(creates[0]).not.toHaveProperty("parentId");
    expect(creates[0]).toMatchObject({
      targetId: t.node!.id,
      targetRevision: t.node!.revision,
      name: t.name,
    });
    expect(await fileContent(page, await rootFile(page, t.name))).toBe("replacement");
  } finally {
    await t.context.close();
  }
});
test("lost reservation survives reload and reuses its original key only on explicit confirmation", async ({
  page,
  browser,
}, info) => {
  const t = await setup(page, browser);
  try {
    const path = info.outputPath(t.name);
    await writeFile(path, "retry reservation");
    const keys: string[] = [];
    let puts = 0;
    t.guest.on("request", (r) => {
      if (r.method() === "PUT") puts++;
    });
    await t.guest.route("**/api/v1/public/shares/*/uploads", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      const response = await localFetch(route);
      expect(response.status()).toBe(201);
      if (keys.length === 1) await route.abort("connectionfailed");
      else await route.fulfill({ response });
    });
    await t.guest.getByRole("button", { name: "アップロード", exact: true }).click();
    await t.guest.getByLabel("送信するファイル", { exact: true }).setInputFiles(path);
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    expect(keys).toHaveLength(1);
    expect(puts).toBe(0);
    await t.guest.reload();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    expect(keys).toHaveLength(1);
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "再開する", exact: true })).toBeVisible();
    expect(keys).toEqual([keys[0], keys[0]]);
    expect(puts).toBe(0);
    await t.guest.getByLabel("再開する元のファイル", { exact: true }).setInputFiles(path);
    await t.guest.getByRole("button", { name: "再開する", exact: true }).click();
    await expect(
      t.guest.getByRole("button", { name: `${t.name}を上書き`, exact: true }),
    ).toBeEnabled();
    expect(puts).toBe(1);
    expect(keys).toHaveLength(2);
    expect(await fileContent(page, await rootFile(page, t.name))).toBe("retry reservation");
  } finally {
    await t.context.close();
  }
});
test("lost completion is read back after reload without another PUT or completion POST", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    let puts = 0,
      completes = 0;
    t.guest.on("request", (r) => {
      if (r.method() === "PUT") puts++;
    });
    await t.guest.route("**/api/v1/public/shares/*/uploads/*/complete", async (route) => {
      completes++;
      const response = await localFetch(route);
      expect(response.status()).toBe(200);
      await route.abort("connectionfailed");
    });
    await choose(t.guest, t.name, "completed once");
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    await t.guest.reload();
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toHaveCount(0);
    expect(puts).toBe(1);
    expect(completes).toBe(1);
    expect(await fileContent(page, await rootFile(page, t.name))).toBe("completed once");
    expect(await stored(t.guest)).toBe(0);
  } finally {
    await t.context.close();
  }
});
test("multipart reload skips the completed part and retains the original unreceived attempt", async ({
  page,
  browser,
}, info) => {
  const t = await setup(page, browser);
  try {
    const path = info.outputPath("公開分割送信.bin"),
      file = await open(path, "w");
    await file.write(Buffer.from("public multipart fixture"));
    await file.truncate(96 * 1024 * 1024 + 37);
    await file.close();
    let creates = 0,
      first = 0;
    const attempts: string[] = [];
    t.guest.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/uploads")) creates++;
      if (r.url().endsWith("/parts/1")) first++;
    });
    await t.guest.route("**/api/v1/public/shares/*/uploads/*/parts/2", async (route) => {
      attempts.push(route.request().headers()["upload-attempt-id"]!);
      if (attempts.length === 1) await route.abort("connectionfailed");
      else await route.continue();
    });
    await t.guest.getByRole("button", { name: "アップロード", exact: true }).click();
    await t.guest.getByLabel("送信するファイル", { exact: true }).setInputFiles(path);
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible({
      timeout: 90000,
    });
    await t.guest.reload();
    await t.guest.getByLabel("再開する元のファイル", { exact: true }).setInputFiles({
      name: "異なる.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("wrong"),
    });
    await t.guest.getByRole("button", { name: "再開する", exact: true }).click();
    await expect(
      t.guest.getByText("名前・サイズ・更新日時・内容が一致する元のファイルを選択してください。"),
    ).toBeVisible();
    expect(attempts).toHaveLength(1);
    await t.guest.getByLabel("再開する元のファイル", { exact: true }).setInputFiles(path);
    await t.guest.getByRole("button", { name: "再開する", exact: true }).click();
    await expect(
      t.guest.getByRole("button", { name: "公開分割送信.binを上書き", exact: true }),
    ).toBeEnabled({ timeout: 90000 });
    expect(creates).toBe(1);
    expect(first).toBe(1);
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    const node = await rootFile(page, "公開分割送信.bin");
    expect(node.size).toBe(96 * 1024 * 1024 + 37);
    expect(await fileContent(page, node, "bytes=0-23")).toBe("public multipart fixture");
    expect(await stored(t.guest)).toBe(0);
  } finally {
    await t.context.close();
  }
});
test("an interrupted transfer can be cancelled, and logout clears pending local capabilities", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    await t.guest.route("**/api/v1/public/shares/*/uploads/*/content", (route) =>
      route.abort("connectionfailed"),
    );
    await choose(t.guest, t.name, "will cancel");
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await t.guest.getByRole("button", { name: "送信を中止", exact: true }).click();
    await expect(
      t.guest.getByText("中止を受け付けました。使用容量は回収後に反映されます。"),
    ).toBeVisible();
    expect(await stored(t.guest)).toBe(0);
    await expect(
      t.guest.getByRole("button", { name: `${t.name}を上書き`, exact: true }),
    ).toHaveCount(0);
    await choose(t.guest, t.name, "will log out");
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    expect(await stored(t.guest)).toBe(1);
    await t.guest.getByRole("button", { name: "共有を閉じる", exact: true }).click();
    await expect.poll(() => stored(t.guest)).toBe(0);
  } finally {
    await t.context.close();
  }
});
test("read-only public links expose no upload or overwrite controls", async ({ page, browser }) => {
  const t = await setup(page, browser, true, "read");
  try {
    await expect(t.guest.getByRole("button", { name: /アップロード|上書き|ごみ箱/ })).toHaveCount(
      0,
    );
  } finally {
    await t.context.close();
  }
});
test("a delayed upload response cannot restore local capabilities after another tab logs out", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    // Model a suspended tab that has not received the logout broadcast yet.
    await t.guest.addInitScript(() => {
      Object.defineProperty(BroadcastChannel.prototype, "onmessage", { set() {} });
    });
    await t.guest.reload();
    await expect(t.guest.getByRole("button", { name: "共有を閉じる", exact: true })).toBeEnabled();
    const other = await t.context.newPage();
    await other.goto(t.url);
    await expect(other.getByRole("button", { name: "共有を閉じる", exact: true })).toBeEnabled();
    let received = false,
      puts = 0;
    t.guest.on("request", (r) => {
      if (r.method() === "PUT") puts++;
    });
    await t.guest.route("**/api/v1/public/shares/*/uploads", async (route) => {
      const response = await localFetch(route);
      expect(response.status()).toBe(201);
      received = true;
      await delayed;
      await route.fulfill({ response });
    });
    await choose(t.guest, t.name, "late receipt");
    await t.guest.getByRole("button", { name: "アップロードを開始", exact: true }).click();
    await expect.poll(() => received).toBe(true);
    expect(await stored(t.guest)).toBe(1);
    await other.reload();
    await expect(other.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    other.once("dialog", (dialog) => dialog.accept());
    await other.getByRole("button", { name: "記録を削除", exact: true }).click();
    await expect(
      other.getByText("別のタブで送信中です。一時停止してから記録を削除してください。"),
    ).toBeVisible();
    expect(await stored(t.guest)).toBe(1);
    await other.getByRole("button", { name: "共有を閉じる", exact: true }).click();
    await expect(
      other.getByText("共有を閉じました。もう一度開くには、共有リンクからアクセスしてください。"),
    ).toBeVisible();
    await expect.poll(() => stored(t.guest)).toBe(0);
    release();
    await expect(
      t.guest.getByText("転送記録を保存できません。時間をおいて再確認してください。"),
    ).toBeVisible();
    expect(await stored(t.guest)).toBe(0);
    expect(puts).toBe(0);
  } finally {
    release();
    await t.context.close();
  }
});
