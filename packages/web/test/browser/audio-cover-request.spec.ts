import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function generate(page: Page, blobId: string) {
  const ack = await page.evaluate(async (blob) => {
    const bytes = new TextEncoder().encode(JSON.stringify([blob, "sm", "audio-cover-webp-v1"]));
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    return (await fetch(`/__test__/dead-letter-dispatch/cover_${hash}`, { method: "POST" })).json();
  }, blobId);
  expect(ack.acked).toBe(1);
}
for (const scope of ["owner", "internal", "public"] as const)
  test(`${scope} regenerates a legacy cover and updates list/player without reloading the original`, async ({
    page,
    browser,
  }, info) => {
    await login(page);
    const media = await upload(page, "cover.opus", undefined, "tracks", "legacy-audio");
    const context =
      scope === "owner"
        ? null
        : await browser.newContext({
            baseURL: "https://app.ncf.test:8879",
            ignoreHTTPSErrors: true,
            viewport: { width: 390, height: 844 },
          });
    try {
      const target = context ? await context.newPage() : page;
      if (context) {
        await context.addCookies([
          {
            name: "ncf-test-user",
            value: scope === "internal" ? "recipient" : "anonymous",
            domain: ".ncf.test",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const link = await page.evaluate(
          async ({ rootNodeId, scope }) => {
            const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
            const response = await fetch("/api/v1/shares", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
              body: JSON.stringify({
                kind: scope === "internal" ? "internal" : "link",
                rootNodeId,
                role: "read",
                ...(scope === "internal" ? { recipients: ["recipient@example.invalid"] } : {}),
              }),
            });
            if (response.status !== 201) throw new Error(`share_${response.status}`);
            return response.json();
          },
          { rootNodeId: media.node.id, scope },
        );
        if (scope === "internal") {
          await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
            headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
          });
          await target.goto(`/shared/${link.id}`);
        } else
          await openPublic(
            target,
            `https://app.ncf.test:8879/s/${link.id}#${link.secret}`,
            media.name,
          );
        await target.getByRole("button", { name: "オーディオで表示", exact: true }).click();
      } else await target.goto(`/audio/${media.node.id}`);
      const keys: string[] = [];
      target.on("request", (r) => {
        if (r.method() === "POST" && /\/thumb(?:\/[^/?]+)?$/.test(r.url()))
          keys.push(r.headers()["idempotency-key"]!);
      });
      await expect(target.locator(".audio-cover img")).toHaveCount(0);
      await target.locator("audio").evaluate((el) => {
        (el as HTMLAudioElement).loop = true;
      });
      await target.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
      const player = target.getByRole("region", { name: "オーディオプレーヤー" });
      await expect
        .poll(() => target.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime))
        .toBeGreaterThan(0);
      const src = await target.locator("audio").getAttribute("src");
      await player.getByRole("button", { name: "表紙を読み込む", exact: true }).click();
      await expect(player.getByRole("status")).toContainText("表紙を生成しています");
      await generate(page, media.node.currentBlobId);
      await player.getByRole("button", { name: "表紙を確認", exact: true }).click();
      await expect(target.locator(".audio-cover img")).toHaveCount(2);
      await expect
        .poll(() =>
          target
            .locator(".audio-cover img")
            .evaluateAll((elements) =>
              elements.every((el) => (el as HTMLImageElement).naturalWidth > 0),
            ),
        )
        .toBe(true);
      expect(await target.locator("audio").getAttribute("src")).toBe(src);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await target.evaluate(() => scrollBy(0, 350));
      await target.screenshot({ path: info.outputPath(`cover-request-${scope}.png`) });
    } finally {
      await context?.close();
    }
  });

test("an original without embedded artwork remembers absence across reload", async ({ page }) => {
  await login(page);
  const media = await upload(page, "opus.ogg", undefined, "tracks", "legacy-audio");
  await page.goto(`/audio/${media.node.id}`);
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  const player = page.getByRole("region", { name: "オーディオプレーヤー" });
  await player.getByRole("button", { name: "表紙を読み込む", exact: true }).click();
  await expect(player.getByRole("status")).toContainText("表紙を生成しています");
  await generate(page, media.node.currentBlobId);
  await player.getByRole("button", { name: "表紙を確認", exact: true }).click();
  await expect(player.getByRole("status")).toContainText("読み取れる埋め込み表紙がありません");
  await expect(page.locator(".audio-cover img")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  await expect(player.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled();
  await expect(player.getByRole("button", { name: /表紙を/ })).toHaveCount(0);
});
