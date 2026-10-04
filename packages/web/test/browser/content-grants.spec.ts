import { expect, test } from "@playwright/test";
import { writeTestFile } from "./uploadHelpers";

test("concurrent tabs retain distinct content grants, Range reads and independent cancellation", async ({
  page,
  context,
}) => {
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "マイドライブ", exact: true })).toBeVisible();
  const suffix = crypto.randomUUID();
  const a = await writeTestFile(page, `grant-a-${suffix}.txt`, "abcdef");
  const b = await writeTestFile(page, `grant-b-${suffix}.txt`, "uvwxyz");
  const second = await context.newPage();
  await second.goto("/files");
  const exchange = async (tab: typeof page, node: typeof a) =>
    tab.evaluate(async (node) => {
      const me = await fetch("/api/v1/me").then((r) => r.json());
      const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const issued = await fetch("/api/v1/content-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
        body: JSON.stringify({
          targets: [{ spaceId: me.spaceId, nodeId: node.id }],
          purpose: "content",
          ttlSeconds: 300,
        }),
      });
      if (!issued.ok) throw new Error(`content_issue_${issued.status}`);
      const ticket = await issued.json();
      const accepted = await fetch(`${me.contentOrigin}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: ticket.ticket }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
      return {
        status: accepted.status,
        ticketId: ticket.ticketId,
        url: `${me.contentOrigin}/c/${node.id}/${node.currentBlobId}`,
      };
    }, node);
  const [grantA, grantB] = await Promise.all([exchange(page, a), exchange(second, b)]);
  expect([grantA.status, grantB.status]).toEqual([201, 201]);
  const read = (tab: typeof page, url: string) =>
    tab.evaluate(async (url) => {
      const response = await fetch(url, {
        credentials: "include",
        headers: { Range: "bytes=1-3" },
        cache: "no-store",
      });
      return {
        status: response.status,
        range: response.headers.get("Content-Range"),
        body: await response.text(),
      };
    }, url);
  expect(await read(page, grantA.url)).toEqual({ status: 206, range: "bytes 1-3/6", body: "bcd" });
  expect(await read(second, grantB.url)).toEqual({
    status: 206,
    range: "bytes 1-3/6",
    body: "vwx",
  });
  expect(new URL(grantA.url).search).toBe("");
  const grants = (await context.cookies(new URL(grantA.url).origin)).filter((c) =>
    c.name.startsWith("__Host-ncf_cs_"),
  );
  expect(grants).toHaveLength(2);
  expect(
    grants.every((c) => c.httpOnly && c.secure && c.sameSite === "None" && c.path === "/"),
  ).toBe(true);
  expect((await read(page, grantA.url + "/thumb")).status).toBe(404);
  const cancelled = await page.evaluate(async (id) => {
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    return (
      await fetch(`/api/v1/tickets/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      })
    ).status;
  }, grantA.ticketId);
  expect(cancelled).toBe(204);
  expect((await read(page, grantA.url)).status).toBe(404);
  expect((await read(second, grantB.url)).body).toBe("vwx");
  await second.close();
});
