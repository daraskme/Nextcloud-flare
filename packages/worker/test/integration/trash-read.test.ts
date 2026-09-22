import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleTrashHttp, trashRoute } from "../../src/api/trash";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { ListCursorTokens } from "../../src/auth/listCursor";
import { atomicBatch } from "../../src/db/primary";
import { listTrash } from "../../src/services/trashRead";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("authorizes and pages owner trash with a signed generation-bound cursor", async () => {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 10_000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  const deleted = Array.from({ length: 3 }, (_, index) => ({
    opId: `${f.ids.root}-trash-${index}`,
    nodeId: `${f.ids.root}-deleted-${index}`,
    createdAt: now - index,
    name: `Deleted ${index}`,
  }));
  await atomicBatch(
    env.DB,
    deleted.flatMap((item) => [
      {
        sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,purge_after,epoch)
          VALUES(?,?,?,?,'trashed',?,?,1)`,
        values: [item.opId, f.ids.user, f.ids.space, item.nodeId, item.createdAt, now + 86_400_000],
      },
      {
        sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at,
          deleted_at,deleted_op_id,orig_parent_id) VALUES(?,?,?,?,?,?,'folder',?,?,?,?,?)`,
        values: [
          item.nodeId,
          f.ids.space,
          f.ids.user,
          f.ids.root,
          item.name,
          item.name.toLowerCase(),
          item.createdAt,
          item.createdAt,
          item.createdAt,
          item.opId,
          f.ids.root,
        ],
      },
      {
        sql: "INSERT INTO trash_members(trash_op_id,node_id) VALUES(?,?)",
        values: [item.opId, item.nodeId],
      },
    ]),
  );
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cursors = new ListCursorTokens(ring);
  const first = await listTrash(env.DB, principal, cursors, f.ids.space, undefined, 2);
  expect(first.items.map((item) => item.name)).toEqual(["Deleted 0", "Deleted 1"]);
  expect(first.items[0]).toMatchObject({ kind: "folder", memberCount: 1 });
  expect(first.nextCursor).toBeTruthy();
  const second = await listTrash(
    env.DB,
    principal,
    cursors,
    f.ids.space,
    first.nextCursor ?? "",
    2,
  );
  expect(second.items.map((item) => item.name)).toEqual(["Deleted 2"]);
  expect(second.nextCursor).toBeNull();

  const wrong = `${first.nextCursor?.slice(0, -1)}${first.nextCursor?.endsWith("x") ? "y" : "x"}`;
  await expect(listTrash(env.DB, principal, cursors, f.ids.space, wrong)).rejects.toThrow(
    "invalid_list_cursor",
  );
  await expect(
    new ListCursorTokens(ring, () => Date.now() + 601_000).verify(first.nextCursor ?? ""),
  ).rejects.toThrow("invalid_list_cursor");
  await expect(
    listTrash(env.DB, { ...principal, user_id: "other" }, cursors, f.ids.space),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(f.ids.space)
    .run();
  await expect(
    listTrash(env.DB, principal, cursors, f.ids.space, first.nextCursor ?? ""),
  ).rejects.toThrow("invalid_list_cursor");
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation-1 WHERE id=?")
    .bind(f.ids.space)
    .run();

  const request = new Request(`https://app.invalid/api/v1/trash?spaceId=${f.ids.space}`);
  expect(trashRoute(request)).toBe(true);
  const response = await handleTrashHttp(
    request,
    { ...env, APP_ORIGIN: "https://app.invalid" },
    principal,
    cursors,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = (await response.json()) as { items: { name: string }[] };
  expect(body.items).toHaveLength(3);
  expect(body.items[0]?.name).toBe("Deleted 0");
  expect(
    (
      await handleTrashHttp(
        new Request(`https://app.invalid/api/v1/trash?spaceId=${f.ids.space}&extra=x`),
        { ...env, APP_ORIGIN: "https://app.invalid" },
        principal,
        cursors,
      )
    ).status,
  ).toBe(400);
  await env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1").run();
  await expect(listTrash(env.DB, principal, cursors, f.ids.space)).rejects.toThrow();
});
