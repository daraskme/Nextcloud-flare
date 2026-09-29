import { expect, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";

test("owner edits audio tags, preserves the native source, detects a competing edit and resets overrides", async ({
  page,
}) => {
  await login(page);
  const media = await upload(page, "long.opus", undefined, "tracks");
  await page.goto(`/audio/${media.node.id}`);
  await page.getByRole("button", { name: `${media.name}を再生`, exact: true }).click();
  const player = page.getByRole("region", { name: "オーディオプレーヤー" });
  await expect(player.getByRole("button", { name: "一時停止", exact: true })).toBeEnabled();
  await player.getByRole("button", { name: "一時停止", exact: true }).click();
  const src = await page.locator("audio").getAttribute("src");
  await page.getByRole("button", { name: `${media.name}のタグを編集`, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "音声タグを編集" });
  await expect(editor.getByLabel("曲名", { exact: true })).toBeEnabled();
  await editor.getByLabel("曲名", { exact: true }).fill("夜の曲 <live>");
  await editor.getByLabel("アーティスト", { exact: true }).fill("演奏者");
  await editor.getByRole("button", { name: "タグを保存", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "オーディオ", exact: true })
      .getByText("夜の曲 <live>", { exact: true }),
  ).toBeVisible();
  await expect(player.getByText("夜の曲 <live>", { exact: true })).toBeVisible();
  expect(await page.locator("audio").getAttribute("src")).toBe(src);
  await page.getByRole("button", { name: `${media.name}のタグを編集`, exact: true }).click();
  await expect(editor.getByLabel("曲名", { exact: true })).toHaveValue("夜の曲 <live>");
  await page.evaluate(async (id) => {
    const p = await fetch(`/api/v1/nodes/${id}/tracks`).then((r) => r.json()),
      item = p.items[0];
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const r = await fetch(`/api/v1/nodes/${id}/audio`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        blobId: item.currentBlobId,
        generator: p.generator,
        revision: item.metadata.revision,
        title: "別タブの曲",
        artist: null,
        album: null,
      }),
    });
    if (r.status !== 200) throw new Error(`competing_edit_${r.status}`);
  }, media.node.id);
  await editor.getByLabel("曲名", { exact: true }).fill("古い編集");
  await editor.getByRole("button", { name: "タグを保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("別の変更が先に保存されました");
  await expect(editor.getByRole("button", { name: "タグを保存", exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "現在のタグを読み直す" }).click();
  await expect(editor.getByLabel("曲名", { exact: true })).toHaveValue("別タブの曲");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  expect(await editor.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/audio-metadata-mobile.png" });
  await editor.getByRole("button", { name: "すべて原本の値に戻す" }).click();
  await editor.getByRole("button", { name: "タグを保存", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: `${media.name}のタグを編集`, exact: true }).click();
  await expect(editor.getByLabel("曲名", { exact: true })).toHaveValue("");
  await expect(editor.getByLabel("アーティスト", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();
});
