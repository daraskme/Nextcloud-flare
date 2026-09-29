import { expect, type Locator, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function decoded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await image.getAttribute("src")).toMatch(/^blob:/);
}

for (const filename of ["cover.mp3", "cover.flac", "cover.m4a", "cover.opus", "cover.ogg"])
  test(`${filename} displays actual embedded artwork in the list and persistent player`, async ({
    page,
  }, info) => {
    await login(page);
    const media = await upload(page, filename, undefined, "tracks");
    const delivered = page.waitForResponse((r) =>
      r.url().includes(`/nodes/${media.node.id}/thumb?`),
    );
    await page.goto(`/audio/${media.node.id}`);
    await decoded(
      page.getByRole("region", { name: "オーディオ", exact: true }).locator(".audio-cover img"),
    );
    const response = await delivered;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/webp");
    expect(response.request().headers()["content-session"]).toBeTruthy();
    await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
    const player = page.getByRole("region", { name: "オーディオプレーヤー" });
    await decoded(player.locator(".audio-cover img"));
    await expect
      .poll(() => page.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime))
      .toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath("audio-cover-owner.png") });
    await page
      .getByRole("navigation", { name: "メインナビゲーション" })
      .getByRole("link", { name: "マイドライブ" })
      .click();
    await decoded(player.locator(".audio-cover img"));
    await player.getByRole("button", { name: "プレーヤーを閉じる" }).click();
    await expect(player).toHaveCount(0);
    expect(await page.locator("audio").getAttribute("src")).toBeNull();
  });

test("shared artwork uses current internal/public grants and closes with the shared player", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const media = await upload(page, "cover.opus", undefined, "tracks");
  const shares = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const create = async (body: unknown) => {
      const r = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });
      if (r.status !== 201) throw new Error(`share_${r.status}`);
      return r.json();
    };
    return {
      internal: await create({
        kind: "internal",
        rootNodeId,
        role: "read",
        recipients: ["recipient@example.invalid"],
      }),
      public: await create({ kind: "link", rootNodeId, role: "read" }),
    };
  }, media.node.id);
  for (const kind of ["internal", "public"] as const) {
    const context = await browser.newContext({
      baseURL: "https://app.ncf.test:8879",
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      await context.addCookies([
        {
          name: "ncf-test-user",
          value: kind === "internal" ? "recipient" : "anonymous",
          domain: ".ncf.test",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      if (kind === "internal")
        await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
          headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
        });
      const guest = await context.newPage(),
        share = shares[kind];
      if (kind === "internal") await guest.goto(`/shared/${share.id}`);
      else
        await openPublic(
          guest,
          `https://app.ncf.test:8879/s/${share.id}#${share.secret}`,
          media.name,
        );
      const delivered = guest.waitForResponse(
        (r) => r.url().includes("/thumb") && r.request().method() === "GET",
      );
      await guest.getByRole("button", { name: "オーディオで表示", exact: true }).click();
      await decoded(
        guest.getByRole("region", { name: "オーディオ", exact: true }).locator(".audio-cover img"),
      );
      const response = await delivered;
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("image/webp");
      await guest.locator("audio").evaluate((el) => {
        (el as HTMLAudioElement).loop = true;
      });
      await guest.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
      const player = guest.getByRole("region", { name: "オーディオプレーヤー" });
      await decoded(player.locator(".audio-cover img"));
      expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await guest.screenshot({ path: info.outputPath(`audio-cover-${kind}.png`) });
      expect(
        await page.evaluate(async (id) => {
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
        }, share.id),
      ).toBe(200);
      const headers = await response.request().allHeaders();
      const status = await guest.evaluate(
        async ({ url, headers }) => {
          return (
            await fetch(url, {
              headers: {
                "Content-Session": headers["content-session"]!,
                ...(headers["share-session"] ? { "Share-Session": headers["share-session"] } : {}),
              },
            })
          ).status;
        },
        { url: response.url(), headers },
      );
      expect([401, 404]).toContain(status);
      await expect(player.locator(".audio-cover img")).toHaveCount(0, { timeout: 25000 });
      expect(await guest.locator("audio").getAttribute("src")).toBeNull();
    } finally {
      await context.close();
    }
  }
});
