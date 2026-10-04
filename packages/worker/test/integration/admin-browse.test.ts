import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleAdminBrowseHttp } from "../../src/api/adminBrowse";
import { handleContentHttp } from "../../src/api/content";
import { authorizeNode } from "../../src/auth/authorize";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { BudgetDO } from "../../src/do/BudgetDO";
import type { Env } from "../../src/env";
import { issueContentTicket } from "../../src/services/contentTicket";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function setup() {
  const now = Date.now();
  const admin = foundationFixture(crypto.randomUUID(), now - 1000);
  const member = foundationFixture(crypto.randomUUID(), now - 1000);
  const standby = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, [...admin.statements, ...member.statements, ...standby.statements]);
  await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(member.ids.user).run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,bootstrap_done_at=1").run();
  const blobKey = `u/${member.ids.user}/b/${member.ids.blob}`;
  const object = await env.BLOBS.put(blobKey, "abc");
  if (!object) throw new Error("fixture_blob_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(member.ids.blob, object.etag, now)
    .run();
  const ring = await contentKeyRing("one", {
    one: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ContentTokens(ring, ring, "https://content.invalid");
  const cursors = new NodeCursorTokens(ring);
  const app = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
    BLOBS: env.BLOBS,
    BUDGETS: {
      idFromName: env.BUDGETS.idFromName.bind(env.BUDGETS),
      get(id: DurableObjectId) {
        const stub = env.BUDGETS.get(id);
        return {
          async reserve(input: Parameters<BudgetDO["reserve"]>[0]) {
            const result = await runInDurableObject(stub, async (_, state) => {
              try {
                return { ok: true as const, lease: await new BudgetDO(state, env).reserve(input) };
              } catch (error) {
                return {
                  ok: false as const,
                  message: error instanceof Error ? error.message : "budget_failed",
                };
              }
            });
            if (!result.ok) throw new Error(result.message);
            return result.lease;
          },
          settle: (request: Parameters<BudgetDO["settle"]>[0]) => stub.settle(request),
          status: () => stub.status(),
        };
      },
    } as unknown as Env["BUDGETS"],
  } as Env;
  const session = {
    credential_id: admin.ids.credential,
    session_id: admin.ids.session,
    user_id: admin.ids.user,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: now + 599000,
  };
  const memberSession = {
    credential_id: member.ids.credential,
    session_id: member.ids.session,
    user_id: member.ids.user,
    role: "member" as const,
    epoch: 1,
    expires_at: now + 599000,
  };
  const csrf = { verify: async () => {} };
  const handle = (request: Request) =>
    handleAdminBrowseHttp(request, app, session, csrf, tokens, cursors);
  return { admin, member, blobKey, tokens, app, session, memberSession, csrf, cursors, handle };
}

it("lists users and audits only authorized administrator metadata reads", async () => {
  const f = await setup();
  try {
    const users = await f.handle(new Request("https://app.invalid/api/v1/admin/users"));
    expect(users.status).toBe(200);
    expect((await users.json<{ users: Array<{ id: string }> }>()).users.map((u) => u.id)).toContain(
      f.member.ids.user,
    );
    const path = `https://app.invalid/api/v1/admin/users/${f.member.ids.user}/nodes/${f.member.ids.folder}/children`;
    const children = await f.handle(new Request(path));
    expect(children.status).toBe(200);
    expect(await children.json()).toMatchObject({ children: [{ id: f.member.ids.file }] });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM admin_browse_audit WHERE actor_id=? AND owner_id=? AND node_id=? AND action='metadata'",
      )
        .bind(f.admin.ids.user, f.member.ids.user, f.member.ids.folder)
        .first("COUNT(*)"),
    ).toBe(1);
    await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.admin.ids.user).run();
    expect((await f.handle(new Request(path))).status).toBe(403);
  } finally {
    await env.BLOBS.delete(f.blobKey);
  }
});

it("keeps member, app password, wrong owner and wrong space outside admin browse", async () => {
  const f = await setup();
  try {
    const nodeUrl = `https://app.invalid/api/v1/admin/users/${f.member.ids.user}/nodes/${f.member.ids.file}`;
    expect(
      (
        await handleAdminBrowseHttp(
          new Request(nodeUrl),
          f.app,
          f.memberSession,
          f.csrf,
          f.tokens,
          f.cursors,
        )
      ).status,
    ).toBe(403);
    const forged = { ...f.session, credential_id: `ap:${crypto.randomUUID()}` };
    expect(
      (
        await handleAdminBrowseHttp(
          new Request(nodeUrl),
          f.app,
          forged,
          f.csrf,
          f.tokens,
          f.cursors,
        )
      ).status,
    ).toBe(403);
    const wrongOwner = nodeUrl.replace(f.member.ids.user, f.admin.ids.user);
    expect((await f.handle(new Request(wrongOwner))).status).toBe(404);
    const wrongSpace = await f.handle(
      new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: [{ spaceId: f.admin.ids.space, nodeId: f.member.ids.file }],
          purpose: "content",
          ttlSeconds: 120,
          action: "preview",
        }),
      }),
    );
    expect(wrongSpace.status).toBe(404);
    await expect(
      authorizeNode(
        env.DB,
        {
          kind: "admin_read",
          user_id: f.admin.ids.user,
          owner_id: f.member.ids.user,
          credential_id: f.admin.ids.credential,
          epoch: 1,
        },
        { operation: "node.rename", spaceId: f.member.ids.space, nodeId: f.member.ids.file },
      ),
    ).rejects.toThrow("authorization_denied");
    await expect(
      issueContentTicket(
        f.app,
        env.BLOBS,
        f.tokens,
        {
          kind: "user",
          user_id: f.admin.ids.user,
          credential_id: f.admin.ids.credential,
          epoch: 1,
        },
        [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
        "content",
        Date.now() + 120000,
      ),
    ).rejects.toThrow("authorization_denied");
  } finally {
    await env.BLOBS.delete(f.blobKey);
  }
});

it.each(["revoked", "expired", "disabled"])(
  "rejects admin content after %s Access state",
  async (state) => {
    const f = await setup();
    let targetSetId: string | undefined;
    try {
      const issuedResponse = await f.handle(
        new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targets: [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
            purpose: "content",
            ttlSeconds: 120,
            action: "preview",
          }),
        }),
      );
      expect(issuedResponse.status).toBe(201);
      const issued = await issuedResponse.json<{ ticket: string; targetSetId: string }>();
      targetSetId = issued.targetSetId;
      const accepted = await handleContentHttp(
        new Request("https://content.invalid/session", {
          method: "POST",
          headers: { Origin: "https://app.invalid", "Content-Type": "application/json" },
          body: JSON.stringify({ ticket: issued.ticket }),
        }),
        f.app,
        f.tokens,
      );
      expect(accepted.status).toBe(201);
      const cookie = accepted.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
      if (state === "revoked")
        await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.admin.ids.session)
          .run();
      if (state === "expired")
        await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE id=?")
          .bind(Date.now() - 1, f.admin.ids.session)
          .run();
      if (state === "disabled")
        await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
          .bind(Date.now(), f.admin.ids.user)
          .run();
      const read = await handleContentHttp(
        new Request(`https://content.invalid/c/${f.member.ids.file}/${f.member.ids.blob}`, {
          headers: { Cookie: cookie },
        }),
        f.app,
        f.tokens,
      );
      expect(read.status).toBe(404);
      const redeem = await handleContentHttp(
        new Request("https://content.invalid/session", {
          method: "POST",
          headers: { Origin: "https://app.invalid", "Content-Type": "application/json" },
          body: JSON.stringify({ ticket: issued.ticket }),
        }),
        f.app,
        f.tokens,
      );
      expect(redeem.status).toBe(400);
    } finally {
      await env.BLOBS.delete(f.blobKey);
      if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
    }
  },
);

it("refuses bytes when audit write is frozen, and rejects a different node using the cookie", async () => {
  const f = await setup();
  let targetSetId: string | undefined;
  try {
    const issuedResponse = await f.handle(
      new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
          purpose: "content",
          ttlSeconds: 120,
          action: "preview",
        }),
      }),
    );
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json<{ ticket: string; targetSetId: string }>();
    targetSetId = issued.targetSetId;
    const accepted = await handleContentHttp(
      new Request("https://content.invalid/session", {
        method: "POST",
        headers: { Origin: "https://app.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
      }),
      f.app,
      f.tokens,
    );
    expect(accepted.status).toBe(201);
    const cookie = accepted.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
    expect(
      (
        await handleContentHttp(
          new Request(`https://content.invalid/c/${f.admin.ids.file}/${f.admin.ids.blob}`, {
            headers: { Cookie: cookie },
          }),
          f.app,
          f.tokens,
        )
      ).status,
    ).toBe(404);
    await env.DB.prepare(`CREATE TRIGGER test_fail_admin_audit BEFORE INSERT ON admin_browse_audit
      BEGIN SELECT RAISE(ABORT,'audit_unavailable'); END`).run();
    const frozen = await handleContentHttp(
      new Request(`https://content.invalid/c/${f.member.ids.file}/${f.member.ids.blob}`, {
        headers: { Cookie: cookie },
      }),
      f.app,
      f.tokens,
    );
    expect(frozen.status).toBe(404);
    expect(await frozen.text()).not.toBe("abc");
  } finally {
    await env.DB.prepare("DROP TRIGGER IF EXISTS test_fail_admin_audit").run();
    await env.BLOBS.delete(f.blobKey);
    if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
  }
});

it("does not let an active admin grant block node purge and cascades with ticket cleanup", async () => {
  const f = await setup();
  let targetSetId: string | undefined;
  try {
    const issuedResponse = await f.handle(
      new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
          purpose: "content",
          ttlSeconds: 120,
          action: "preview",
        }),
      }),
    );
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json<{ ticketId: string; targetSetId: string }>();
    targetSetId = issued.targetSetId;
    expect(
      await env.DB.prepare("SELECT ticket_id FROM admin_content_grants WHERE ticket_id=?")
        .bind(issued.ticketId)
        .first("ticket_id"),
    ).toBe(issued.ticketId);
    await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(f.member.ids.file).run();
    expect(
      await env.DB.prepare("SELECT ticket_id FROM admin_content_grants WHERE ticket_id=?")
        .bind(issued.ticketId)
        .first("ticket_id"),
    ).toBe(issued.ticketId);
    await env.DB.prepare("DELETE FROM tickets WHERE id=?").bind(issued.ticketId).run();
    expect(
      await env.DB.prepare("SELECT ticket_id FROM admin_content_grants WHERE ticket_id=?")
        .bind(issued.ticketId)
        .first("ticket_id"),
    ).toBeNull();
  } finally {
    await env.BLOBS.delete(f.blobKey);
    if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
  }
});

it("rejects ticket redemption and metadata audit after the owner is disabled", async () => {
  const f = await setup();
  let targetSetId: string | undefined;
  try {
    const issuedResponse = await f.handle(
      new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
          purpose: "content",
          ttlSeconds: 120,
          action: "preview",
        }),
      }),
    );
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json<{ ticket: string; targetSetId: string }>();
    targetSetId = issued.targetSetId;
    await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
      .bind(Date.now(), f.member.ids.user)
      .run();
    expect(
      (
        await handleContentHttp(
          new Request("https://content.invalid/session", {
            method: "POST",
            headers: { Origin: "https://app.invalid", "Content-Type": "application/json" },
            body: JSON.stringify({ ticket: issued.ticket }),
          }),
          f.app,
          f.tokens,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.handle(
          new Request(
            `https://app.invalid/api/v1/admin/users/${f.member.ids.user}/nodes/${f.member.ids.file}`,
          ),
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.BLOBS.delete(f.blobKey);
    if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
  }
});

it("issues an explicit admin download ticket, forces attachment, audits each read and revokes with role", async () => {
  const f = await setup();
  let targetSetId: string | undefined;
  let previewTargetSetId: string | undefined;
  try {
    const previewIssuedResponse = await f.handle(
      new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
          purpose: "content",
          ttlSeconds: 120,
          action: "preview",
        }),
      }),
    );
    expect(previewIssuedResponse.status).toBe(201);
    const previewIssued = await previewIssuedResponse.json<{
      ticket: string;
      targetSetId: string;
    }>();
    previewTargetSetId = previewIssued.targetSetId;
    const previewAccepted = await handleContentHttp(
      new Request("https://content.invalid/session", {
        method: "POST",
        headers: { Origin: "https://app.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: previewIssued.ticket }),
      }),
      f.app,
      f.tokens,
    );
    expect(previewAccepted.status).toBe(201);
    const previewCookie = previewAccepted.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const issuedResponse = await f.handle(
      new Request(`https://app.invalid/api/v1/admin/users/${f.member.ids.user}/content-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: [{ spaceId: f.member.ids.space, nodeId: f.member.ids.file }],
          purpose: "content",
          ttlSeconds: 120,
          action: "download",
        }),
      }),
    );
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json<{ ticket: string; targetSetId: string }>();
    targetSetId = issued.targetSetId;
    const accept = await handleContentHttp(
      new Request("https://content.invalid/session", {
        method: "POST",
        headers: { Origin: "https://app.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: issued.ticket }),
      }),
      f.app,
      f.tokens,
    );
    expect(accept.status).toBe(201);
    const cookie = accept.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const url = `https://content.invalid/c/${f.member.ids.file}/${f.member.ids.blob}`;
    const read = () =>
      handleContentHttp(
        new Request(url, { headers: { Cookie: `${previewCookie}; ${cookie!}` } }),
        f.app,
        f.tokens,
      );
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("abc");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM admin_browse_audit WHERE actor_id=? AND owner_id=? AND node_id=? AND action='download'",
      )
        .bind(f.admin.ids.user, f.member.ids.user, f.member.ids.file)
        .first("COUNT(*)"),
    ).toBe(2);
    await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.admin.ids.user).run();
    expect((await read()).status).toBe(404);
  } finally {
    await env.BLOBS.delete(f.blobKey);
    if (previewTargetSetId) await env.BLOBS.delete(`target-sets/${previewTargetSetId}`);
    if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
  }
});
