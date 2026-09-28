import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
async function login(page: Page) {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
}
async function upload(page: Page, filename: string) {
  const encoded = readFileSync(
    new URL(`../../../worker/test/fixtures/images/${filename}`, import.meta.url),
  ).toString("base64");
  return page.evaluate(async (encoded) => {
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
        parentId: me.rootNodeId,
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
      me: { spaceId: string; contentOrigin: string };
      name: string;
    };
  }, encoded);
}
async function decode(page: Page, url: string, mime: string) {
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toBe(mime);
  expect(response?.headers()["content-disposition"]).toMatch(/^inline;/);
  expect(response?.headers()["cache-control"]).toBe("private, no-store");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const img = document.querySelector("img");
        return img?.complete ? [img.naturalWidth, img.naturalHeight] : null;
      }),
    )
    .toEqual([16, 12]);
}

test("real image uploads produce inline originals decoded by the browser, including 10-bit and sequential AVIF", async ({
  page,
}) => {
  await login(page);
  for (const [filename, mime] of [
    ["red.png", "image/png"],
    ["red.jpg", "image/jpeg"],
    ["red.webp", "image/webp"],
    ["red.avif", "image/avif"],
    ["blue-10bit.avif", "image/avif"],
    ["sequence.avif", "image/avif"],
  ]) {
    const { node, me } = await upload(page, filename!);
    const url = await page.evaluate(
      async ({ node, me }) => {
        const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
        const issue = await fetch("/api/v1/content-session", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({
            targets: [{ spaceId: me.spaceId, nodeId: node.id }],
            purpose: "content",
            ttlSeconds: 300,
          }),
        });
        if (issue.status !== 201) throw new Error(`fixture_ticket_${issue.status}`);
        const { ticket } = await issue.json();
        const accepted = await fetch(`${me.contentOrigin}/session`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        });
        if (accepted.status !== 201) throw new Error(`fixture_session_${accepted.status}`);
        return `${me.contentOrigin}/c/${node.id}/${node.currentBlobId}`;
      },
      { node, me },
    );
    await decode(page, url, mime!);
    await page.goto("/files");
  }
});

test("an anonymous read link decodes its authorized AVIF original", async ({ page, browser }) => {
  await login(page);
  const { node, name } = await upload(page, "red.avif");
  const share = await page.evaluate(async (id) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ kind: "link", rootNodeId: id, role: "read" }),
    });
    if (response.status !== 201) throw new Error(`fixture_share_${response.status}`);
    return response.json() as Promise<{ id: string; secret: string }>;
  }, node.id);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
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
    const guest = await context.newPage();
    await openPublic(guest, `https://app.ncf.test:8879/s/${share.id}#${share.secret}`, name);
    const url = await guest.evaluate(
      async ({ shareId, nodeId }) => {
        const prefix = `/api/v1/public/shares/${shareId}`;
        const root = await fetch(prefix).then((r) => r.json());
        const { token } = await fetch(`${prefix}/csrf`, { method: "POST" }).then((r) => r.json());
        const response = await fetch(`${prefix}/content-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({ nodeIds: [nodeId], ttlSeconds: 300 }),
        });
        if (response.status !== 201) throw new Error(`fixture_public_ticket_${response.status}`);
        const { ticket } = await response.json();
        const accepted = await fetch(`${root.contentOrigin}/session`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        });
        if (accepted.status !== 201) throw new Error(`fixture_public_session_${accepted.status}`);
        return `${root.contentOrigin}/c/${nodeId}/${root.root.currentBlobId}`;
      },
      { shareId: share.id, nodeId: node.id },
    );
    await decode(guest, url, "image/avif");
  } finally {
    await context.close();
  }
});
