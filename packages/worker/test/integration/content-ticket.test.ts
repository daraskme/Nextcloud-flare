import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import { prepareCookieBlobRead, streamBudgetedContentBlob } from "../../src/services/blobRead";
import { issueContentTicket } from "../../src/services/contentTicket";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { loadTargetManifest } from "../../src/services/targetManifest";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it("cancels the ticket and its redeemed sessions while preserving the shared budget", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  let issued;
  try {
    issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
    );
    const accepted = await acceptContentTicket(env.DB, tokens, issued.ticket);
    await cancelContentTicket(env.DB, principal, issued.ticketId);
    await cancelContentTicket(env.DB, principal, issued.ticketId);
    const ticket = await env.DB.prepare("SELECT cancelled_at FROM tickets WHERE id=?")
      .bind(issued.ticketId)
      .first<{ cancelled_at: number | null }>();
    const session = await env.DB.prepare("SELECT revoked_at FROM content_sessions WHERE id=?")
      .bind(accepted.sessionId)
      .first<{ revoked_at: number | null }>();
    const budget = await env.DB.prepare("SELECT state FROM budgets WHERE id=?")
      .bind(issued.budgetId)
      .first<{ state: string }>();
    expect(ticket?.cancelled_at).not.toBeNull();
    expect(session?.revoked_at).not.toBeNull();
    expect(budget?.state).toBe("active");
    await expect(acceptContentTicket(env.DB, tokens, issued.ticket)).rejects.toThrow();
    await expect(
      prepareCookieBlobRead(
        env.DB,
        env.BLOBS,
        tokens,
        accepted.setCookie.split(";", 1)[0] ?? "",
        f.ids.space,
        f.ids.file,
        "content",
      ),
    ).rejects.toThrow();
  } finally {
    await env.BLOBS.delete(firstKey);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});

it("rejects cancellation by a different credential or a revoked session", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  let issued;
  try {
    issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
    );
    await expect(
      cancelContentTicket(env.DB, { ...principal, credential_id: "as:other" }, issued.ticketId),
    ).rejects.toThrow();
    await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
      .bind(now, f.ids.session)
      .run();
    await expect(cancelContentTicket(env.DB, principal, issued.ticketId)).rejects.toThrow();
    const row = await env.DB.prepare("SELECT cancelled_at FROM tickets WHERE id=?")
      .bind(issued.ticketId)
      .first<{ cancelled_at: number | null }>();
    expect(row?.cancelled_at).toBeNull();
  } finally {
    await env.BLOBS.delete(firstKey);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});

it("reconciles cancellation when D1 commits but loses its response", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  let issued;
  try {
    issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
    );
    const accepted = await acceptContentTicket(env.DB, tokens, issued.ticket);
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        await env.DB.batch(statements);
        throw new Error("response_lost");
      },
    } as unknown as D1Database;
    await cancelContentTicket(db, principal, issued.ticketId);
    const row = await env.DB.prepare("SELECT revoked_at FROM content_sessions WHERE id=?")
      .bind(accepted.sessionId)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();
  } finally {
    await env.BLOBS.delete(firstKey);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});

async function fixture() {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  const firstKey = `u/${f.ids.user}/b/${f.ids.blob}`;
  const first = await env.BLOBS.put(firstKey, "abc");
  if (!first) throw new Error("r2_fixture_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, first.etag, now)
    .run();
  const ticketRing = await contentKeyRing("ticket", {
    ticket: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cookieRing = await contentKeyRing("cookie", {
    cookie: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new ContentTokens(ticketRing, cookieRing, "https://content.invalid");
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  return { f, now, tokens, principal, firstKey };
}

it("issues a two-target ticket and serves both files under one budget", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  const secondBlob = crypto.randomUUID();
  const secondNode = crypto.randomUUID();
  const secondKey = `u/${f.ids.user}/b/${secondBlob}`;
  const second = await env.BLOBS.put(secondKey, "de");
  if (!second) throw new Error("r2_fixture_failed");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,2,?,'committed',?)",
      values: [secondBlob, f.ids.user, secondKey, `"b-${secondBlob}"`, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'Second','second','file',?,?,?)",
      values: [secondNode, f.ids.space, f.ids.user, f.ids.folder, secondBlob, now, now],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,2,?,?)",
      values: [secondBlob, second.etag, now],
    },
  ]);
  let issued;
  try {
    issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      [
        { spaceId: f.ids.space, nodeId: secondNode },
        { spaceId: f.ids.space, nodeId: f.ids.file },
      ],
      "content",
      now + 300_000,
    );
    expect(issued.budgetId).toBe(`u:${f.ids.user}`);
    expect((await tokens.verifyTicket(issued.ticket)).target_set_id).toBe(issued.targetSetId);
    const record = await env.DB.prepare(
      "SELECT id,manifest_ref AS ref,manifest_hash AS hash,total_bytes AS totalBytes FROM target_sets WHERE id=?",
    )
      .bind(issued.targetSetId)
      .first<{ id: string; ref: string; hash: string; totalBytes: number }>();
    expect(record?.totalBytes).toBe(5);
    if (!record) throw new Error("missing_target_set");
    expect((await loadTargetManifest(env.BLOBS, record)).targets).toHaveLength(2);
    const accepted = await acceptContentTicket(env.DB, tokens, issued.ticket);
    const cookie = accepted.setCookie.split(";", 1)[0] ?? "";
    expect(
      (
        await prepareCookieBlobRead(
          env.DB,
          env.BLOBS,
          tokens,
          cookie,
          f.ids.space,
          secondNode,
          "content",
        )
      ).budgetId,
    ).toBe(issued.budgetId);
    const read = (nodeId: string) =>
      streamBudgetedContentBlob(
        env.DB,
        env.BLOBS,
        env.BUDGETS,
        tokens,
        cookie,
        f.ids.space,
        nodeId,
        "content",
        new Request(`https://content.invalid/c/${nodeId}`),
      );
    expect(new TextDecoder().decode(await (await read(f.ids.file)).arrayBuffer())).toBe("abc");
    expect(new TextDecoder().decode(await (await read(secondNode)).arrayBuffer())).toBe("de");
    expect(await env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId)).status()).toMatchObject({
      bytesCharged: 5,
      requests: 2,
      byteLimit: 15,
    });
  } finally {
    await env.BLOBS.delete([firstKey, secondKey]);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});

it("recovers a ticket whose D1 batch committed before its response was lost", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  let batches = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      batches++;
      const result = await env.DB.batch(statements);
      if (batches === 3) throw new Error("response_lost");
      return result;
    },
  } as unknown as D1Database;
  let issued;
  try {
    issued = await issueContentTicket(
      db,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
    );
    expect(batches).toBe(3);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE id=?")
        .bind(issued.ticketId)
        .first("n"),
    ).toBe(1);
    expect((await acceptContentTicket(env.DB, tokens, issued.ticket)).budgetId).toBe(
      issued.budgetId,
    );
  } finally {
    await env.BLOBS.delete(firstKey);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});

it("removes the staged manifest when the issuer credential is revoked at final commit", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  const before = (await env.BLOBS.list({ prefix: "target-sets/" })).objects.map(
    (object) => object.key,
  );
  let batches = 0;
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      batches++;
      if (batches === 3)
        await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.ids.session)
          .run();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  try {
    await expect(
      issueContentTicket(
        db,
        env.BLOBS,
        tokens,
        principal,
        [{ spaceId: f.ids.space, nodeId: f.ids.file }],
        "content",
        now + 300_000,
      ),
    ).rejects.toThrow();
    expect(batches).toBe(3);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM target_sets WHERE owner_id=?")
        .bind(f.ids.user)
        .first("n"),
    ).toBe(0);
    expect(
      (await env.BLOBS.list({ prefix: "target-sets/" })).objects.map((object) => object.key),
    ).toEqual(before);
  } finally {
    await env.BLOBS.delete(firstKey);
  }
});

it("issues an internal-share ticket only for the selected share root", async () => {
  const { f, now, tokens, principal, firstKey } = await fixture();
  const shareId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [shareId, f.ids.user, f.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [shareId, f.ids.user],
    },
  ]);
  let issued;
  try {
    issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
      { id: shareId, version: 1 },
    );
    expect(issued.budgetId).toBe(`u:${f.ids.user}:s:${shareId}`);
    const accepted = await acceptContentTicket(env.DB, tokens, issued.ticket);
    expect(
      (
        await prepareCookieBlobRead(
          env.DB,
          env.BLOBS,
          tokens,
          accepted.setCookie.split(";", 1)[0] ?? "",
          f.ids.space,
          f.ids.file,
          "content",
        )
      ).budgetId,
    ).toBe(issued.budgetId);
  } finally {
    await env.BLOBS.delete(firstKey);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});

it("issues an anonymous-share ticket bound to its unlock session", async () => {
  const { f, now, tokens, firstKey } = await fixture();
  const shareId = crypto.randomUUID();
  const unlockId = crypto.randomUUID();
  const credentialId = `ss:${unlockId}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
      values: [shareId, f.ids.user, f.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
    {
      sql: `INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
        VALUES(?,?,1,?,1,?,?)`,
      values: [unlockId, shareId, `digest-${unlockId}`, now, now + 400_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [credentialId, unlockId],
    },
  ]);
  const principal = {
    kind: "link_share" as const,
    share_id: shareId,
    share_version: 1,
    credential_id: credentialId,
    epoch: 1,
  };
  let issued;
  try {
    issued = await issueContentTicket(
      env.DB,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
    );
    expect(issued.budgetId).toBe(`s:${shareId}:c:${unlockId}`);
    const accepted = await acceptContentTicket(env.DB, tokens, issued.ticket);
    expect(
      (
        await prepareCookieBlobRead(
          env.DB,
          env.BLOBS,
          tokens,
          accepted.setCookie.split(";", 1)[0] ?? "",
          f.ids.space,
          f.ids.file,
          "content",
        )
      ).budgetId,
    ).toBe(issued.budgetId);
  } finally {
    await env.BLOBS.delete(firstKey);
    if (issued) await env.BLOBS.delete(`target-sets/${issued.targetSetId}`);
  }
});
