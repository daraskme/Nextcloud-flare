import { expect, test } from "@playwright/test";
import { login, upload } from "./imageHelpers";

test("Audio HTTP saves each reader's current-blob position and rejects stale tabs and revoked shares", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await login(page);
  const media = await upload(page, "opus.ogg", undefined, "tracks");
  const owner = await page.evaluate(
    async ({ id, root }) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const listed = await fetch(`/api/v1/nodes/${root}/tracks`).then((r) => r.json());
      const item = listed.items.find((x: { id: string }) => x.id === id);
      if (!item) throw new Error("track_missing");
      const body = {
        blobId: item.currentBlobId,
        generator: listed.generator,
        positionMs: 700,
        previousUpdatedAt: null,
      };
      const save = () =>
        fetch(`/api/v1/nodes/${id}/playback-state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify(body),
        });
      const first = await save();
      if (first.status !== 200) throw new Error(`state_http_${first.status}`);
      const state = await first.json();
      return { item, state, stale: (await save()).status, generator: listed.generator };
    },
    { id: media.node.id, root: media.me.rootNodeId },
  );
  expect(owner.item).toMatchObject({ title: "テスト曲", artist: "Local fixture", playback: null });
  expect(owner.state.positionMs).toBe(700);
  expect(owner.stale).toBe(409);
  await page.reload();
  expect(
    await page.evaluate(
      async (id) =>
        (await fetch(`/api/v1/nodes/${id}/tracks`).then((r) => r.json())).items[0].playback,
      media.node.id,
    ),
  ).toEqual(owner.state);
  const share = await page.evaluate(async (rootNodeId) => {
    const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({
        kind: "internal",
        rootNodeId,
        role: "read",
        recipients: ["recipient@example.invalid"],
      }),
    });
    if (response.status !== 201) throw new Error(`share_http_${response.status}`);
    return response.json();
  }, media.node.id);
  const context = await browser.newContext({
    baseURL: "https://app.ncf.test:8879",
    ignoreHTTPSErrors: true,
  });
  try {
    await context.addCookies([
      {
        name: "ncf-test-user",
        value: "recipient",
        domain: ".ncf.test",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.request.post("https://127.0.0.1:8879/__test__/access-login", {
      headers: { Host: "app.ncf.test:8879", "X-Test-Access-Identity": "recipient" },
    });
    const guest = await context.newPage();
    await guest.goto("/files");
    const input = {
      id: media.node.id,
      blobId: media.node.currentBlobId,
      generator: owner.generator,
      share: { id: share.id, version: 1 },
    };
    const recipient = await guest.evaluate(async (input) => {
      const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
      const listed = await fetch(
        `/api/v1/nodes/${input.id}/tracks?shareId=${input.share.id}&shareVersion=1`,
      ).then((r) => r.json());
      const body = {
        blobId: input.blobId,
        generator: input.generator,
        positionMs: 1200,
        previousUpdatedAt: null,
        share: input.share,
      };
      const result = await fetch(`/api/v1/nodes/${input.id}/playback-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify(body),
      });
      if (result.status !== 200) throw new Error(`shared_state_http_${result.status}`);
      return { prior: listed.items[0].playback, saved: await result.json() };
    }, input);
    expect(recipient.prior).toBeNull();
    expect(recipient.saved.positionMs).toBe(1200);
    expect(
      await page.evaluate(
        async (id) =>
          (await fetch(`/api/v1/nodes/${id}/tracks`).then((r) => r.json())).items[0].playback,
        media.node.id,
      ),
    ).toEqual(owner.state);
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
      }, share.id),
    ).toBe(200);
    const revoked = await guest.evaluate(
      async ({ input, updatedAt }) => {
        const { token } = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
        const read = await fetch(
          `/api/v1/nodes/${input.id}/tracks?shareId=${input.share.id}&shareVersion=1`,
        );
        const saved = await fetch(`/api/v1/nodes/${input.id}/playback-state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
          body: JSON.stringify({
            blobId: input.blobId,
            generator: input.generator,
            positionMs: 1000,
            previousUpdatedAt: updatedAt,
            share: input.share,
          }),
        });
        return [read.status, saved.status];
      },
      { input, updatedAt: recipient.saved.updatedAt },
    );
    expect(revoked).toEqual([404, 404]);
  } finally {
    await context.close();
  }
});
