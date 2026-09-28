import { type Browser, expect, type Page, test } from "@playwright/test";
import { searchFiles } from "./fileHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180_000);
async function setup(page: Page) {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
  const name = `ZIP資料-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await searchFiles(page, name);
  await page.getByRole("button", { name: `${name} フォルダー`, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "アップロード", exact: true }).click();
  await (await chooser).setFiles({
    name: "メモ.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("ZIP browser download\n"),
  });
  await expect(page.getByText("アップロード完了", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "新規フォルダー", exact: true }).click();
  await page.getByLabel("名前", { exact: true }).fill("空のフォルダー");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return { name, id };
}

// Read the STORE archive's central directory independently of the server serializer.
function entries(bytes: Buffer) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10),
    result: Record<string, string> = {};
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    expect(bytes.readUInt16LE(offset + 10)).toBe(0);
    const size = bytes.readUInt32LE(offset + 24),
      nameBytes = bytes.readUInt16LE(offset + 28),
      name = bytes.subarray(offset + 46, offset + 46 + nameBytes).toString(),
      local = bytes.readUInt32LE(offset + 42);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    result[name] = bytes.subarray(start, start + size).toString();
    offset += 46 + nameBytes + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  expect(offset).toBe(end);
  return result;
}
async function save(page: Page, click: () => Promise<void>, filename: string) {
  const opened = page.waitForEvent("popup");
  await click();
  const popup = await opened,
    download = await popup.waitForEvent("download");
  expect(download.suggestedFilename()).toBe(filename);
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const part of stream!) chunks.push(Buffer.from(part));
  expect(await download.failure()).toBeNull();
  await popup.close();
  return Buffer.concat(chunks);
}
async function sharing(page: Page, id: string, kind: "link" | "internal") {
  return page.evaluate(
    async ({ id, kind }) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const response = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          kind,
          rootNodeId: id,
          role: "read",
          ...(kind === "internal" ? { recipients: ["recipient@example.invalid"] } : {}),
        }),
      });
      if (response.status !== 201) throw new Error(`share_${response.status}`);
      return response.json() as Promise<{ id: string; version: number; secret?: string }>;
    },
    { id, kind },
  );
}
async function guestContext(browser: Browser, identity: "anonymous" | "recipient") {
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: "ncf-test-user",
      value: identity,
      domain: ".ncf.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  if (identity === "recipient")
    await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
  return context;
}
const expected = { "メモ.txt": "ZIP browser download\n", "空のフォルダー/": "" };

test("owner saves the current folder and an empty folder from its menu", async ({ page }) => {
  const { name } = await setup(page);
  const bytes = await save(
    page,
    () => page.getByRole("button", { name: "このフォルダーをZIPで保存", exact: true }).click(),
    `${name}.zip`,
  );
  expect(entries(bytes)).toEqual(expected);
  await page.getByRole("button", { name: "空のフォルダーの操作", exact: true }).click();
  const empty = await save(
    page,
    () => page.getByRole("menuitem", { name: "ZIPで保存", exact: true }).click(),
    "空のフォルダー.zip",
  );
  expect(empty.length).toBe(22);
  expect(entries(empty)).toEqual({});
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "/tmp/ncf-zip-owner-mobile.png", fullPage: true });
});

test("anonymous read link saves the scoped folder ZIP on mobile without a content-host request", async ({
  page,
  browser,
}) => {
  const { name, id } = await setup(page),
    share = await sharing(page, id, "link"),
    context = await guestContext(browser, "anonymous");
  try {
    const guest = await context.newPage(),
      requests: string[] = [];
    context.on("request", (request) => requests.push(request.url()));
    await openPublic(guest, `https://app.ncf.test:8879/s/${share.id}#${share.secret}`, name);
    await expect(guest.getByRole("button", { name: "新規フォルダー", exact: true })).toHaveCount(0);
    const bytes = await save(
      guest,
      () => guest.getByRole("button", { name: "このフォルダーをZIPで保存", exact: true }).click(),
      `${name}.zip`,
    );
    expect(entries(bytes)).toEqual(expected);
    const empty = await save(
      guest,
      () => guest.getByRole("button", { name: "空のフォルダーをZIPで保存", exact: true }).click(),
      "空のフォルダー.zip",
    );
    expect(entries(empty)).toEqual({});
    expect(
      requests.some(
        (url) =>
          url.includes("content.ncf.test") ||
          url.includes("private-assets") ||
          url.includes(share.secret!),
      ),
    ).toBe(false);
    expect(await guest.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await guest.screenshot({ path: "/tmp/ncf-zip-public-mobile.png", fullPage: true });
  } finally {
    await context.close();
  }
});

test("internal read recipient saves ZIPs with the selected share and loses access after revocation", async ({
  page,
  browser,
}) => {
  const { name, id } = await setup(page),
    share = await sharing(page, id, "internal"),
    context = await guestContext(browser, "recipient");
  try {
    const recipient = await context.newPage(),
      issued: unknown[] = [];
    recipient.on("request", (request) => {
      if (request.url().endsWith("/zip")) issued.push(request.postDataJSON());
    });
    await recipient.goto(`/shared/${share.id}`);
    await expect(recipient.getByRole("heading", { name, exact: true })).toBeVisible();
    const bytes = await save(
      recipient,
      () =>
        recipient.getByRole("button", { name: "このフォルダーをZIPで保存", exact: true }).click(),
      `${name}.zip`,
    );
    expect(entries(bytes)).toEqual(expected);
    const empty = await save(
      recipient,
      () =>
        recipient.getByRole("button", { name: "空のフォルダーをZIPで保存", exact: true }).click(),
      "空のフォルダー.zip",
    );
    expect(entries(empty)).toEqual({});
    expect(issued).toEqual([{ share }, { share }]);
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await recipient.screenshot({ path: "/tmp/ncf-zip-recipient-mobile.png", fullPage: true });
    const status = await page.evaluate(async (share) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      return (
        await fetch(`/api/v1/shares/${share.id}`, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "If-Match": `"share-${share.version}"`,
          },
        })
      ).status;
    }, share);
    expect(status).toBe(200);
    await recipient.getByRole("button", { name: "共有を更新", exact: true }).click();
    await expect(recipient.getByRole("alert")).toContainText("アクセスできません");
    await expect(
      recipient.getByRole("button", { name: "このフォルダーをZIPで保存", exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
