import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { FileNode } from "../../src/lib/api";

test.beforeEach(async ({ page }) => {
  // Other suites exercise logout against this shared, isolated harness identity.
  await page.goto("/__test__/ready");
  expect(
    await page.evaluate(() =>
      fetch("/__test__/login", { method: "POST" }).then((response) => response.status),
    ),
  ).toBe(200);
});

test("folder picker preserves all nested files beyond the upload queue limit and novels read their bytes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), "ncf-folder-"));
  const folderName = basename(directory);
  const expected = new Map<string, string>();
  try {
    await mkdir(join(directory, "nested"));
    for (let index = 0; index < 35; index++) {
      const path = index === 34 ? "nested/chapter.txt" : `chapter-${index}.txt`;
      const text = `第${index + 1}章\n\nこれはフォルダーの中の小説です。\n${"長い物語を読みます。\n".repeat(index === 34 ? 2000 : 1)}`;
      expected.set(path, text);
      await writeFile(join(directory, path), text);
    }
    await page.goto("/files");
    await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "フォルダーをアップロード", exact: true }).click();
    await (await chooser).setFiles(directory);
    await expect(page.locator(".upload-task").filter({ hasText: "アップロード完了" })).toHaveCount(
      35,
      { timeout: 120_000 },
    );
    await page.reload();
    await page.getByRole("button", { name: `${folderName} フォルダー`, exact: true }).click();
    const folderUrl = page.url();
    const collect = async (id: string): Promise<FileNode[]> =>
      page.evaluate(
        async (id) => (await (await fetch(`/api/v1/nodes/${id}/children`)).json()).children,
        id,
      );
    const nodes = await collect(new URL(folderUrl).pathname.split("/").at(-1)!);
    expect(nodes.filter((node) => node.kind === "file")).toHaveLength(34);
    const nested = nodes.find((node) => node.name === "nested")!;
    const [chapter] = await collect(nested.id);
    expect(chapter?.name).toBe("chapter.txt");
    // The nested chapter's exact bytes are verified by its reader download below.
    // Avoid four reads of that same blob within the three-read transfer allowance.
    const sources = nodes.filter((node) => node.kind === "file");
    const bodies = await page.evaluate(async (sources) => {
      const me = await (await fetch("/api/v1/me")).json();
      const csrf = await (await fetch("/api/v1/csrf", { method: "POST" })).json();
      const issued = await fetch("/api/v1/content-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        body: JSON.stringify({
          targets: sources.map((node) => ({ spaceId: me.spaceId, nodeId: node.id })),
          purpose: "content",
          ttlSeconds: 300,
        }),
      });
      if (issued.status !== 201) throw new Error("test_ticket_" + issued.status);
      const ticket = await issued.json();
      const accepted = await fetch(me.contentOrigin + "/session", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: ticket.ticket }),
      });
      if (accepted.status !== 201) throw new Error("test_exchange_" + accepted.status);
      try {
        const values = [];
        for (const node of sources) {
          const response = await fetch(
            me.contentOrigin + "/c/" + node.id + "/" + node.currentBlobId,
            { credentials: "include" },
          );
          if (!response.ok) throw new Error("test_content_" + response.status);
          values.push(await response.text());
        }
        return values;
      } finally {
        const cancelled = await fetch(`/api/v1/tickets/${ticket.ticketId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        });
        if (!cancelled.ok) throw new Error("test_cancel_" + cancelled.status);
      }
    }, sources);
    sources.forEach((node, index) => expect(bodies[index]).toBe(expected.get(node.name)));
    await page.getByRole("link", { name: "小説", exact: true }).click();
    await expect(page.getByRole("heading", { name: "小説", exact: true })).toBeVisible();
    await page.locator(".novel-card").filter({ hasText: "chapter.txt" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("本文")).toContainText("第35章");
    await dialog.getByLabel("文字サイズ").selectOption("24");
    await dialog.getByLabel("本文").evaluate((element) => {
      element.scrollTop = 3000;
    });
    await page.screenshot({ path: test.info().outputPath("novels-desktop.png") });
    const download = page.waitForEvent("download");
    await dialog.getByRole("link", { name: "ダウンロード", exact: true }).click();
    const downloaded = await download;
    expect((await readFile((await downloaded.path())!)).toString()).toBe(
      expected.get("nested/chapter.txt"),
    );
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.locator(".novel-card").filter({ hasText: "chapter.txt" }).click();
    await expect(page.getByRole("dialog").getByLabel("文字サイズ")).toHaveValue("24");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty trash loads every page before deleting and retries only the failed item", async ({
  page,
}) => {
  let calls = 0;
  const purged: string[] = [];
  const keys: string[] = [];
  await page.route(/\/api\/v1\/trash\?/, (route) => {
    const second = new URL(route.request().url()).searchParams.has("cursor");
    const id = second ? "older" : "newer";
    return route.fulfill({
      json: {
        items: purged.includes(id)
          ? []
          : [
              {
                opId: id,
                rootNodeId: id,
                name: `${id}.txt`,
                kind: "file",
                deletedAt: 1,
                memberCount: 1,
              },
            ],
        nextCursor: !second && !purged.includes("older") ? "next" : null,
      },
    });
  });
  await page.route(/\/api\/v1\/trash\/(newer|older)\/purge$/, async (route) => {
    const id = route.request().url().includes("/older/") ? "older" : "newer";
    if (id === "older") {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (calls++ === 0) return route.abort("failed");
    }
    purged.push(id);
    return route.fulfill({
      json: { id: `purge-${id}`, state: "committed", result: { status: 200 } },
    });
  });
  await page.goto("/trash");
  await page.getByRole("button", { name: "ゴミ箱を空にする", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const submit = dialog.getByRole("button", { name: "ゴミ箱を空にする", exact: true });
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("0 / 2");
  await dialog.getByLabel("すべて完全に削除することを確認しました").check();
  await submit.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(purged).toEqual(["newer"]);
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(purged).toEqual(["newer", "older"]);
  expect(keys[0]).toBe(keys[1]);
});
