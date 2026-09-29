import { expect, type Page, test } from "@playwright/test";
import { generateLarge, login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function dimensions(page: Page, width: number, height: number) {
  const img = page.getByRole("dialog", { name: "画像の詳細" }).locator("img");
  await expect
    .poll(() =>
      img.evaluate((el) => [
        (el as HTMLImageElement).naturalWidth,
        (el as HTMLImageElement).naturalHeight,
      ]),
    )
    .toEqual([width, height]);
  return img;
}
test("owner generates a large preview on demand, switches to the original and releases its object URL", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL;
    (window as unknown as { revokedPreviews: string[] }).revokedPreviews = [];
    URL.revokeObjectURL = (url) => {
      (window as unknown as { revokedPreviews: string[] }).revokedPreviews.push(url);
      revoke(url);
    };
  });
  await login(page);
  const image = await upload(page, "pattern.png");
  await page.goto("/gallery");
  await page.getByRole("button", { name: `${image.name}を表示` }).click();
  await dimensions(page, 1920, 1080);
  await generateLarge(page, image.node.currentBlobId);
  await page.getByRole("button", { name: "軽いプレビューを表示" }).click();
  const preview = await dimensions(page, 1600, 900),
    url = await preview.getAttribute("src");
  expect(url).toMatch(/^blob:/);
  await page.getByRole("button", { name: "原本を表示", exact: true }).click();
  await expect(await dimensions(page, 1920, 1080)).toHaveAttribute(
    "src",
    /^https:\/\/content\.ncf\.test:8879\/c\//,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          (window as unknown as { revokedPreviews: string[] }).revokedPreviews.includes(url!),
        url,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "軽いプレビューを表示" }).click();
  const reopened = await dimensions(page, 1600, 900),
    second = await reopened.getAttribute("src");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: info.outputPath("large-preview-mobile.png") });
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          (window as unknown as { revokedPreviews: string[] }).revokedPreviews.includes(url!),
        second,
      ),
    )
    .toBe(true);
});

test("an anonymous reader requests and displays lg with the original unlock session", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const image = await upload(page, "pattern.png");
  const share = await page.evaluate(async (id) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId: id, role: "read" }),
    });
    if (!response.ok) throw new Error("preview_share_failed");
    return response.json();
  }, image.node.id);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
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
    await openPublic(guest, `https://app.ncf.test:8879/s/${share.id}#${share.secret}`, image.name);
    await guest.getByRole("button", { name: "ギャラリーで表示" }).click();
    await guest.getByRole("button", { name: `${image.name}を表示` }).click();
    await dimensions(guest, 1920, 1080);
    await generateLarge(page, image.node.currentBlobId);
    await guest.getByRole("button", { name: "軽いプレビューを表示" }).click();
    await expect(await dimensions(guest, 1600, 900)).toHaveAttribute("src", /^blob:/);
    await guest.screenshot({ path: info.outputPath("large-preview-public.png") });
    await guest.getByRole("button", { name: "原本を表示", exact: true }).click();
    await expect(await dimensions(guest, 1920, 1080)).toHaveAttribute(
      "src",
      /^https:\/\/content\.ncf\.test:8879\/c\//,
    );
  } finally {
    await context.close();
  }
});
