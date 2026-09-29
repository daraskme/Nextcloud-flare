import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test("2,000 real Audio tracks remain usable during playback with maximal text fields", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240000);
  await login(page);
  const sourceIds: string[] = [];
  for (let i = 0; i < 3; i++)
    sourceIds.push((await upload(page, "long.opus", undefined, "tracks")).node.id);
  const fixture = await page.evaluate(async (ids) => {
    const response = await fetch("/__test__/audio-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids),
    });
    if (!response.ok) throw new Error(`audio_fixture_${response.status}`);
    return response.json() as Promise<{
      folderId: string;
      firstId: string;
      lastId: string;
      count: number;
    }>;
  }, sourceIds);
  const link = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const r = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId, role: "read" }),
    });
    if (r.status !== 201) throw new Error(`audio_share_${r.status}`);
    return r.json();
  }, fixture.folderId);
  const anonymous = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const metrics: unknown[] = [];
  try {
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
    for (const [scope, target] of [
      ["owner", page],
      ["public", guest],
    ] as const) {
      const cdp = await target.context().newCDPSession(target);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Performance.enable");
      if (scope === "owner") await target.goto(`/audio/${fixture.folderId}`);
      else {
        await openPublic(
          target,
          `https://app.ncf.test:8879/s/${link.id}#${link.secret}`,
          "Audio 2001",
        );
        await target.getByRole("button", { name: "オーディオで表示", exact: true }).click();
      }
      const library = target.getByRole("region", { name: "オーディオ" });
      await expect(library.locator(".audio-tracks > li")).toHaveCount(200);
      const loads: number[] = [];
      for (let count = 400; count <= 2000; count += 200) {
        const started = Date.now();
        await library.getByRole("button", { name: "曲をもっと表示", exact: true }).click();
        await expect(library.locator(".audio-tracks > li")).toHaveCount(count, { timeout: 15000 });
        loads.push(Date.now() - started);
      }
      await expect(library.getByText("2,000曲まで表示しました。", { exact: false })).toBeVisible();
      await expect(
        library.getByRole("button", { name: "曲をもっと表示", exact: true }),
      ).toHaveCount(0);
      await expect(
        library.getByRole("button", { name: "002000.opusを再生", exact: true }),
      ).toHaveCount(0);
      await library.getByRole("button", { name: "001999.opusを再生", exact: true }).click();
      const player = target.getByRole("region", { name: "オーディオプレーヤー" });
      await expect(player.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled({
        timeout: 15000,
      });
      await expect(player.getByRole("button", { name: "次の曲", exact: true })).toBeDisabled();
      await expect(player.getByRole("button", { name: "前の曲", exact: true })).toBeEnabled();
      await expect
        .poll(() => target.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime))
        .toBeGreaterThan(0.1);
      await target.locator("audio").evaluate((el) => (el as HTMLAudioElement).pause());
      const before = await cdp.send("Performance.getMetrics");
      const frames = await target.evaluate(async () => {
        const media = document.querySelector("audio")!;
        const values: number[] = [];
        for (let i = 0; i < 45; i++) {
          const start = performance.now();
          media.dispatchEvent(new Event("timeupdate"));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (i >= 5) values.push(performance.now() - start);
        }
        return values.sort((a, b) => a - b);
      });
      const after = await cdp.send("Performance.getMetrics");
      const metric = (values: { metrics: { name: string; value: number }[] }, key: string) =>
        values.metrics.find((x) => x.name === key)!.value;
      const box = await player.boundingBox();
      const measured = {
        scope,
        cpu: 4,
        tracks: 2000,
        maxPageMs: Math.max(...loads),
        frameP95Ms: frames[Math.floor(frames.length * 0.95)]!,
        scriptMs: (metric(after, "ScriptDuration") - metric(before, "ScriptDuration")) * 1000,
        heapMiB: metric(after, "JSHeapUsedSize") / 1048576,
        playerHeight: box!.height,
      };
      metrics.push(measured);
      console.log("Audio scale", JSON.stringify(measured));
      expect.soft(measured.maxPageMs).toBeLessThan(5000);
      expect.soft(measured.frameP95Ms).toBeLessThan(100);
      expect.soft(measured.scriptMs).toBeLessThan(750);
      expect.soft(measured.playerHeight).toBeLessThan(scope === "public" ? 260 : 200);
      expect
        .soft(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await target.screenshot({ path: info.outputPath(`audio-scale-${scope}.png`) });
      await player.getByRole("button", { name: "前の曲", exact: true }).click();
      await expect(player.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled();
      await expect(library.locator(".audio-selected button")).toHaveAttribute(
        "aria-label",
        "001998.opusを再生",
      );
      await player.getByRole("button", { name: "次の曲", exact: true }).click();
      await expect(player.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled();
      await expect(library.locator(".audio-selected button")).toHaveAttribute(
        "aria-label",
        "001999.opusを再生",
      );
      await expect(player.getByRole("button", { name: "次の曲", exact: true })).toBeDisabled();
      await assertClosing(target);
      await expect(library.locator(".audio-selected")).toHaveCount(0);
      await cdp.detach();
    }
  } finally {
    writeFileSync(info.outputPath("audio-scale.json"), JSON.stringify(metrics, null, 2));
    await anonymous.close();
  }
});
async function assertClosing(page: Page) {
  // Native cleanup must still work at the list ceiling.
  await page
    .getByRole("region", { name: "オーディオプレーヤー" })
    .getByRole("button", { name: "プレーヤーを閉じる", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "オーディオプレーヤー" })).toHaveCount(0);
  expect(await page.locator("audio").getAttribute("src")).toBeNull();
}
