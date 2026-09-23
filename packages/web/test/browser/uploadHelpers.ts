import { expect, type Page } from "@playwright/test";
import type { FileNode } from "../../src/lib/api";

export async function rootFile(page: Page, name: string): Promise<FileNode> {
  return page.evaluate(async (name) => {
    const me = await fetch("/api/v1/me").then((r) => r.json());
    const result = await fetch(`/api/v1/nodes/${me.rootNodeId}/children`).then((r) => r.json());
    const node = result.children.find((node: { name: string }) => node.name === name);
    if (!node) throw new Error("test_file_missing");
    return node;
  }, name);
}

/** Seed/concurrent actor through the real private upload API, without modifying fixture storage. */
export async function writeTestFile(page: Page, name: string, value: string, target?: FileNode) {
  await page.evaluate(
    async ({ name, value, target }) => {
      const json = async (path: string, init?: RequestInit) => {
        const response = await fetch(path, init);
        if (!response.ok) throw new Error(`test_http_${response.status}_${path}`);
        return response.json();
      };
      const me = await json("/api/v1/me");
      const csrf = await json("/api/v1/csrf", { method: "POST" });
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf.token };
      const receipt = await json("/api/v1/uploads", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          mode: "single",
          spaceId: me.spaceId,
          parentId: me.rootNodeId,
          name,
          declared_size: new TextEncoder().encode(value).length,
          ...(target ? { targetId: target.id, targetRevision: target.revision } : {}),
        }),
      });
      const capability = { "Upload-Capability": receipt.capability };
      await json(`/api/v1/uploads/${receipt.id}/content`, {
        method: "PUT",
        headers: {
          ...capability,
          ...(target ? { "If-Match": `"b-${target.currentBlobId}"` } : {}),
        },
        body: value,
      });
      await json(`/api/v1/uploads/${receipt.id}/complete`, {
        method: "POST",
        headers: { ...headers, ...capability, "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      });
    },
    { name, value, target },
  );
  return rootFile(page, name);
}

export async function fileContent(page: Page, node: FileNode, range?: string) {
  return page.evaluate(
    async ({ node, range }) => {
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
      if (issued.status !== 201) throw new Error(`test_ticket_${issued.status}`);
      const ticket = await issued.json();
      const accepted = await fetch(`${me.contentOrigin}/session`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: ticket.ticket }),
      });
      if (accepted.status !== 201) throw new Error(`test_exchange_${accepted.status}`);
      const response = await fetch(`${me.contentOrigin}/c/${node.id}/${node.currentBlobId}`, {
        credentials: "include",
        ...(range ? { headers: { Range: range } } : {}),
      });
      if (!response.ok) throw new Error(`test_content_${response.status}`);
      return response.text();
    },
    { node, range },
  );
}

export async function openOverwrite(page: Page, name: string) {
  await page.getByRole("button", { name: `${name}の操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "ファイルを上書き", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ファイルを上書き" })).toBeVisible();
}
