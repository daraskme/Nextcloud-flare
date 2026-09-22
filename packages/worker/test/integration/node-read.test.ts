import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleNodeReadHttp } from "../../src/api/nodes";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { listNodeChildren, readNode } from "../../src/services/nodeRead";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("authorizes metadata and pages 201 children with a signed generation-bound cursor", async () => {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cursors = new NodeCursorTokens(ring);
  expect((await readNode(env.DB, principal, f.ids.folder)).kind).toBe("folder");
  await expect(
    readNode(env.DB, { ...principal, user_id: "other" }, f.ids.folder),
  ).rejects.toThrow();
  const children = Array.from({ length: 200 }, (_, index) => ({
    sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'folder',?,?)`,
    values: [
      crypto.randomUUID(),
      f.ids.space,
      f.ids.user,
      f.ids.folder,
      `Folder ${String(index).padStart(3, "0")}`,
      `folder ${String(index).padStart(3, "0")}`,
      now,
      now,
    ],
  }));
  await atomicBatch(env.DB, children);
  const first = await listNodeChildren(env.DB, principal, f.ids.folder, cursors);
  expect(first.children).toHaveLength(200);
  expect(first.nextCursor).toBeTruthy();
  const next = await listNodeChildren(
    env.DB,
    principal,
    f.ids.folder,
    cursors,
    first.nextCursor ?? "",
  );
  expect(next.children).toHaveLength(1);
  expect(next.children[0]?.name).toBe("Folder 199");
  expect(next.nextCursor).toBeNull();
  const wrong = `${first.nextCursor?.slice(0, -1)}${first.nextCursor?.endsWith("x") ? "y" : "x"}`;
  await expect(listNodeChildren(env.DB, principal, f.ids.folder, cursors, wrong)).rejects.toThrow(
    "invalid_node_cursor",
  );
  await expect(
    new NodeCursorTokens(ring, () => Date.now() + 601_000).verify(first.nextCursor ?? ""),
  ).rejects.toThrow("invalid_node_cursor");
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(f.ids.space)
    .run();
  await expect(
    listNodeChildren(env.DB, principal, f.ids.folder, cursors, first.nextCursor ?? ""),
  ).rejects.toThrow("invalid_node_cursor");
  const response = await handleNodeReadHttp(
    new Request(
      `https://app.invalid/api/v1/nodes/${f.ids.folder}/children?cursor=${first.nextCursor}`,
    ),
    { ...env, APP_ORIGIN: "https://app.invalid" },
    principal,
    cursors,
  );
  expect(response.status).toBe(400);
  await env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1").run();
  await expect(readNode(env.DB, principal, f.ids.folder)).rejects.toThrow();
  await expect(listNodeChildren(env.DB, principal, f.ids.folder, cursors)).rejects.toThrow();
});
