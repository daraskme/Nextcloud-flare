import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleNodeReadHttp } from "../../src/api/nodes";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { createInternalShare } from "../../src/services/internalShares";
import { listNodeChildren, readNode, readNodePath } from "../../src/services/nodeRead";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture(root: "file" | "folder" = "file") {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const email = `${recipient.ids.user}@example.invalid`;
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...recipient.statements,
    { sql: "UPDATE users SET email=? WHERE id=?", values: [email, recipient.ids.user] },
    {
      sql: "UPDATE nodes SET name='Private ancestor',name_ci='private ancestor' WHERE id=?",
      values: [owner.ids.folder],
    },
  ]);
  const session = {
    credential_id: owner.ids.credential,
    session_id: owner.ids.session,
    user_id: owner.ids.user,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const share = await createInternalShare(mutationEnv(), session, {
    kind: "internal",
    rootNodeId: owner.ids[root],
    recipients: [email],
    role: "read",
  });
  const principal = {
    kind: "user" as const,
    user_id: recipient.ids.user,
    credential_id: recipient.ids.credential,
    epoch: 1,
    selected_share: share,
  };
  return { owner, recipient, session, email, share, principal };
}
it("never reveals ancestors above the explicitly selected shared root in breadcrumbs", async () => {
  const f = await fixture();
  expect((await readNodePath(env.DB, f.principal, f.owner.ids.file)).path).toEqual([
    { id: f.owner.ids.file, name: "File", kind: "file", revision: 1 },
  ]);
});
it("requires an explicit share for another owner's metadata and hides the shared root's parent", async () => {
  const f = await fixture();
  expect(await readNode(env.DB, f.principal, f.owner.ids.file)).toMatchObject({
    parentId: null,
    size: 3,
    ownerId: f.owner.ids.user,
    spaceId: f.owner.ids.space,
  });
  const { selected_share: _selected, ...unscoped } = f.principal;
  await expect(readNodePath(env.DB, unscoped, f.owner.ids.file)).rejects.toThrow(
    "node_unavailable",
  );
  await expect(readNode(env.DB, unscoped, f.owner.ids.file)).rejects.toThrow("node_unavailable");
  await expect(
    readNode(
      env.DB,
      { ...f.principal, user_id: f.owner.ids.user, credential_id: f.owner.ids.credential },
      f.owner.ids.file,
    ),
  ).rejects.toThrow();
});

it("never substitutes a broader share or its edit role for the selected read share", async () => {
  const f = await fixture("folder");
  const broader = await createInternalShare(mutationEnv(), f.session, {
    kind: "internal",
    rootNodeId: f.owner.ids.root,
    recipients: [f.email],
    role: "edit",
  });
  const rename = {
    operation: "node.rename" as const,
    nodeId: f.owner.ids.file,
    spaceId: f.owner.ids.space,
  };
  await expect(authorizeNode(env.DB, f.principal, rename)).rejects.toThrow();
  expect(
    await authorizeNode(env.DB, { ...f.principal, selected_share: broader }, rename),
  ).toMatchObject({ operation: "node.rename" });
  await expect(readNode(env.DB, f.principal, f.owner.ids.root)).rejects.toThrow();
  expect((await readNodePath(env.DB, f.principal, f.owner.ids.file)).path.map((n) => n.id)).toEqual(
    [f.owner.ids.folder, f.owner.ids.file],
  );
  await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?").bind(f.share.id).run();
  await expect(readNodePath(env.DB, f.principal, f.owner.ids.file)).rejects.toThrow();
  expect(
    await readNode(env.DB, { ...f.principal, selected_share: broader }, f.owner.ids.file),
  ).toMatchObject({ id: f.owner.ids.file });
});

it.each([
  "revoke",
  "version",
  "root",
  "credential",
  "recipient",
  "owner",
  "ancestor",
  "maintenance",
  "epoch",
] as const)("rechecks %s in the same metadata snapshot", async (kind) => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("SELECT 1 FROM shares WHERE id=? AND version=? AND root_node_id=?"),
    async () => {
      if (kind === "revoke")
        await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?").bind(f.share.id).run();
      if (kind === "version")
        await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?")
          .bind(f.share.id)
          .run();
      if (kind === "root")
        await env.DB.prepare("UPDATE shares SET root_node_id=? WHERE id=?")
          .bind(f.owner.ids.folder, f.share.id)
          .run();
      if (kind === "credential")
        await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
          .bind(f.recipient.ids.session)
          .run();
      if (kind === "recipient" || kind === "owner")
        await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
          .bind(kind === "owner" ? f.owner.ids.user : f.recipient.ids.user)
          .run();
      if (kind === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
      if (kind === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
      if (kind === "ancestor") {
        const op = crypto.randomUUID();
        await atomicBatch(env.DB, [
          {
            sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,purge_after,epoch) VALUES(?,?,?,?,'trashed',1,9999999999999,1)",
            values: [op, f.owner.ids.user, f.owner.ids.space, f.owner.ids.folder],
          },
          {
            sql: "UPDATE nodes SET deleted_at=1,deleted_op_id=? WHERE id=?",
            values: [op, f.owner.ids.folder],
          },
        ]);
      }
    },
    false,
  );
  await expect(readNodePath(db, f.principal, f.owner.ids.file)).rejects.toThrow();
});

it("binds child pagination to the selected share and version as well as its credential and tree", async () => {
  const f = await fixture("folder");
  await atomicBatch(
    env.DB,
    Array.from({ length: 200 }, (_, i) => ({
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)",
      values: [
        crypto.randomUUID(),
        f.owner.ids.space,
        f.owner.ids.user,
        f.owner.ids.folder,
        `Folder ${i}`,
        `folder ${i}`,
      ],
    })),
  );
  const ring = await contentKeyRing("v1", {
    v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new NodeCursorTokens(ring);
  const first = await listNodeChildren(env.DB, f.principal, f.owner.ids.folder, tokens);
  expect(first.children).toHaveLength(200);
  expect(await tokens.verify(first.nextCursor!)).toMatchObject({
    shareId: f.share.id,
    shareVersion: 1,
  });
  expect(
    (await listNodeChildren(env.DB, f.principal, f.owner.ids.folder, tokens, first.nextCursor!))
      .children,
  ).toHaveLength(1);
  const alternative = await createInternalShare(mutationEnv(), f.session, {
    kind: "internal",
    rootNodeId: f.owner.ids.folder,
    recipients: [f.email],
    role: "read",
  });
  await expect(
    listNodeChildren(
      env.DB,
      { ...f.principal, selected_share: alternative },
      f.owner.ids.folder,
      tokens,
      first.nextCursor!,
    ),
  ).rejects.toThrow("invalid_node_cursor");
  await atomicBatch(env.DB, [
    { sql: "UPDATE shares SET version=2 WHERE id=?", values: [f.share.id] },
    { sql: "UPDATE share_grants SET version=2 WHERE share_id=?", values: [f.share.id] },
  ]);
  await expect(
    listNodeChildren(
      env.DB,
      { ...f.principal, selected_share: { ...f.share, version: 2 } },
      f.owner.ids.folder,
      tokens,
      first.nextCursor!,
    ),
  ).rejects.toThrow("invalid_node_cursor");
});

it("validates the HTTP selection as a pair and refuses old versions without disclosing node metadata", async () => {
  const f = await fixture();
  const app = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const { selected_share: _selected, ...principal } = f.principal;
  const path = `https://app.invalid/api/v1/nodes/${f.owner.ids.file}/path`;
  const get = (q: string) => handleNodeReadHttp(new Request(path + q), app, principal);
  const success = await get(`?shareId=${f.share.id}&shareVersion=1`);
  expect(success.status).toBe(200);
  expect(await success.text()).not.toContain("Private ancestor");
  expect((await get("")).status).toBe(404);
  expect((await get(`?shareId=${f.share.id}&shareVersion=2`)).status).toBe(404);
  for (const q of [
    "?shareId=x",
    "?shareVersion=1",
    "?shareId=x&shareVersion=0",
    "?shareId=x&shareVersion=01",
    "?shareId=x&shareVersion=1&shareId=y",
    "?shareId=x&shareVersion=9007199254740992",
    "?cursor=x",
  ])
    expect((await get(q)).status).toBe(400);
});
