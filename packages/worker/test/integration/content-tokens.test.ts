import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { contentSessionAssertion } from "../../src/auth/contentSession";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import { prepareCookieBlobRead, streamImmutableBlob } from "../../src/services/blobRead";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function codec(now: () => number) {
  const ticket = await contentKeyRing("ticket-1", {
    "ticket-1": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cookie = await contentKeyRing("cookie-1", {
    "cookie-1": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  return new ContentTokens(ticket, cookie, "https://content.invalid", now);
}

it("redeems a signed ticket into an opaque cookie and current D1 content session", async () => {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  const tokens = await codec(() => now);
  const issued = Math.floor(now / 1000);
  const expires = issued + 300;
  const ids = {
    ticket: crypto.randomUUID(),
    target: crypto.randomUUID(),
    budget: crypto.randomUUID(),
  };
  const manifest = JSON.stringify({
    v: 1,
    targets: [
      { spaceId: f.ids.space, nodeId: f.ids.file, blobId: f.ids.blob, purpose: "content", size: 3 },
    ],
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest)),
  );
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const manifestRef = `target-sets/${ids.target}`;
  await env.BLOBS.put(manifestRef, manifest);
  const blobKey = `u/${f.ids.user}/b/${f.ids.blob}`;
  const stored = await env.BLOBS.put(blobKey, "abc");
  if (!stored) throw new Error("fixture_r2_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.ids.blob, stored.etag)
    .run();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO budgets(id,owner_id,user_id,epoch,expires_at,state) VALUES(?,?,?,1,?,'active')",
      values: [ids.budget, f.ids.user, f.ids.user, expires * 1000 + 1000],
    },
    {
      sql: `INSERT INTO target_sets
        (id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
        VALUES(?,?,?,?,?,3,?,1)`,
      values: [ids.target, f.ids.user, f.ids.credential, hash, manifestRef, expires * 1000 + 1000],
    },
    {
      sql: `INSERT INTO tickets
        (id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,'content',1,?,?)`,
      values: [ids.ticket, f.ids.credential, ids.target, ids.budget, issued * 1000, expires * 1000],
    },
  ]);
  const claims = {
    ticket_id: ids.ticket,
    credential_id: f.ids.credential,
    target_set_id: ids.target,
    target_set_hash: hash,
    budget_id: ids.budget,
    purpose: "content" as const,
    epoch: 1,
    user_id: f.ids.user,
    share_id: null,
    share_version: null,
    iat: issued,
    exp: expires,
  };
  const ticket = await tokens.issueTicket(claims);
  expect(await tokens.verifyTicket(ticket)).toEqual(claims);
  const accepted = await acceptContentTicket(env.DB, tokens, ticket);
  expect(accepted.budgetId).toBe(ids.budget);
  expect(accepted.setCookie).toMatch(
    /^__Host-ncf_cs=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=None; Path=\/; Max-Age=/,
  );
  const cookie = accepted.setCookie.split(";", 1)[0] ?? "";
  expect(await tokens.verifyCookie(cookie)).toBe(accepted.sessionId);
  const plan = await prepareCookieBlobRead(
    env.DB,
    env.BLOBS,
    tokens,
    cookie,
    f.ids.space,
    f.ids.file,
    "content",
  );
  expect(plan.budgetId).toBe(ids.budget);
  const response = await streamImmutableBlob(
    env.BLOBS,
    plan.blob,
    new Request("https://content.invalid/c"),
  );
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("abc");
  await atomicBatch(env.DB, [
    contentSessionAssertion(
      { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch: 1 },
      accepted.sessionId,
      ids.ticket,
      "content",
    ),
  ]);
  await expect(tokens.verifyCookie(`${cookie}; ${cookie}`)).rejects.toThrow(
    /content_cookie_rejected/,
  );
  await expect(tokens.verifyCookie(`${cookie.slice(0, -1)}x`)).rejects.toThrow(
    /content_cookie_rejected/,
  );
  const pieces = ticket.split(".");
  pieces[2] = `A${pieces[2]?.slice(1)}`;
  if (ticket.split(".")[2]?.startsWith("A")) pieces[2] = `B${pieces[2]?.slice(1)}`;
  await expect(tokens.verifyTicket(pieces.join("."))).rejects.toThrow(/content_ticket_rejected/);
  await env.DB.prepare("UPDATE tickets SET cancelled_at=? WHERE id=?").bind(now, ids.ticket).run();
  await expect(acceptContentTicket(env.DB, tokens, ticket)).rejects.toThrow();
  await expect(
    prepareCookieBlobRead(env.DB, env.BLOBS, tokens, cookie, f.ids.space, f.ids.file, "content"),
  ).rejects.toThrow();
  await env.BLOBS.delete([manifestRef, blobKey]);
});

it("redeems an anonymous share ticket and rejects a changed share version", async () => {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  const tokens = await codec(() => now);
  const issued = Math.floor(now / 1000);
  const expires = issued + 300;
  const ids = {
    share: crypto.randomUUID(),
    unlock: crypto.randomUUID(),
    budget: crypto.randomUUID(),
    target: crypto.randomUUID(),
    ticket: crypto.randomUUID(),
  };
  const credential = `ss:${ids.unlock}`;
  const manifest = JSON.stringify({
    v: 1,
    targets: [
      { spaceId: f.ids.space, nodeId: f.ids.file, blobId: f.ids.blob, purpose: "content", size: 3 },
    ],
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest)),
  );
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const ref = `target-sets/${ids.target}`;
  const blobKey = `u/${f.ids.user}/b/${f.ids.blob}`;
  await env.BLOBS.put(ref, manifest);
  const stored = await env.BLOBS.put(blobKey, "abc");
  if (!stored) throw new Error("fixture_r2_put_failed");
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.ids.blob, stored.etag)
    .run();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
      values: [ids.share, f.ids.user, f.ids.folder, now],
    },
    {
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')",
      values: [ids.share],
    },
    {
      sql: `INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
        VALUES(?,?,1,'digest',1,?,?)`,
      values: [ids.unlock, ids.share, now, expires * 1000 + 1000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [credential, ids.unlock],
    },
    {
      sql: `INSERT INTO budgets(id,owner_id,share_id,unlock_session_id,epoch,expires_at,state)
        VALUES(?,?,?,?,1,?,'active')`,
      values: [ids.budget, f.ids.user, ids.share, ids.unlock, expires * 1000 + 1000],
    },
    {
      sql: `INSERT INTO target_sets
        (id,owner_id,credential_id,manifest_hash,manifest_ref,total_bytes,expires_at,epoch)
        VALUES(?,?,?,?,?,3,?,1)`,
      values: [ids.target, f.ids.user, credential, hash, ref, expires * 1000 + 1000],
    },
    {
      sql: `INSERT INTO tickets
        (id,credential_id,target_set_id,budget_id,purpose,epoch,issued_at,expires_at)
        VALUES(?,?,?,?,'content',1,?,?)`,
      values: [ids.ticket, credential, ids.target, ids.budget, issued * 1000, expires * 1000],
    },
  ]);
  const ticket = await tokens.issueTicket({
    ticket_id: ids.ticket,
    credential_id: credential,
    target_set_id: ids.target,
    target_set_hash: hash,
    budget_id: ids.budget,
    purpose: "content",
    epoch: 1,
    user_id: null,
    share_id: ids.share,
    share_version: 1,
    iat: issued,
    exp: expires,
  });
  const accepted = await acceptContentTicket(env.DB, tokens, ticket);
  const cookie = accepted.setCookie.split(";", 1)[0] ?? "";
  expect(
    (
      await prepareCookieBlobRead(
        env.DB,
        env.BLOBS,
        tokens,
        cookie,
        f.ids.space,
        f.ids.file,
        "content",
      )
    ).blob.key,
  ).toBe(blobKey);
  await env.DB.prepare("UPDATE shares SET version=2 WHERE id=?").bind(ids.share).run();
  await expect(
    prepareCookieBlobRead(env.DB, env.BLOBS, tokens, cookie, f.ids.space, f.ids.file, "content"),
  ).rejects.toThrow();
  await env.BLOBS.delete([ref, blobKey]);
});

it("bounds token lifetime and accepts old keys only while retained", async () => {
  let now = Date.now();
  const original = await codec(() => now);
  const iat = Math.floor(now / 1000);
  const ticket = await original.issueTicket({
    ticket_id: crypto.randomUUID(),
    credential_id: `as:${crypto.randomUUID()}`,
    target_set_id: crypto.randomUUID(),
    target_set_hash: "f".repeat(64),
    budget_id: crypto.randomUUID(),
    purpose: "content",
    epoch: 1,
    user_id: crypto.randomUUID(),
    share_id: null,
    share_version: null,
    iat,
    exp: iat + 600,
  });
  const cookie = await original.issueCookie(
    base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    600,
  );
  const newTicket = await contentKeyRing("ticket-2", {
    "ticket-2": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const newCookie = await contentKeyRing("cookie-2", {
    "cookie-2": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const retained = new ContentTokens(
    {
      activeKid: newTicket.activeKid,
      keys: new Map([...newTicket.keys, ...original.ticketRing.keys]),
    },
    {
      activeKid: newCookie.activeKid,
      keys: new Map([...newCookie.keys, ...original.cookieRing.keys]),
    },
    original.origin,
    () => now,
  );
  await retained.verifyTicket(ticket);
  await retained.verifyCookie(cookie.split(";", 1)[0] ?? "");
  const dropped = new ContentTokens(newTicket, newCookie, original.origin, () => now);
  await expect(dropped.verifyTicket(ticket)).rejects.toThrow(/content_ticket_rejected/);
  await expect(dropped.verifyCookie(cookie.split(";", 1)[0] ?? "")).rejects.toThrow(
    /content_cookie_rejected/,
  );
  await expect(
    new ContentTokens(
      original.ticketRing,
      original.cookieRing,
      "https://other.invalid",
      () => now,
    ).verifyTicket(ticket),
  ).rejects.toThrow(/content_ticket_rejected/);
  now = (iat + 600) * 1000;
  await expect(original.verifyTicket(ticket)).rejects.toThrow(/content_ticket_rejected/);
});
