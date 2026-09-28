import { expect, test } from "@playwright/test";
import { fileContent, rootFile } from "./uploadHelpers";

test.setTimeout(180000);
test("anonymous public uploads use the real admission, single and multipart storage, and completion routes", async ({
  page,
  browser,
}) => {
  await page.request.post("https://127.0.0.1:8879/__test__/access-login", {
    headers: { Host: "app.ncf.test:8879" },
  });
  await page.goto("/files");
  const link = await page.evaluate(async () => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const csrf = await fetch("/api/v1/csrf", { method: "POST" }).then((r) => r.json());
    const response = await fetch("/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({ kind: "link", rootNodeId: me.rootNodeId, role: "edit" }),
    });
    if (response.status !== 201) throw new Error(`link_create_${response.status}`);
    return response.json() as Promise<{ id: string; secret: string }>;
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
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
  try {
    const guest = await context.newPage();
    await guest.goto("https://app.ncf.test:8879/__test__/ready");
    const unlock = () =>
      guest.evaluate(async ({ id, secret }) => {
        const challenge = await fetch(`/api/v1/public/shares/${id}/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step: "challenge" }),
        }).then((r) => r.json());
        const response = await fetch(`/api/v1/public/shares/${id}/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": challenge.token },
          body: JSON.stringify({ secret }),
        });
        return { status: response.status, retry: Number(response.headers.get("Retry-After")) };
      }, link);
    let opened = await unlock();
    if (opened.status === 429) {
      expect(opened.retry).toBeGreaterThan(0);
      expect(opened.retry).toBeLessThanOrEqual(60);
      await guest.waitForTimeout(opened.retry * 1000 + 50);
      opened = await unlock();
    }
    expect(opened.status).toBe(200);
    expect(await guest.evaluate(async () => (await fetch("/api/v1/me")).status)).toBe(401);
    const created = await guest.evaluate(async ({ id }) => {
      const base = `/api/v1/public/shares/${id}`;
      const json = async (path: string, init?: RequestInit) => {
        const response = await fetch(path, init);
        if (!response.ok) throw new Error(`public_upload_${response.status}_${path}`);
        return response.json();
      };
      const root = await json(base);
      const csrf = await json(`${base}/csrf`, { method: "POST" });
      const headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.token,
        "Share-Session": root.sessionId,
      };
      const result: { name: string; value: string; nodeId: string }[] = [];
      for (const mode of ["single", "multipart"]) {
        const name = `public-${mode}-${crypto.randomUUID()}.txt`,
          value = `公開 ${mode}`;
        const request = {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            mode,
            parentId: root.root.id,
            name,
            declared_size: new TextEncoder().encode(value).length,
          }),
        };
        const receipt = await json(`${base}/uploads`, request);
        const replay = await json(`${base}/uploads`, request);
        if (replay.id !== receipt.id || replay.capability !== receipt.capability)
          throw new Error("public_reservation_replayed_differently");
        const capability = {
          "Upload-Capability": receipt.capability,
          "Share-Session": root.sessionId,
        };
        await json(`${base}/uploads/${receipt.id}/${mode === "single" ? "content" : "parts/1"}`, {
          method: "PUT",
          headers: { ...capability, "Upload-Attempt-Id": "first" },
          body: value,
        });
        const complete = {
          method: "POST",
          headers: { ...headers, ...capability, "Idempotency-Key": crypto.randomUUID() },
          body: "{}",
        };
        const operation = await json(`${base}/uploads/${receipt.id}/complete`, complete);
        const repeated = await json(`${base}/uploads/${receipt.id}/complete`, complete);
        if (operation.state !== "committed" || repeated.id !== operation.id)
          throw new Error("public_completion_not_committed");
        const status = await json(`${base}/uploads/${receipt.id}`, { headers: capability });
        if (status.state !== "completed") throw new Error("public_status_not_completed");
        const lookup = await json(`/api/v1/operations/${operation.id}`, {
          headers: { "X-Share-Id": id, "Share-Session": root.sessionId },
        });
        if (lookup.id !== operation.id) throw new Error("public_receipt_mismatch");
        result.push({ name, value, nodeId: operation.result.nodeId });
      }
      return result;
    }, link);
    for (const item of created) {
      const node = await rootFile(page, item.name);
      expect(node.id).toBe(item.nodeId);
      expect(await fileContent(page, node)).toBe(item.value);
    }
  } finally {
    await context.close();
  }
});
