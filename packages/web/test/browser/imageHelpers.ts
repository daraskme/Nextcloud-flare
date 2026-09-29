import { readFileSync } from "node:fs";
import { URL } from "node:url";
import type { Page } from "@playwright/test";
export async function login(page: Page) {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
}
export async function upload(page: Page, filename: string, parentId?: string) {
  const encoded = readFileSync(
    new URL(`../../../worker/test/fixtures/images/${filename}`, import.meta.url),
  ).toString("base64");
  return page.evaluate(
    async ({ encoded, parentId }) => {
      const json = async (path: string, options?: RequestInit) => {
        const response = await fetch(path, options);
        if (!response.ok) throw new Error(`fixture_http_${response.status}`);
        return response.json();
      };
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const me = await json("/api/v1/me"),
        { token } = await json("/api/v1/csrf", { method: "POST" });
      const headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
        "Idempotency-Key": crypto.randomUUID(),
      };
      const name = `画像-${crypto.randomUUID().slice(0, 8)}.txt`;
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
      const operation = await json(`/api/v1/uploads/${receipt.id}/complete`, {
        method: "POST",
        headers: { ...headers, "Upload-Capability": receipt.capability },
        body: "{}",
      });
      // This existing local fixture drives the real Outbox producer/consumer without a remote Queue.
      const consumed = await json(`/__test__/dead-letter-dispatch/${operation.id}_event`, {
        method: "POST",
      });
      if (consumed.acked !== 1) throw new Error("fixture_metadata_not_completed");
      const node = await json(`/api/v1/nodes/${operation.result.nodeId}`);
      return { node, me, name } as {
        node: { id: string; currentBlobId: string };
        me: { spaceId: string; contentOrigin: string; rootNodeId: string };
        name: string;
      };
    },
    { encoded, parentId },
  );
}

/** Deliver the durable lg request through the same local Queue fixture as uploads. */
export async function generateLarge(page: Page, blobId: string) {
  const result = await page.evaluate(async (blobId) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([blobId, "lg", "image-webp-v1"])),
    );
    const id =
      "lg_" + Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
    const response = await fetch(`/__test__/dead-letter-dispatch/${id}`, { method: "POST" });
    if (!response.ok) throw new Error(`preview_dispatch_${response.status}`);
    return response.json();
  }, blobId);
  if (result.acked !== 1) throw new Error("preview_generation_not_completed");
}
