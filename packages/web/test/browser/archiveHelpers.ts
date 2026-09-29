import { expect, type Page } from "@playwright/test";
import { archiveFixture } from "../../../worker/test/fixtures/archive";
import { imageBytes } from "../../../worker/test/fixtures/images/encoded";
export async function uploadBook(page: Page, parentId?: string) {
  const bytes = archiveFixture([
    { name: "page10.avif", content: imageBytes("red.avif"), method: 8 },
    { name: "page2.png", content: imageBytes("red.png"), method: 8 },
    {
      name: "page20.jpg",
      content: new TextEncoder().encode("<script>window.archiveScript=true</script>"),
    },
  ]).bytes;
  return page.evaluate(
    async ({ encoded, parentId }) => {
      const json = async (path: string, init?: RequestInit) => {
        const r = await fetch(path, init);
        if (!r.ok) throw new Error(`fixture_${r.status}_${path}`);
        return r.json();
      };
      const me = await json("/api/v1/me"),
        { token } = await json("/api/v1/csrf", { method: "POST" });
      const name = `書籍-${crypto.randomUUID().slice(0, 8)}.cbz`,
        headers = {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
          "Idempotency-Key": crypto.randomUUID(),
        };
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const receipt = await json("/api/v1/uploads", {
        method: "POST",
        headers,
        body: JSON.stringify({
          mode: "single",
          spaceId: me.spaceId,
          parentId: parentId ?? me.rootNodeId,
          name,
          declared_size: bytes.length,
        }),
      });
      await json(`/api/v1/uploads/${receipt.id}/content`, {
        method: "PUT",
        headers: { "Upload-Capability": receipt.capability },
        body: bytes,
      });
      const op = await json(`/api/v1/uploads/${receipt.id}/complete`, {
        method: "POST",
        headers: { ...headers, "Upload-Capability": receipt.capability },
        body: "{}",
      });
      const consumed = await json(`/__test__/dead-letter-dispatch/${op.id}_event`, {
        method: "POST",
      });
      if (consumed.acked !== 1) throw new Error("fixture_index_failed");
      return { name, nodeId: op.result.nodeId as string };
    },
    { encoded: Buffer.from(bytes).toString("base64"), parentId },
  );
}
export async function decoded(page: Page, n: number) {
  const image = page.getByRole("dialog").getByRole("img", { name: `${n}ページ`, exact: true });
  await expect(image).toHaveAttribute("src", new RegExp(`/pages/${n}$`));
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  return image;
}
