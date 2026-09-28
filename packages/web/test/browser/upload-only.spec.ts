import { open, writeFile } from "node:fs/promises";
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";
import type { FileNode } from "../../src/lib/api";
import { searchFiles } from "./fileHelpers";
import { fileContent, rootFile, writeTestFile } from "./uploadHelpers";

test.setTimeout(180000);
async function setup(owner: Page, browser: Browser, limit = 536870912000) {
  await owner.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await owner.goto("/files");
  const name = `受信-${crypto.randomUUID().slice(0, 8)}.txt`;
  const original = await writeTestFile(owner, name, "private original");
  const link = await owner.evaluate(async (limit) => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const r = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        kind: "upload_only",
        rootNodeId: me.rootNodeId,
        reservationLimit: limit,
      }),
    });
    if (r.status !== 201) throw new Error(`create_${r.status}`);
    return r.json() as Promise<{ id: string; secret: string }>;
  }, limit);
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
  const guest = await context.newPage();
  await guest.goto(`https://app.ncf.test:8879/s/${link.id}#${link.secret}`);
  for (let n = 0; n < 3; n++) {
    const ready = guest.getByRole("button", { name: "ファイルを選んで送信", exact: true });
    const unlock = guest.getByRole("button", { name: /共有を開く|秒後に再試行できます/ });
    await expect(ready.or(unlock)).toBeVisible({ timeout: 60000 });
    if (await ready.isVisible()) break;
    await expect(unlock).toBeEnabled({ timeout: 70000 });
    await unlock.click();
  }
  await expect(guest.getByRole("heading", { name: "ファイルを送信", exact: true })).toBeVisible();
  return { guest, context, name, original, link };
}
async function choose(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
) {
  await page.getByRole("button", { name: "ファイルを選んで送信", exact: true }).click();
  await page.getByLabel("送信するファイル", { exact: true }).setInputFiles(file);
  await page.getByRole("button", { name: "アップロードを開始", exact: true }).click();
}
const completed = (page: Page) => page.getByText(/送信が完了しました。受付番号: up_/);
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

test("mobile sender receives an opaque receipt, hides owner files and preserves same-name contents", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser);
  try {
    const bodies: unknown[] = [];
    const paths: string[] = [];
    t.guest.on("request", (r) => {
      paths.push(new URL(r.url()).pathname);
      if (r.method() === "POST" && r.url().endsWith("/uploads")) bodies.push(r.postDataJSON());
    });
    await expect(t.guest.getByText(t.name, { exact: true })).toHaveCount(0);
    await expect(
      t.guest.getByRole("button", { name: /開く・保存|上書き|新規フォルダー|名前を変更|ごみ箱/ }),
    ).toHaveCount(0);
    for (const value of ["received one", "received two"]) {
      await choose(t.guest, { name: t.name, mimeType: "text/plain", buffer: Buffer.from(value) });
      await expect(completed(t.guest)).toBeVisible();
    }
    expect(bodies).toEqual(
      ["received one", "received two"].map((v) => ({
        mode: "single",
        name: t.name,
        declared_size: v.length,
      })),
    );
    expect(paths.some((p) => /\/children\/|\/nodes\/|\/api\/v1\/operations\//.test(p))).toBe(false);
    const nodes = await page.evaluate(async (name) => {
      const me = await fetch("/api/v1/me").then((r) => r.json());
      const result = await fetch(`/api/v1/nodes/${me.rootNodeId}/children`).then((r) => r.json());
      return result.children.filter((n: FileNode) =>
        n.name.startsWith(name.slice(0, -4)),
      ) as FileNode[];
    }, t.name);
    expect(nodes).toHaveLength(3);
    expect(new Set(nodes.map((n) => n.name)).size).toBe(3);
    const values = [];
    for (const node of nodes) values.push(await fileContent(page, node));
    expect(values.sort()).toEqual(["private original", "received one", "received two"]);
    expect(await t.guest.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await t.guest.screenshot({ path: "/tmp/ncf-upload-only-mobile.png", fullPage: true });
  } finally {
    await t.context.close();
  }
});

test("lost creation and completion survive reload without duplicating content", async ({
  page,
  browser,
}, info) => {
  const t = await setup(page, browser);
  try {
    const path = info.outputPath("再開.txt");
    await writeFile(path, "receipt recovery");
    const keys: string[] = [];
    let puts = 0,
      completes = 0;
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
    await t.guest.route("**/api/v1/public/shares/*/uploads/*/complete", async (route) => {
      completes++;
      const response = await localFetch(route);
      expect(response.status()).toBe(201);
      await route.abort("connectionfailed");
    });
    await choose(t.guest, path);
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible();
    await t.guest.reload();
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(t.guest.getByRole("button", { name: "再開する", exact: true })).toBeEnabled();
    expect(keys).toEqual([keys[0], keys[0]]);
    expect(puts).toBe(0);
    await t.guest.getByLabel("再開する元のファイル", { exact: true }).setInputFiles(path);
    await t.guest.getByRole("button", { name: "再開する", exact: true }).click();
    await expect(t.guest.getByText(/送信結果を確認できません/)).toBeVisible();
    await t.guest.reload();
    await t.guest.getByRole("button", { name: "結果を確認", exact: true }).click();
    await expect(completed(t.guest)).toBeVisible();
    expect(puts).toBe(1);
    expect(completes).toBe(1);
    expect(await fileContent(page, await rootFile(page, "再開.txt"))).toBe("receipt recovery");
  } finally {
    await t.context.close();
  }
});

test("multipart receipt resumes after reload without resending a confirmed part", async ({
  page,
  browser,
}, info) => {
  const t = await setup(page, browser);
  try {
    const name = `受信分割-${crypto.randomUUID().slice(0, 8)}.bin`,
      path = info.outputPath(name),
      file = await open(path, "w");
    await file.write(Buffer.from("receipt multipart fixture"));
    await file.truncate(96 * 1024 * 1024 + 37);
    await file.close();
    let first = 0,
      creates = 0;
    const attempts: string[] = [];
    t.guest.on("request", (r) => {
      if (r.url().endsWith("/parts/1")) first++;
      if (r.method() === "POST" && r.url().endsWith("/uploads")) creates++;
    });
    await t.guest.route("**/api/v1/public/shares/*/uploads/*/parts/2", async (route) => {
      attempts.push(route.request().headers()["upload-attempt-id"]!);
      if (attempts.length === 1) await route.abort("connectionfailed");
      else await route.continue();
    });
    await choose(t.guest, path);
    await expect(t.guest.getByRole("button", { name: "結果を確認", exact: true })).toBeVisible({
      timeout: 90000,
    });
    await t.guest.reload();
    await t.guest.getByLabel("再開する元のファイル", { exact: true }).setInputFiles(path);
    await t.guest.getByRole("button", { name: "再開する", exact: true }).click();
    await expect(completed(t.guest)).toBeVisible({ timeout: 90000 });
    expect(first).toBe(1);
    expect(creates).toBe(1);
    expect(attempts).toEqual([attempts[0], attempts[0]]);
    const node = await rootFile(page, name);
    expect(node.size).toBe(96 * 1024 * 1024 + 37);
    expect(await fileContent(page, node, "bytes=0-24")).toBe("receipt multipart fixture");
  } finally {
    await t.context.close();
  }
});

test("owner manages a bounded password-protected receiving link from a folder", async ({
  page,
}) => {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
  const name = `受け取り先-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await searchFiles(page, name);
  await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "受け取りリンクを管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "受け取りリンクを管理", exact: true });
  await dialog.getByLabel("同時送信の上限容量（MiB）", { exact: true }).fill("10");
  await dialog.getByLabel("パスワード（任意）", { exact: true }).fill("受信パスワード");
  await dialog.getByRole("button", { name: "受け取りリンクを作成", exact: true }).click();
  await expect(dialog.getByLabel("共有URL", { exact: true })).toHaveValue(
    /\/s\/[^#]+#[A-Za-z0-9_-]{43}$/,
  );
  await expect(dialog.getByText("パスワードあり", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "設定を変更", exact: true }).click();
  await dialog.getByLabel("同時送信の上限容量（MiB）", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "リンク設定を保存", exact: true }).click();
  await expect(dialog.getByText(/同時送信の上限: 0 MiB/)).toBeVisible();
  await dialog.getByRole("button", { name: "リンクを停止", exact: true }).click();
  await dialog.getByRole("button", { name: "停止する", exact: true }).click();
  await expect(dialog.getByText("公開リンクはありません。", { exact: true })).toBeVisible();
});

test("zero-byte receipts succeed at zero allowance and an oversized upload dispatches no bytes", async ({
  page,
  browser,
}) => {
  const t = await setup(page, browser, 0);
  try {
    const name = `empty-${crypto.randomUUID().slice(0, 8)}.txt`;
    await choose(t.guest, { name, mimeType: "text/plain", buffer: Buffer.alloc(0) });
    await expect(completed(t.guest)).toBeVisible();
    expect((await rootFile(page, name)).size).toBe(0);
    let writes = 0;
    t.guest.on("request", (r) => {
      if (r.method() === "PUT") writes++;
    });
    await choose(t.guest, {
      name: "too-big.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("abc"),
    });
    await expect(
      t.guest.getByText("保存先の空き容量が不足しています。共有した方に確認してください。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(writes).toBe(0);
  } finally {
    await t.context.close();
  }
});
