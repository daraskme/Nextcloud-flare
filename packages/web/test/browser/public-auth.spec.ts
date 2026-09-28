import { expect, type Page, test } from "@playwright/test";

test.setTimeout(120000); // The real rate ledger intentionally waits 60s after first initialization.
async function create(page: Page, password?: string) {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
  await expect(page.getByRole("button", { name: "新規フォルダー", exact: true })).toBeVisible();
  return page.evaluate(async (password) => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({
        kind: "link",
        rootNodeId: me.rootNodeId,
        role: "read",
        ...(password ? { password } : {}),
      }),
    });
    if (response.status !== 201) throw new Error(`link_create_${response.status}`);
    const saved: { id: string; version: number; secret: string } = await response.json();
    return { ...saved, root: me.rootNodeId };
  }, password);
}
async function post(page: Page, id: string, action: string, body?: unknown, token?: string) {
  return page.evaluate(
    async ({ id, action, body, token }) => {
      const response = await fetch(`/api/v1/public/shares/${id}/${action}`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { "X-CSRF-Token": token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        retry: response.headers.get("Retry-After"),
        body: response.status === 204 ? null : await response.json(),
      };
    },
    { id, action, body, token },
  );
}
async function unlock(page: Page, id: string, body: unknown, token: string) {
  let result = await post(page, id, "unlock", body, token);
  if (result.status === 429) {
    const seconds = Number(result.retry);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    await page.waitForTimeout(seconds * 1000 + 50);
    result = await post(page, id, "unlock", body, token);
  }
  return result;
}
test("anonymous browser unlocks a password link, reuses its cookie across tabs and logs out with public CSRF", async ({
  page,
  browser,
}) => {
  const link = await create(page, " 日本語🔑 ");
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Test-Without-Auth": "1" },
  });
  try {
    const guest = await context.newPage();
    // A same-origin test document only: the public landing UI is a separate implementation step.
    await guest.goto("https://app.ncf.test:8879/__test__/ready");
    expect(await guest.evaluate(async () => (await fetch("/api/v1/me")).status)).toBe(401);
    const challenge = await post(guest, link.id, "unlock", { step: "challenge" });
    expect(challenge.status).toBe(200);
    expect(
      (
        await unlock(
          guest,
          link.id,
          { secret: link.secret, password: "wrong" },
          challenge.body.token,
        )
      ).status,
    ).toBe(401);
    const opened = await post(
      guest,
      link.id,
      "unlock",
      { secret: link.secret, password: " 日本語🔑 " },
      challenge.body.token,
    );
    expect(opened.status).toBe(200);
    const cookie = (await context.cookies()).find((c) => c.name === `__Host-ncf_share_${link.id}`)!;
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      domain: "app.ncf.test",
    });
    expect(cookie.expires).toBeLessThanOrEqual(Date.now() / 1000 + 604800);
    expect(await guest.evaluate(() => document.cookie)).not.toContain("ncf_share");
    const tab = await context.newPage();
    await tab.goto("https://app.ncf.test:8879/__test__/ready");
    expect((await post(tab, link.id, "unlock", { step: "challenge" })).body).toEqual(opened.body);
    expect(
      await tab.evaluate(
        async (id) =>
          (await fetch(`/__test__/share-session-count/${id}`).then((r) => r.json())).count,
        link.id,
      ),
    ).toBe(1);
    const csrf = await post(tab, link.id, "csrf");
    expect(csrf.status).toBe(200);
    expect((await post(tab, link.id, "logout", {}, csrf.body.token)).status).toBe(204);
    expect((await post(guest, link.id, "csrf")).status).toBe(401);
    expect((await context.cookies()).some((c) => c.name === cookie.name)).toBe(false);
  } finally {
    await context.close();
  }
});
test("a lost unlock reply reuses the recorded credential and an owner change invalidates the cookie", async ({
  page,
  browser,
}) => {
  const link = await create(page);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Test-Without-Auth": "1" },
  });
  try {
    const guest = await context.newPage();
    await guest.goto("https://app.ncf.test:8879/__test__/ready");
    const challenge = await post(guest, link.id, "unlock", { step: "challenge" });
    const path = `**/api/v1/public/shares/${link.id}/unlock`;
    await guest.route(path, async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace("app.ncf.test", "127.0.0.1"),
        headers: {
          ...(await route.request().allHeaders()),
          host: "app.ncf.test:8879",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(response.status()).toBe(200);
      await route.abort("connectionfailed");
    });
    await expect(
      post(guest, link.id, "unlock", { secret: link.secret }, challenge.body.token),
    ).rejects.toThrow();
    await guest.unroute(path);
    // route.fetch may retain response cookies in Playwright's context; model their loss explicitly.
    await context.clearCookies({ name: `__Host-ncf_share_${link.id}` });
    expect(
      (await post(guest, link.id, "unlock", { secret: link.secret }, challenge.body.token)).status,
    ).toBe(200);
    expect(
      await guest.evaluate(
        async (id) =>
          (await fetch(`/__test__/share-session-count/${id}`).then((r) => r.json())).count,
        link.id,
      ),
    ).toBe(1);
    expect(
      await page.evaluate(async ({ id, root }) => {
        const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
        return (
          await fetch(`/api/v1/shares/${id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": token,
              "If-Match": '"share-1"',
            },
            body: JSON.stringify({
              kind: "link",
              rootNodeId: root,
              role: "read",
              rotateSecret: true,
            }),
          })
        ).status;
      }, link),
    ).toBe(200);
    expect((await post(guest, link.id, "csrf")).status).toBe(401);
  } finally {
    await context.close();
  }
});
