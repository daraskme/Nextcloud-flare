import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handlePrivateContentTicketHttp } from "../../src/api/contentTickets";
import { handlePrivateAppHttp } from "../../src/api/privateApp";
import { privateAppDependencies } from "../../src/api/privateAppConfig";
import { appPasswordPepperRing } from "../../src/auth/appPassword";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { prepareCookieBlobRead, streamBudgetedContentBlob } from "../../src/services/blobRead";
import { issueContentTicket } from "../../src/services/contentTicket";
import { cancelContentTicket } from "../../src/services/contentTicketCancel";
import { loadTargetManifest } from "../../src/services/targetManifest";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";

it("keeps private app routes closed without remote identity and signing configuration", async () => {
  await expect(privateAppDependencies(env, 1)).rejects.toThrow("private_app_config_unavailable");
});

it("registers Access, issues CSRF, then issues and cancels a private ticket", async () => {
  const { f, now, tokens, firstKey } = await fixture();
  await env.DB.prepare("UPDATE control SET bootstrap_done_at=? WHERE singleton=1").bind(now).run();
  const key = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: key });
  const csrf = new CsrfTokens(ring, ring, "https://app.invalid");
  const cursorRing = await contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const appEnv = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const appPasswordPepper = await appPasswordPepperRing(
    "test",
    {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    },
    localKdf,
  );
  const access = await accessFixture();
  const assertion = await access.sign({
    sub: f.ids.user,
    email: "fixture@example.invalid",
    exp: Math.floor((now + 120_000) / 1000),
  });
  const jwt = assertion.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) throw new Error("missing_access_fixture_jwt");
  const dependencies = {
    verifier: access.verifier,
    csrf,
    tokens,
    cursors: new NodeCursorTokens(cursorRing),
    appPasswordPepper,
    bootstrap: { ownerEmails: [], ownerIdentities: [], quotaBytes: 10_000_000 },
  };
  let targetSetId: string | undefined;
  try {
    const rejected = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/csrf", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(rejected.status).toBe(401);
    const me = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/me", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      id: f.ids.user,
      role: "app_admin",
      spaceId: f.ids.space,
      rootNodeId: f.ids.root,
      epoch: 1,
    });
    const folder = await handlePrivateAppHttp(
      new Request(`https://app.invalid/api/v1/nodes/${f.ids.folder}`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(folder.status).toBe(200);
    expect(await folder.json()).toMatchObject({ id: f.ids.folder, kind: "folder" });
    const listing = await handlePrivateAppHttp(
      new Request(`https://app.invalid/api/v1/nodes/${f.ids.folder}/children`, {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      parentId: f.ids.folder,
      children: [{ id: f.ids.file, kind: "file" }],
      nextCursor: null,
    });
    const csrfResponse = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/csrf", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "Cf-Access-Jwt-Assertion": jwt },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(csrfResponse.status).toBe(201);
    const { token } = await csrfResponse.json<{ token: string }>();
    const headers = {
      Origin: "https://app.invalid",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "X-CSRF-Token": token,
      "Cf-Access-Jwt-Assertion": jwt,
    };
    const passwordResponse = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/app-passwords", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "DAV", scopes: ["node:read"] }),
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(passwordResponse.status).toBe(201);
    const password = await passwordResponse.json<{ credentialId: string; secret: string }>();
    expect(password.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const passwordList = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/app-passwords", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(passwordList.status).toBe(200);
    expect(await passwordList.json()).toMatchObject({
      passwords: [{ credentialId: password.credentialId }],
    });
    const passwordRevoke = await handlePrivateAppHttp(
      new Request(
        `https://app.invalid/api/v1/app-passwords/${encodeURIComponent(password.credentialId)}`,
        { method: "DELETE", headers },
      ),
      appEnv,
      1,
      dependencies,
    );
    expect(passwordRevoke.status).toBe(204);
    const issuedResponse = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/content-session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targets: [{ spaceId: f.ids.space, nodeId: f.ids.file }],
          purpose: "content",
          ttlSeconds: 300,
        }),
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json<{
      ticket: string;
      ticketId: string;
      targetSetId: string;
    }>();
    targetSetId = issued.targetSetId;
    const claims = await tokens.verifyTicket(issued.ticket);
    expect(claims.ticket_id).toBe(issued.ticketId);
    expect(claims.exp * 1000).toBeLessThanOrEqual(Math.floor((now + 120_000) / 1000) * 1000);
    const cancelled = await handlePrivateAppHttp(
      new Request(`https://app.invalid/api/v1/tickets/${issued.ticketId}`, {
        method: "DELETE",
        headers,
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(cancelled.status).toBe(204);
    await expect(acceptContentTicket(env.DB, tokens, issued.ticket)).rejects.toThrow();
    const noCsrfLogout = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/auth/logout", {
        method: "POST",
        headers: {
          Origin: "https://app.invalid",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": jwt,
        },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(noCsrfLogout.status).toBe(403);
    const nonEmptyLogout = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/auth/logout", {
        method: "POST",
        headers,
        body: "{}",
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(nonEmptyLogout.status).toBe(400);
    const logout = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/auth/logout", {
        method: "POST",
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(logout.status).toBe(303);
    expect(logout.headers.get("Location")).toBe("https://app.invalid/cdn-cgi/access/logout");
    const afterLogout = await handlePrivateAppHttp(
      new Request("https://app.invalid/api/v1/me", {
        headers: { "Cf-Access-Jwt-Assertion": jwt },
      }),
      appEnv,
      1,
      dependencies,
    );
    expect(afterLogout.status).toBe(403);
  } finally {
    await env.BLOBS.delete(firstKey);
    if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
  }
});

it("handles private HTTP ticket issue and cancellation with CSRF", async () => {
  const { f, tokens, principal, firstKey } = await fixture();
  const key = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: key });
  const csrf = new CsrfTokens(ring, ring, "https://app.invalid");
  const appEnv = { ...env, APP_ORIGIN: "https://app.invalid" };
  const session = { kind: "access" as const, credentialId: principal.credential_id, epoch: 1 };
  const issuedCsrf = await csrf.issue(
    env.DB,
    new Request("https://app.invalid/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    session,
  );
  const headers = {
    Origin: "https://app.invalid",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    "X-CSRF-Token": issuedCsrf.token,
  };
  let targetSetId: string | undefined;
  try {
    const malformed = await handlePrivateContentTicketHttp(
      new Request("https://app.invalid/api/v1/content-session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targets: [{ spaceId: f.ids.space, nodeId: f.ids.file, extra: true }],
          purpose: "content",
          ttlSeconds: 300,
        }),
      }),
      appEnv,
      principal,
      csrf,
      tokens,
    );
    expect(malformed.status).toBe(400);
    const response = await handlePrivateContentTicketHttp(
      new Request("https://app.invalid/api/v1/content-session", {
        method: "POST",
        headers,
        body: JSON.stringify({
          targets: [{ spaceId: f.ids.space, nodeId: f.ids.file }],
          purpose: "content",
          ttlSeconds: 300,
        }),
      }),
      appEnv,
      principal,
      csrf,
      tokens,
    );
    expect(response.status).toBe(201);
    const issued = await response.json<{
      ticket: string;
      ticketId: string;
      targetSetId: string;
    }>();
    targetSetId = issued.targetSetId;
    expect((await tokens.verifyTicket(issued.ticket)).ticket_id).toBe(issued.ticketId);
    const wrongOrigin = await handlePrivateContentTicketHttp(
      new Request(`https://app.invalid/api/v1/tickets/${issued.ticketId}`, {
        method: "DELETE",
        headers: { ...headers, Origin: "https://other.invalid" },
      }),
      appEnv,
      principal,
      csrf,
      tokens,
    );
    expect(wrongOrigin.status).toBe(403);
    for (const body of [
      "{}",
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.error(new Error("lost")),
      }),
    ]) {
      const rejected = await handlePrivateContentTicketHttp(
        new Request(`https://app.invalid/api/v1/tickets/${issued.ticketId}`, {
          method: "DELETE",
          headers: { ...headers, "Content-Length": "0" },
          body,
        }),
        appEnv,
        principal,
        csrf,
        tokens,
      );
      expect(rejected.status).toBe(400);
    }
    await acceptContentTicket(env.DB, tokens, issued.ticket);
    const cancelled = await handlePrivateContentTicketHttp(
      new Request(`https://app.invalid/api/v1/tickets/${issued.ticketId}`, {
        method: "DELETE",
        headers,
        body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      }),
      appEnv,
      principal,
      csrf,
      tokens,
    );
    expect(cancelled.status).toBe(204);
    await expect(acceptContentTicket(env.DB, tokens, issued.ticket)).rejects.toThrow();
  } finally {
    await env.BLOBS.delete(firstKey);
    if (targetSetId) await env.BLOBS.delete(`target-sets/${targetSetId}`);
  }
});

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
