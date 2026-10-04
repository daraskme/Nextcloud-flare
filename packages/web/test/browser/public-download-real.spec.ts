import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { writeTestBytes } from "./uploadHelpers";

test("real public share downloads exact uploaded bytes anonymously and rejects access after revocation", async ({
  page,
  browser,
}) => {
  const appOrigin = "https://app.ncf.test:8879";
  const contentOrigin = "https://content.ncf.test:8879";
  const filename = `public-bytes-${crypto.randomUUID()}.bin`;
  const original = Buffer.from(Array.from({ length: 16_384 }, (_, index) => (index * 31) % 256));
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  const node = await writeTestBytes(page, filename, original);
  await page.reload();
  await expect(page.getByRole("button", { name: `${filename}の操作`, exact: true })).toBeVisible();
  const share = await page.evaluate(async (rootNodeId) => {
    const me = await fetch("/api/v1/me").then((response) => response.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((response) =>
      response.json(),
    );
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({ rootNodeId, spaceId: me.spaceId, kind: "link", ttlDays: 1 }),
    });
    if (response.status !== 201) throw new Error(`public_share_create_${response.status}`);
    return response.json() as Promise<{ id: string; secret: string }>;
  }, node.id);

  const anonymous = await browser.newContext();
  try {
    // Disable the harness's default owner injection. Every response still comes from the real API.
    await anonymous.route(/^https:\/\/(?:app|content)\.ncf\.test:8879\//, (route) =>
      route.continue({
        headers: { ...route.request().headers(), "x-test-without-auth": "1" },
      }),
    );
    expect(await anonymous.cookies()).toEqual([]);
    const publicPage = await anonymous.newPage();
    const requests: Array<{ method: string; origin: string; path: string }> = [];
    publicPage.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.endsWith("/tickets") ||
        url.pathname === "/session" ||
        url.pathname.startsWith("/c/")
      )
        requests.push({ method: request.method(), origin: url.origin, path: url.pathname });
    });
    await publicPage.goto(`${appOrigin}/s/${share.id}#${share.secret}`);
    const fileButton = publicPage.locator(".node-row .node-button").filter({ hasText: filename });
    await expect(fileButton).toBeVisible();
    expect(new URL(publicPage.url()).hash).toBe("");
    expect(
      await publicPage.evaluate(() => fetch("/api/v1/me").then((response) => response.status)),
    ).toBe(401);
    expect(
      (await anonymous.cookies()).some((cookie) => cookie.name === "__Host-ncf-test-identity"),
    ).toBe(false);

    const ticketPath = `/api/v1/public/shares/${share.id}/tickets`;
    const contentPath = `/c/${node.id}/${node.currentBlobId}`;
    const ticketResponse = publicPage.waitForResponse(
      (response) =>
        response.url() === `${appOrigin}${ticketPath}` && response.request().method() === "POST",
    );
    const sessionResponse = publicPage.waitForResponse(
      (response) =>
        response.url() === `${contentOrigin}/session` && response.request().method() === "POST",
    );
    const downloadPromise = publicPage.waitForEvent("download");
    await fileButton.click();
    const [ticket, session, download] = await Promise.all([
      ticketResponse,
      sessionResponse,
      downloadPromise,
    ]);
    expect(ticket.status()).toBe(201);
    expect(session.status()).toBe(201);
    expect(download.suggestedFilename()).toBe(filename);
    expect(await readFile(await download.path())).toEqual(original);
    expect(requests).toEqual([
      { method: "POST", origin: appOrigin, path: ticketPath },
      { method: "POST", origin: contentOrigin, path: "/session" },
      { method: "GET", origin: contentOrigin, path: contentPath },
    ]);

    const revoked = await page.evaluate(async (shareId) => {
      const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((response) =>
        response.json(),
      );
      return (
        await fetch(`/api/v1/shares/${shareId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        })
      ).status;
    }, share.id);
    expect(revoked).toBe(204);
    const denied = await publicPage.evaluate(
      async ({ ticketUrl, contentUrl, csrf, body }) => {
        const ticket = await fetch(ticketUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body,
        });
        const content = await fetch(contentUrl, { credentials: "include", cache: "no-store" });
        return { ticket: ticket.status, content: content.status };
      },
      {
        ticketUrl: ticketPath,
        contentUrl: `${contentOrigin}${contentPath}`,
        csrf: ticket.request().headers()["x-csrf-token"]!,
        body: ticket.request().postData()!,
      },
    );
    expect(denied).toEqual({ ticket: 401, content: 404 });
    await publicPage.reload();
    await expect(
      publicPage.getByRole("heading", { name: "共有リンクを開けません", exact: true }),
    ).toBeVisible();
    await expect(publicPage.locator(".node-row .node-button")).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
});
