import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { localFetch, open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function generate(page: Page, nodeId: string, blobId: string) {
  const ack = await page.evaluate(
    async ({ nodeId, blobId }) => {
      const bytes = new TextEncoder().encode(JSON.stringify([nodeId, blobId, "media-metadata-v1"]));
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      return (
        await fetch(`/__test__/dead-letter-dispatch/media_${hash}`, { method: "POST" })
      ).json();
    },
    { nodeId, blobId },
  );
  expect(ack.acked).toBe(1);
}
for (const scope of ["owner", "internal", "public"] as const)
  test(`${scope} extracts a legacy file from Files and makes it playable in Audio`, async ({
    page,
    browser,
  }, info) => {
    await login(page);
    const media = await upload(page, "tone.mp3", undefined, "tracks", "legacy-media");
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
      } else await target.goto(`/files/${media.me.rootNodeId}`);
      const keys: string[] = [];
      target.on("request", (r) => {
        if (r.method() === "POST" && /\/media(?:\/[^/?]+)?$/.test(r.url()))
          keys.push(r.headers()["idempotency-key"]!);
      });
      if (scope === "owner") {
        await target.getByRole("button", { name: media.name + "の操作", exact: true }).click();
        await target.getByRole("menuitem", { name: "メディア情報を読み込む", exact: true }).click();
      } else
        await target
          .getByRole("button", { name: media.name + "のメディア情報を読み込む", exact: true })
          .click();
      const panel = target.getByRole("region", { name: "メディア情報の読み込み", exact: true });
      await panel.getByRole("button", { name: "メディア情報を読み込む", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText("メディア情報を読み込んでいます");
      await generate(page, media.node.id, media.node.currentBlobId);
      await panel.getByRole("button", { name: "状態を確認", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText("オーディオで表示できます");
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await target.screenshot({ path: info.outputPath("extracted-" + scope + ".png") });
      await panel.getByRole("button", { name: "閉じる", exact: true }).click();
      if (scope === "owner") await target.goto("/audio/" + media.node.id);
      else await target.getByRole("button", { name: "オーディオで表示", exact: true }).click();
      await expect(target.locator(".audio-tracks")).toContainText("テスト曲");
      await target.getByRole("button", { name: media.name + "を再生", exact: true }).click();
      await expect
        .poll(() => target.locator("audio").evaluate((el) => (el as HTMLAudioElement).currentTime))
        .toBeGreaterThan(0);
      await target.screenshot({ path: info.outputPath("extracted-playing-" + scope + ".png") });
    } finally {
      await context?.close();
    }
  });

test("closing the extraction panel aborts a delayed receipt and does not reopen it", async ({
  page,
}) => {
  await login(page);
  const media = await upload(page, "tone.mp3", undefined, "tracks", "legacy-media");
  await page.goto(`/files/${media.me.rootNodeId}`);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(`**/api/v1/nodes/${media.node.id}/media`, async (route) => {
    const response = await localFetch(route);
    arrived();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("button", { name: media.name + "の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "メディア情報を読み込む", exact: true }).click();
  const panel = page.getByRole("region", { name: "メディア情報の読み込み", exact: true });
  await panel.getByRole("button", { name: "メディア情報を読み込む", exact: true }).click();
  await started;
  const aborted = page.waitForEvent("requestfailed", (r) =>
    r.url().endsWith(`/nodes/${media.node.id}/media`),
  );
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  await aborted;
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: media.name + "の操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "メディア情報を読み込む", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "メディア情報を読み込む", exact: true }),
  ).toBeEnabled();
});
