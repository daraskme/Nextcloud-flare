import { expect, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test("MP3, FLAC and WAV from real uploads play as authorized originals for owner and public link", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await login(page);
  const anonymous = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await anonymous.addCookies([
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
  const guest = await anonymous.newPage();
  try {
    for (const format of ["mp3", "flac", "wav"]) {
      const media = await upload(page, `tone.${format}`, undefined, "tracks");
      const link = await page.evaluate(async (rootNodeId) => {
        const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
        const r = await fetch("/api/v1/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({ kind: "link", rootNodeId, role: "read" }),
        });
        if (r.status !== 201) throw new Error(`audio_share_${r.status}`);
        return r.json();
      }, media.node.id);
      for (const target of [page, guest]) {
        if (target === page) await page.goto(`/audio/${media.node.id}`);
        else {
          await openPublic(
            guest,
            `https://app.ncf.test:8879/s/${link.id}#${link.secret}`,
            media.name,
          );
          await guest.getByRole("button", { name: "オーディオで表示", exact: true }).click();
        }
        await expect(
          target.getByRole("region", { name: "オーディオ" }).getByText("テスト曲", { exact: true }),
        ).toBeVisible();
        const received = target.waitForResponse(
          (r) => r.url().includes(`/c/${media.node.id}/`) && r.request().method() === "GET",
        );
        await target.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
        const response = await received;
        expect(response.status()).toBe(206);
        expect(response.headers()["content-type"]).toBe(
          `audio/${format === "mp3" ? "mpeg" : format}`,
        );
        expect(response.request().headers().range).toMatch(/^bytes=/);
        const controls = target.getByRole("region", { name: "オーディオプレーヤー" });
        await expect(controls.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled();
        await expect
          .poll(() =>
            target.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime),
          )
          .toBeGreaterThan(0.05);
        await controls.getByRole("button", { name: "プレーヤーを閉じる" }).click();
        expect(await target.locator("audio").getAttribute("src")).toBeNull();
      }
    }
  } finally {
    await anonymous.close();
  }
});
