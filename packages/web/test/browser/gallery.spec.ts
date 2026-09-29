import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function folder(page: Page, parent?: string) {
  return page.evaluate(async (parent) => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const name = `写真-${crypto.randomUUID()}`;
    const response = await fetch("/api/v1/nodes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        kind: "folder",
        name,
        spaceId: me.spaceId,
        parentId: parent ?? me.rootNodeId,
      }),
    });
    if (!response.ok) throw new Error(`folder_${response.status}`);
    return { id: (await response.json()).result.nodeId as string, name };
  }, parent);
}
async function decoded(page: Page) {
  const dialog = page.getByRole("dialog", { name: "画像の詳細" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog
        .locator("img")
        .evaluateAll((images) =>
          images.map((img) => [
            (img as HTMLImageElement).naturalWidth,
            (img as HTMLImageElement).naturalHeight,
          ]),
        ),
    )
    .toEqual([[16, 12]]);
}
test("gallery grids, lists, recursive scope and keyboard lightbox display real originals", async ({
  page,
}, info) => {
  await login(page);
  const root = await folder(page),
    child = await folder(page, root.id);
  const a = await upload(page, "red.png", root.id),
    b = await upload(page, "red.jpg", root.id),
    c = await upload(page, "red.avif", child.id);
  await page.goto(`/gallery/${root.id}`);
  const gallery = page.getByRole("region", { name: "ギャラリー" });
  await expect(gallery.getByRole("button", { name: `${a.name}を表示` })).toBeVisible();
  await expect(gallery.getByRole("button", { name: `${c.name}を表示` })).toHaveCount(0);
  await expect(gallery.locator(".gallery-thumb img")).toHaveCount(2);
  await gallery.getByRole("button", { name: "リスト表示", exact: true }).click();
  await expect(gallery.locator(".gallery-list")).toBeVisible();
  await gallery.getByLabel("サブフォルダーも表示").check();
  await expect(gallery.getByRole("button", { name: `${c.name}を表示` })).toBeVisible();
  await expect(gallery.locator(".gallery-list")).toBeVisible();
  await gallery.getByRole("button", { name: "グリッド表示", exact: true }).click();
  await gallery.getByRole("button", { name: `${c.name}を表示` }).click();
  await decoded(page);
  await page.getByRole("dialog").getByRole("button", { name: "次の画像", exact: true }).click();
  await decoded(page);
  await page.keyboard.press("ArrowLeft");
  await decoded(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: info.outputPath("gallery-mobile.png") });
  await gallery.getByRole("button", { name: `${b.name}を表示` }).click();
  await decoded(page);
});

test("internal recipients and anonymous links view galleries and discard a revoked page", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const root = await folder(page);
  const image = await upload(page, "red.avif", root.id);
  const shares = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const create = async (body: unknown) => {
      const r = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`share_${r.status}`);
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
  }, root.id);
  for (const identity of ["recipient", "anonymous"]) {
    const context = await browser.newContext({
      baseURL: "https://app.ncf.test:8879",
      ignoreHTTPSErrors: true,
    });
    try {
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
      const viewer = await context.newPage();
      if (identity === "recipient") await viewer.goto(`/shared/${shares.internal.id}`);
      else
        await openPublic(
          viewer,
          `https://app.ncf.test:8879/s/${shares.public.id}#${shares.public.secret}`,
          root.name,
        );
      await viewer.getByRole("button", { name: "ギャラリーで表示", exact: true }).click();
      const gallery = viewer.getByRole("region", { name: "ギャラリー" });
      await expect(gallery.locator(".gallery-thumb img")).toHaveCount(1);
      await gallery.getByRole("button", { name: `${image.name}を表示` }).click();
      await decoded(viewer);
      await viewer.getByRole("button", { name: "画像を閉じる" }).click();
      await viewer.screenshot({ path: info.outputPath(`gallery-${identity}.png`) });
      const id = identity === "recipient" ? shares.internal.id : shares.public.id;
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
        }, id),
      ).toBe(200);
      await gallery.getByRole("button", { name: "画像を更新" }).click();
      await expect(gallery.getByRole("alert")).toBeVisible();
      await expect(gallery.locator(".gallery-card")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});
