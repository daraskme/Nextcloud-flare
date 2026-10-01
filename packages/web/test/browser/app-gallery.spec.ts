import { expect, test } from "@playwright/test";

test("Gallery cancels thumbnail and original tickets when switching views", async ({ page }) => {
  const issued: Array<{ id: string; purpose: string }> = [];
  const cancelled: string[] = [];
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        id: "gallery-user",
        email: "gallery@example.invalid",
        role: "owner",
        spaceId: "gallery-space",
        rootNodeId: "gallery-root",
        epoch: 1,
        quotaBytes: 1_000_000,
        usedBytes: 0,
        reservedBytes: 0,
        contentOrigin: "https://content.ncf.test:8879",
      },
    }),
  );
  await page.route("**/api/v1/csrf", (route) => route.fulfill({ json: { token: "gallery-csrf" } }));
  await page.route("**/api/v1/nodes/gallery-root/gallery?*", (route) =>
    route.fulfill({
      json: {
        rootId: "gallery-root",
        treeGeneration: 1,
        recursive: true,
        items: [
          {
            id: "photo",
            name: "Photo.avif",
            currentBlobId: "photo-blob",
            mime: "image/avif",
            size: 128,
            width: 32,
            height: 32,
            takenAt: null,
            updatedAt: Date.now(),
            thumbnail: "ready",
          },
        ],
        nextCursor: null,
        truncated: false,
        candidateLimit: 10_000,
      },
    }),
  );
  await page.route("**/api/v1/content-session", (route) => {
    const id = `gallery-ticket-${issued.length + 1}`;
    issued.push({ id, purpose: route.request().postDataJSON().purpose });
    return route.fulfill({ status: 201, json: { ticket: id, ticketId: id } });
  });
  await page.route("**/api/v1/tickets/*", (route) => {
    if (route.request().method() === "DELETE")
      cancelled.push(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("https://content.ncf.test:8879/session", (route) =>
    route.fulfill({
      status: 201,
      headers: {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": "https://app.ncf.test:8879",
      },
      body: "",
    }),
  );
  await page.route("https://content.ncf.test:8879/c/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlqH4sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );

  await page.goto("/files");
  await page.getByRole("link", { name: "ギャラリー", exact: true }).click();
  await expect(page.locator(".gallery-card img")).toHaveAttribute("src", /\/thumb$/);
  expect(issued.map((ticket) => ticket.purpose)).toEqual(["thumb"]);

  await page.getByRole("button", { name: /Photo\.avif/ }).click();
  await expect.poll(() => cancelled).toContain(issued[0]!.id);
  await expect(page.getByRole("dialog", { name: "Photo.avif" }).locator("img")).toHaveAttribute(
    "src",
    /\/c\/photo\/photo-blob$/,
  );
  expect(issued.at(-1)?.purpose).toBe("content");
  const originalId = issued.at(-1)!.id;

  await page.getByRole("button", { name: "写真を閉じる" }).click();
  await expect.poll(() => cancelled).toContain(originalId);
  await expect.poll(() => issued.filter((ticket) => ticket.purpose === "thumb")).toHaveLength(2);
  const refreshedThumbId = issued.at(-1)!.id;
  await page.getByRole("link", { name: "マイドライブ", exact: true }).click();
  await expect.poll(() => cancelled).toContain(refreshedThumbId);
});
