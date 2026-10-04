import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing, MAX_CONTENT_GRANTS } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import { prepareCookieBlobRead } from "../../src/services/blobRead";
import { issueContentTicket } from "../../src/services/contentTicket";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture(kind: "private" | "public" = "private") {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  const tokens = new ContentTokens(
    await contentKeyRing("ticket", {
      ticket: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
    await contentKeyRing("cookie", {
      cookie: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
    "https://content.invalid",
  );
  const shareId = kind === "public" ? crypto.randomUUID() : null;
  const unlock = shareId ? crypto.randomUUID() : null;
  const credential = unlock ? `ss:${unlock}` : f.ids.credential;
  if (shareId && unlock)
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,secret_digest,created_at,expires_at) VALUES(?,?,?,'link',?,?,?)",
        values: [
          shareId,
          f.ids.user,
          f.ids.folder,
          shareId.replaceAll("-", "").repeat(2),
          now - 1000,
          now + 600000,
        ],
      },
      { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
      {
        sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
        values: [unlock, shareId, unlock.replaceAll("-", "").repeat(2), now - 1000, now + 600000],
      },
      {
        sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
        values: [credential, unlock],
      },
    ]);
  const app = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
  };
  const stored = (await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,?)",
  )
    .bind(f.ids.blob, stored.etag, now)
    .run();
  const principal = shareId
    ? {
        kind: "link_share" as const,
        share_id: shareId,
        share_version: 1,
        credential_id: credential,
        epoch: 1,
      }
    : { kind: "user" as const, user_id: f.ids.user, credential_id: credential, epoch: 1 };
  const issue = (nodeId = f.ids.file) =>
    issueContentTicket(
      app,
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId }],
      "content",
      now + 300000,
    );
  const accept = (ticket: string, cookie?: string) =>
    handleContentHttp(
      new Request("https://content.invalid/session", {
        method: "POST",
        headers: {
          Origin: app.APP_ORIGIN,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({ ticket }),
      }),
      app,
      tokens,
    );
  const read = (cookie: string, nodeId = f.ids.file, purpose: "content" | "thumb" = "content") =>
    prepareCookieBlobRead(env.DB, env.BLOBS, tokens, cookie, f.ids.space, nodeId, purpose);
  return { f, now, tokens, app, shareId, credential, issue, accept, read };
}

const cookie = (response: Response) => response.headers.get("Set-Cookie")!.split(";", 1)[0]!;

it.each(["private", "public"] as const)(
  "bounds %s replay to one session and no repeat mutation admissions",
  async (kind) => {
    const x = await fixture(kind);
    const issued = await x.issue();
    const first = await x.accept(issued.ticket);
    expect(first.status).toBe(201);
    const receipts = () =>
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mutation_admissions WHERE permit_id LIKE 'content.accept:%'",
      ).first<number>("n");
    const before = await receipts();
    for (let i = 1; i < 128; i++) expect((await x.accept(issued.ticket)).status).toBe(400);
    expect(await receipts()).toBe(before);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM content_sessions WHERE ticket_id=?")
        .bind(issued.ticketId)
        .first<number>("n"),
    ).toBe(1);
    expect(await env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId)).status()).toBeNull();
    await x.read(cookie(first));
    if (x.shareId)
      await env.DB.prepare("UPDATE shares SET version=version+1 WHERE id=?").bind(x.shareId).run();
    else
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(x.now, x.f.ids.session)
        .run();
    await expect(x.read(cookie(first))).rejects.toThrow();
    expect((await x.accept(issued.ticket)).status).toBe(400);
  },
);

it.each(["private", "public"] as const)(
  "atomically admits one %s concurrent redemption",
  async (kind) => {
    const x = await fixture(kind);
    const issued = await x.issue();
    const replies = await Promise.all(Array.from({ length: 8 }, () => x.accept(issued.ticket)));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      replies.filter((r) => r.status !== 201).every((r) => [400, 503].includes(r.status)),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM content_sessions WHERE ticket_id=?")
        .bind(issued.ticketId)
        .first<number>("n"),
    ).toBe(1);
  },
);

it("keeps concurrent distinct targets and legacy cookies without mixing purpose or authority", async () => {
  const x = await fixture();
  const nodeB = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'B','b','file',?,?,?)",
  )
    .bind(nodeB, x.f.ids.space, x.f.ids.user, x.f.ids.folder, x.f.ids.blob, x.now, x.now)
    .run();
  const a = await x.issue();
  const b = await x.issue(nodeB);
  const replies = await Promise.all([x.accept(a.ticket), x.accept(b.ticket)]);
  expect(replies.map((r) => r.status)).toEqual([201, 201]);
  expect(cookie(replies[0]!).split("=")[0]).not.toBe(cookie(replies[1]!).split("=")[0]);
  const header = replies.map(cookie).join("; ");
  expect((await x.read(header)).budgetId).toBe(a.budgetId);
  expect((await x.read(header, nodeB)).budgetId).toBe(a.budgetId);
  expect(b.budgetId).toBe(a.budgetId);
  await expect(x.read(header, nodeB, "thumb")).rejects.toThrow();
  await expect(x.read(cookie(replies[0]!), nodeB)).rejects.toThrow();
  const other = await fixture();
  await expect(other.read(header)).rejects.toThrow();
  const session = await x.tokens.verifyCookie(cookie(replies[0]!));
  const legacy = (await x.tokens.issueCookie(session, 300)).split(";", 1)[0]!;
  await x.read(legacy);
  await env.DB.prepare("UPDATE tickets SET cancelled_at=? WHERE id=?")
    .bind(x.now, a.ticketId)
    .run();
  await expect(x.read(header)).rejects.toThrow();
  await x.read(header, nodeB);
});

it("rejects malformed, duplicate, oversized and over-capacity grant cookies", async () => {
  const x = await fixture();
  const issued = await x.issue();
  const response = await x.accept(issued.ticket);
  const valid = cookie(response);
  for (const header of [
    valid + "x",
    `${valid}; ${valid}`,
    "x".repeat(8193),
    Array(17).fill(valid).join("; "),
  ]) {
    await expect(x.tokens.verifyCookies(header)).rejects.toThrow("content_cookie_rejected");
  }
  const forgedName = valid.replace("__Host-ncf_cs_", "__Host-ncf_cs_wrong_");
  await expect(x.tokens.verifyCookies(forgedName)).rejects.toThrow();
  const fresh = await x.issue();
  expect((await x.accept(fresh.ticket, "x".repeat(8193))).status).toBe(400);
  expect((await x.accept(fresh.ticket, valid + "x")).status).toBe(400);
  expect((await x.accept(fresh.ticket, valid)).status).toBe(201);
});

it.each(["private", "public"] as const)(
  "atomically caps %s grants without browser cookies and prunes expired grants",
  async (identity) => {
    const x = await fixture(identity);
    const responses: Response[] = [];
    for (let i = 0; i < MAX_CONTENT_GRANTS - 1; i++)
      responses.push(await x.accept((await x.issue()).ticket));
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const contenders = await Promise.all([x.issue(), x.issue()]);
    const replies = await Promise.all(contenders.map((ticket) => x.accept(ticket.ticket)));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    responses.push(replies.find((r) => r.status === 201)!);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM content_sessions WHERE issued_by_credential_id=?",
      )
        .bind(x.credential)
        .first("n"),
    ).toBe(MAX_CONTENT_GRANTS);
    const issued = await x.issue();
    expect((await x.accept(issued.ticket)).status).toBe(429);
    const expired = await x.tokens.verifyCookie(cookie(responses[0]!));
    await env.DB.prepare("UPDATE content_sessions SET issued_at=?,expires_at=? WHERE id=?")
      .bind(x.now - 10000, x.now - 5000, expired)
      .run();
    const accepted = await acceptContentTicket(
      x.app,
      x.tokens,
      issued.ticket,
      responses.map(cookie).join("; "),
    );
    expect(accepted.clearCookies).toHaveLength(1);
    expect(accepted.clearCookies[0]).toContain("Max-Age=0");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM content_sessions WHERE id=?")
        .bind(expired)
        .first<number>("n"),
    ).toBe(0);
    expect((await x.accept((await x.issue()).ticket)).status).toBe(429);
  },
);
