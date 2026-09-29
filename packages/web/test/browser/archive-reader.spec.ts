import { expect, type Page, test } from "@playwright/test";
import { archiveFixture } from "../../../worker/test/fixtures/archive";
import { imageBytes } from "../../../worker/test/fixtures/images/encoded";
import { searchFiles } from "./fileHelpers";
import { login } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(240000);
async function uploadBook(page: Page) {
  const bytes = archiveFixture([
    { name: "page10.avif", content: imageBytes("red.avif"), method: 8 },
    { name: "page2.png", content: imageBytes("red.png"), method: 8 },
    {
      name: "page20.jpg",
      content: new TextEncoder().encode("<script>window.archiveScript=true</script>"),
    },
  ]).bytes;
  return page.evaluate(async (encoded) => {
    const json = async (path: string, init?: RequestInit) => {
      const r = await fetch(path, init);
      if (!r.ok) throw new Error(`fixture_${r.status}_${path}`);
      return r.json();
    };
    const me = await json("/api/v1/me"),
      { token } = await json("/api/v1/csrf", { method: "POST" });
    const name = `書籍-${crypto.randomUUID().slice(0, 8)}.cbz`,
      headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": crypto.randomUUID(),
      };
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const receipt = await json("/api/v1/uploads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        mode: "single",
        spaceId: me.spaceId,
        parentId: me.rootNodeId,
        name,
        declared_size: bytes.length,
      }),
    });
    await json(`/api/v1/uploads/${receipt.id}/content`, {
      method: "PUT",
      headers: { "Upload-Capability": receipt.capability },
      body: bytes,
    });
    const op = await json(`/api/v1/uploads/${receipt.id}/complete`, {
      method: "POST",
      headers: { ...headers, "Upload-Capability": receipt.capability },
      body: "{}",
    });
    const consumed = await json(`/__test__/dead-letter-dispatch/${op.id}_event`, {
      method: "POST",
    });
    if (consumed.acked !== 1) throw new Error("fixture_index_failed");
    return { name, nodeId: op.result.nodeId as string };
  }, Buffer.from(bytes).toString("base64"));
}
async function decoded(page: Page, n: number) {
  const image = page.getByRole("dialog").getByRole("img", { name: `${n}ページ`, exact: true });
  await expect(image).toHaveAttribute("src", new RegExp(`/pages/${n}$`));
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  return image;
}
test("Files reads natural PNG/AVIF pages, rejects a disguised script, and closes the reader", async ({
  page,
}, info) => {
  await login(page);
  const book = await uploadBook(page);
  await page.goto("/files");
  await searchFiles(page, book.name);
  await page.getByRole("button", { name: `${book.name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "ファイルを開く・保存", exact: true }).click();
  await decoded(page, 1);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await decoded(page, 2);
  await page.screenshot({ path: info.outputPath("private-reader.png") });
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "このページを表示できません",
  );
  expect(await page.evaluate(() => "archiveScript" in window)).toBe(false);
  await page.getByRole("spinbutton", { name: "ページ番号" }).fill("1");
  await decoded(page, 1);
  await page.getByRole("button", { name: "書籍を閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a public read link displays the same reader on mobile and loses access after revocation", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const book = await uploadBook(page);
  const share = await page.evaluate(async (nodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId: nodeId, role: "read" }),
    });
    if (!response.ok) throw new Error(`share_${response.status}`);
    return response.json();
  }, book.nodeId);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  try {
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
    await openPublic(guest, `https://app.ncf.test:8879/s/${share.id}#${share.secret}`, book.name);
    await guest.getByRole("button", { name: `${book.name}を読む` }).click();
    await decoded(guest, 1);
    await guest.getByRole("button", { name: "次のページ", exact: true }).click();
    await decoded(guest, 2);
    await guest.screenshot({ path: info.outputPath("public-reader-mobile.png") });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const status = await page.evaluate(async (id) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      return (
        await fetch(`/api/v1/shares/${id}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "If-Match": '"share-1"',
          },
        })
      ).status;
    }, share.id);
    expect(status).toBe(200);
    await guest.getByRole("button", { name: "再読み込み", exact: true }).click();
    await expect(guest.getByRole("dialog").getByRole("alert")).toBeVisible();
    await expect(guest.getByRole("dialog").locator("img")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("an internal read-share recipient opens a book within the selected share", async ({
  page,
  browser,
}) => {
  await login(page);
  const book = await uploadBook(page);
  const share = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const r = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({
        kind: "internal",
        rootNodeId,
        role: "read",
        recipients: ["recipient@example.invalid"],
      }),
    });
    if (!r.ok) throw new Error(`share_${r.status}`);
    return r.json();
  }, book.nodeId);
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
  });
  try {
    await context.addCookies([
      {
        name: "ncf-test-user",
        value: "recipient",
        domain: ".ncf.test",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
    const viewer = await context.newPage();
    await viewer.goto(`/shared/${share.id}`);
    await viewer.locator("button.shared-entry").filter({ hasText: book.name }).click();
    await decoded(viewer, 1);
    await viewer.getByRole("button", { name: "次のページ", exact: true }).click();
    await decoded(viewer, 2);
    await viewer.getByRole("button", { name: "書籍を閉じる" }).click();
    await expect(viewer.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
