import { expect, type Page, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";
import { open as openPublic } from "./publicShareHelpers";

test.setTimeout(180000);
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

test("owner thumbnail sessions decode the published WebP through the authenticated app route", async ({
  page,
}) => {
  await login(page);
  const { node, me } = await upload(page, "red.png");
  const result = await page.evaluate(
    async ({ node, me }) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const issued = await fetch("/api/v1/content-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          purpose: "thumb",
          delivery: "app",
          targets: [{ spaceId: me.spaceId, nodeId: node.id, variant: "sm" }],
          ttlSeconds: 300,
        }),
      });
      if (issued.status !== 201) throw new Error(`fixture_thumb_ticket_${issued.status}`);
      const receipt = await issued.json();
      const headers = { "Content-Session": receipt.sessionId };
      const response = await fetch(`/api/v1/nodes/${node.id}/thumb?variant=sm`, { headers });
      if (response.status !== 200) throw new Error(`fixture_thumb_${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const dimensions = [bitmap.width, bitmap.height];
      bitmap.close();
      const wrongVariant = await fetch(`/api/v1/nodes/${node.id}/thumb?variant=md`, { headers });
      return {
        dimensions,
        mime: response.headers.get("Content-Type"),
        cache: response.headers.get("Cache-Control"),
        wrongVariant: wrongVariant.status,
        hasTicket: "ticket" in receipt,
      };
    },
    { node, me },
  );
  expect(result).toEqual({
    dimensions: [16, 12],
    mime: "image/webp",
    cache: "private, no-store",
    wrongVariant: 404,
    hasTicket: false,
  });
  const url = await page.evaluate(
    async ({ node, me }) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const issued = await fetch("/api/v1/content-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({
          purpose: "thumb",
          targets: [{ spaceId: me.spaceId, nodeId: node.id, variant: "sm" }],
          ttlSeconds: 300,
        }),
      });
      if (issued.status !== 201) throw new Error(`fixture_thumb_cookie_ticket_${issued.status}`);
      const { ticket } = await issued.json();
      const accepted = await fetch(`${me.contentOrigin}/session`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (accepted.status !== 201) throw new Error(`fixture_thumb_cookie_${accepted.status}`);
      return `${me.contentOrigin}/c/${node.id}/${node.currentBlobId}?variant=sm`;
    },
    { node, me },
  );
  await decode(page, url, "image/webp");
});

test("an anonymous read link decodes its WebP thumbnail and authorized AVIF original", async ({
  page,
  browser,
}) => {
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
        const thumbTicket = await fetch(`${prefix}/content-session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": token,
            "Share-Session": root.sessionId,
          },
          body: JSON.stringify({
            nodeIds: [nodeId],
            purpose: "thumb",
            variant: "sm",
            delivery: "app",
            ttlSeconds: 300,
          }),
        });
        if (thumbTicket.status !== 201)
          throw new Error(`fixture_public_thumb_ticket_${thumbTicket.status}`);
        const receipt = await thumbTicket.json();
        const thumbnail = await fetch(`${prefix}/thumb/${nodeId}?variant=sm`, {
          headers: { "Share-Session": root.sessionId, "Content-Session": receipt.sessionId },
        });
        if (
          thumbnail.status !== 200 ||
          thumbnail.headers.get("Content-Type") !== "image/webp" ||
          thumbnail.headers.get("Cache-Control") !== "private, no-store"
        )
          throw new Error(`fixture_public_thumb_${thumbnail.status}`);
        const bitmap = await createImageBitmap(await thumbnail.blob());
        const valid = bitmap.width === 16 && bitmap.height === 12;
        bitmap.close();
        if (!valid) throw new Error("fixture_public_thumb_dimensions");
        return `${root.contentOrigin}/c/${nodeId}/${root.root.currentBlobId}`;
      },
      { shareId: share.id, nodeId: node.id },
    );
    await decode(guest, url, "image/avif");
  } finally {
    await context.close();
  }
});
