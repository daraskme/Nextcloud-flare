import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { strToU8, zipSync } from "fflate";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleContentHttp } from "../../src/api/content";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { atomicBatch } from "../../src/db/primary";
import {
  BudgetDO,
  type BudgetReserveRequest,
  type BudgetSettleRequest,
} from "../../src/do/BudgetDO";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { EPUB_INDEX_GENERATOR } from "../../src/media/epub/index";
import { issueContentTicket } from "../../src/services/contentTicket";
import { readPrivateEpub } from "../../src/services/library";
import { foundationFixture } from "../fixtures/foundation";
import { grantPermit, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

function book(
  chapter = "<html><body>Bounded chapter</body></html>",
  encrypted = false,
): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      `<container version="1.0"><rootfiles>
        <rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/>
      </rootfiles></container>`,
    ),
    ...(encrypted ? { "META-INF/encryption.xml": strToU8("<encryption/>") } : {}),
    "OPS/book.opf": strToU8(
      `<package version="3.0"><metadata><dc:title>Private Book</dc:title>
        <dc:creator>Private Author</dc:creator></metadata><manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="chapter"/></spine></package>`,
    ),
    "OPS/chapter.xhtml": strToU8(chapter),
  });
}

async function tokens(): Promise<ContentTokens> {
  const ticketRing = await contentKeyRing("ticket", {
    ticket: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const cookieRing = await contentKeyRing("cookie", {
    cookie: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  return new ContentTokens(ticketRing, cookieRing, "https://content.invalid");
}

async function fixture(content: Uint8Array) {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  const object = await env.BLOBS.put(key, content);
  if (!object) throw new Error("r2_fixture_failed");
  const statements = f.statements.map((statement) => {
    if (statement.sql.startsWith("INSERT INTO blobs"))
      return {
        sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at)
          VALUES(?,?,?,?,?,'committed',?)`,
        values: [f.ids.blob, f.ids.user, key, content.byteLength, `"b-${f.ids.blob}"`, now - 1000],
      };
    if (statement.sql.startsWith("INSERT INTO nodes") && statement.values?.[0] === f.ids.file)
      return {
        sql: `INSERT INTO nodes(
          id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,'file',?,?,?)`,
        values: [
          f.ids.file,
          f.ids.space,
          f.ids.user,
          f.ids.folder,
          "Private Book.epub",
          "private book.epub",
          f.ids.blob,
          now,
          now,
        ],
      };
    return statement;
  });
  await atomicBatch(env.DB, statements);
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,?)",
  )
    .bind(f.ids.blob, content.byteLength, object.etag, now)
    .run();
  const search = searchName("Private Book.epub");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.file, f.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const eventId = crypto.randomUUID();
  const permit = await grantPermit(env.DB, eventId, f.ids.space, 1);
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(
        op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,
        epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,
        created_at,updated_at,operands_json,result_json
      ) VALUES(?,'user',?,?,?,'dav.put','committed','epub',1,?,?,?,1,?,?,?,?)`,
      values: [
        eventId,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
        now,
        now,
        JSON.stringify({ parentId: f.ids.folder, nodeId: f.ids.file }),
        JSON.stringify({ status: 204, nodeId: f.ids.file }),
      ],
    },
    {
      sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
      values: [eventId, f.ids.file],
    },
    {
      sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?, 'node.updated',?,'pending',1,?,?)",
      values: [eventId, eventId, f.ids.file, now, now],
    },
  ]);
  await env.DB.prepare("UPDATE permits SET state='released' WHERE permit_id=?")
    .bind(permit.permit_id)
    .run();
  await dispatchOutbox(
    mutationEnv(),
    { send: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }) },
    eventId,
    1,
  );
  return {
    ...f.ids,
    eventId,
    key,
    principal: {
      kind: "user" as const,
      user_id: f.ids.user,
      credential_id: f.ids.credential,
      epoch: 1,
    },
  };
}

async function pageFixture() {
  const f = await fixture(book());
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  const publication = await readPrivateEpub(env.DB, env.BLOBS, f.principal, f.file);
  const contentTokens = await tokens();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    contentTokens,
    f.principal,
    [{ spaceId: f.space, nodeId: f.file }],
    "page",
    Date.now() + 300_000,
  );
  const accepted = await acceptContentTicket(mutationEnv(), contentTokens, issued.ticket);
  const cookie = accepted.setCookie.split(";", 1)[0] ?? "";
  const row = await env.DB.prepare(
    "SELECT json_bytes AS indexBytes,r2_key AS indexKey FROM archive_index WHERE node_id=?",
  )
    .bind(f.file)
    .first<{ indexBytes: number; indexKey: string }>();
  if (!row) throw new Error("missing_index");
  const budget = env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId));
  const app: Env = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
  };
  const read = (target = publication.spine[0]!, current = app) =>
    handleContentHttp(
      new Request(`https://content.invalid/c/${f.file}/${f.blob}/entries/${target}`, {
        headers: { Cookie: cookie },
      }),
      current,
      contentTokens,
    );
  return { ...f, ...row, app, budget, issued, accepted, read };
}

function observedBucket(get: (key: string) => Promise<void>, source = env.BLOBS): R2Bucket {
  return new Proxy(source, {
    get(target, property) {
      if (property === "get")
        return async (key: string, options?: R2GetOptions) => {
          await get(key);
          return target.get(key, options);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observedBudgets(beforeReserve: (request: BudgetReserveRequest) => Promise<void>) {
  return {
    idFromName: env.BUDGETS.idFromName.bind(env.BUDGETS),
    get(id: DurableObjectId) {
      const stub = env.BUDGETS.get(id);
      return {
        async reserve(request: BudgetReserveRequest) {
          await beforeReserve(request);
          const result = await runInDurableObject(stub, async (_, state) => {
            try {
              return { ok: true as const, lease: await new BudgetDO(state, env).reserve(request) };
            } catch (error) {
              return { ok: false as const, message: (error as Error).message };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.lease;
        },
        settle: (request: BudgetSettleRequest) => stub.settle(request),
      };
    },
  } as unknown as Env["BUDGETS"];
}

it("publishes immutable EPUB metadata and an idempotent source-bound index", async () => {
  const f = await fixture(book());
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(
    await env.DB.prepare(
      "SELECT blob_id,kind,generator_version,title_extracted,author_extracted,page_count FROM library_items WHERE node_id=?",
    )
      .bind(f.file)
      .first(),
  ).toEqual({
    blob_id: f.blob,
    kind: "epub",
    generator_version: EPUB_INDEX_GENERATOR,
    title_extracted: "Private Book",
    author_extracted: "Private Author",
    page_count: 1,
  });
  const archive = await env.DB.prepare(
    "SELECT r2_key AS key,sha256,entry_count AS entries,json_bytes AS bytes FROM archive_index WHERE node_id=?",
  )
    .bind(f.file)
    .first<{ key: string; sha256: string; entries: number; bytes: number }>();
  expect(archive).toMatchObject({ entries: 4 });
  if (!archive) throw new Error("missing_archive");
  expect(archive.key).toContain(`/${EPUB_INDEX_GENERATOR}/index/${f.file}-`);
  const object = await env.BLOBS.get(archive.key);
  expect(object?.size).toBe(archive.bytes);
  const publication = await readPrivateEpub(env.DB, env.BLOBS, f.principal, f.file);
  expect(publication).toMatchObject({
    nodeId: f.file,
    blobId: f.blob,
    title: "Private Book",
    author: "Private Author",
    pageCount: 1,
  });
  expect(publication.spine[0]).toMatch(/^e[0-9a-z]+_[0-9a-f]{8}$/);
  await expect(
    readPrivateEpub(env.DB, env.BLOBS, { ...f.principal, user_id: crypto.randomUUID() }, f.file),
  ).rejects.toThrow();
});

it("completes encrypted EPUBs by removing stale publication state", async () => {
  const f = await fixture(book("<html/>", true));
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO library_items(node_id,blob_id,kind,generator_version,page_count) VALUES(?,?,'epub','old',1)",
      values: [f.file, f.blob],
    },
    {
      sql: "INSERT INTO archive_index(id,node_id,blob_id,generator_version,r2_key,sha256,entry_count,json_bytes) VALUES(?,?,?,'old',?,'old',1,1)",
      values: [crypto.randomUUID(), f.file, f.blob, `old/${crypto.randomUUID()}`],
    },
  ]);
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM library_items WHERE node_id=?")
      .bind(f.file)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM archive_index WHERE node_id=?")
      .bind(f.file)
      .first("n"),
  ).toBe(0);
});

it("delivers a validated spine entry only through a page ticket, session and budget", async () => {
  const chapter = "<html><body>Ticketed chapter</body></html>";
  const f = await fixture(book(chapter));
  expect(await consumeOutbox(mutationEnv(), f.eventId)).toBe("completed");
  const publication = await readPrivateEpub(env.DB, env.BLOBS, f.principal, f.file);
  const entryToken = publication.spine[0];
  if (!entryToken) throw new Error("missing_spine");
  const contentTokens = await tokens();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    contentTokens,
    f.principal,
    [{ spaceId: f.space, nodeId: f.file }],
    "page",
    Date.now() + 300_000,
  );
  const accepted = await acceptContentTicket(mutationEnv(), contentTokens, issued.ticket);
  const cookie = accepted.setCookie.split(";", 1)[0] ?? "";
  const contentEnv = {
    ...mutationEnv(),
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
  };
  const response = await handleContentHttp(
    new Request(`https://content.invalid/c/${f.file}/${f.blob}/entries/${entryToken}`, {
      headers: { Cookie: cookie, Origin: "https://app.invalid" },
    }),
    contentEnv,
    contentTokens,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(response.headers.get("Content-Disposition")).toContain("attachment");
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(chapter);
  const partial = await handleContentHttp(
    new Request(`https://content.invalid/c/${f.file}/${f.blob}/entries/${entryToken}`, {
      headers: { Cookie: cookie, Origin: "https://app.invalid", Range: "bytes=0-5" },
    }),
    contentEnv,
    contentTokens,
  );
  expect(partial.status).toBe(206);
  expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe(chapter.slice(0, 6));
  const indexRow = await env.DB.prepare(
    "SELECT json_bytes AS indexBytes,r2_key AS indexKey FROM archive_index WHERE node_id=?",
  )
    .bind(f.file)
    .first<{ indexBytes: number; indexKey: string }>();
  const indexObject = await env.BLOBS.get(indexRow!.indexKey);
  const indexJson = (await indexObject!.json()) as {
    entries: { path: string; compressedSize: number }[];
  };
  const chapterEntry = indexJson.entries.find((entry) => entry.path === "OPS/chapter.xhtml")!;
  const chapterBytes = new TextEncoder().encode(chapter).byteLength;
  const budget = env.BUDGETS.get(env.BUDGETS.idFromName(issued.budgetId));
  // Each read admits the index first, then rechecks authority for the payload.
  // The total remains a max-cost approximation, with the index as a floor.
  expect(await budget.status()).toMatchObject({
    bytesCharged:
      Math.max(indexRow!.indexBytes, chapterBytes, chapterEntry.compressedSize) +
      Math.max(indexRow!.indexBytes, chapterEntry.compressedSize),
    requests: 4,
    active: 0,
  });
  await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(f.file).run();
  expect(
    (
      await handleContentHttp(
        new Request(`https://content.invalid/c/${f.file}/${f.blob}/entries/${entryToken}`, {
          headers: { Cookie: cookie },
        }),
        contentEnv,
        contentTokens,
      )
    ).status,
  ).toBe(404);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?").bind(f.blob, f.file).run();
  await env.DB.prepare("UPDATE control SET epoch=2 WHERE singleton=1").run();
  expect(
    (
      await handleContentHttp(
        new Request(`https://content.invalid/c/${f.file}/${f.blob}/entries/${entryToken}`, {
          headers: { Cookie: cookie },
        }),
        contentEnv,
        contentTokens,
      )
    ).status,
  ).toBe(404);
});

it("rejects exhausted EPUB admission before reading the index or entry payload", async () => {
  const f = await pageFixture();
  const gets: string[] = [];
  const app = {
    ...f.app,
    BLOBS: observedBucket(async (key) => {
      gets.push(key);
    }),
    BUDGETS: observedBudgets(async (request) => {
      expect(request.bytes).toBe(f.indexBytes);
      throw new Error("budget_exceeded");
    }),
  };
  expect((await f.read(undefined, app)).status).toBe(429);
  expect(gets).not.toContain(f.indexKey);
  expect(gets).not.toContain(f.key);
  expect(await f.budget.status()).toBeNull();
});

it("charges the EPUB index and one request when the requested entry does not exist", async () => {
  const f = await pageFixture();
  expect((await f.read("missing_entry")).status).toBe(404);
  expect(await f.budget.status()).toMatchObject({
    bytesCharged: f.indexBytes,
    requests: 1,
    active: 0,
  });
});

it("keeps the index charge when payload admission fails and never fetches the entry", async () => {
  const f = await pageFixture();
  const gets: string[] = [];
  let reserves = 0;
  const app = {
    ...f.app,
    BLOBS: observedBucket(async (key) => {
      gets.push(key);
    }),
    BUDGETS: observedBudgets(async () => {
      if (++reserves === 2) throw new Error("budget_exceeded");
    }),
  };
  expect((await f.read(undefined, app)).status).toBe(429);
  expect(gets.filter((key) => key === f.indexKey)).toHaveLength(1);
  expect(gets).not.toContain(f.key);
  expect(await f.budget.status()).toMatchObject({
    bytesCharged: f.indexBytes,
    requests: 1,
    active: 0,
  });
});

it("retains the full EPUB index charge when its dispatched GET fails", async () => {
  const f = await pageFixture();
  const app = {
    ...f.app,
    BLOBS: observedBucket(async (key) => {
      if (key === f.indexKey) throw new Error("index_read_unknown");
    }),
  };
  expect((await f.read(undefined, app)).status).toBe(404);
  // Failed setup settles asynchronously; reservation is already charged in either state.
  expect(await f.budget.status()).toMatchObject({ bytesCharged: f.indexBytes, requests: 1 });
});

it("rechecks the current EPUB session after index delivery even for a zero-byte payload lease", async () => {
  const f = await pageFixture();
  const gets: string[] = [];
  let reserves = 0;
  const app = {
    ...f.app,
    BLOBS: observedBucket(async (key) => {
      gets.push(key);
    }),
    BUDGETS: observedBudgets(async (request) => {
      if (++reserves !== 2) return;
      expect(request.bytes).toBe(0);
      await env.DB.prepare("UPDATE content_sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.accepted.sessionId)
        .run();
    }),
  };
  expect((await f.read(undefined, app)).status).toBe(404);
  expect(gets).not.toContain(f.key);
  expect(await f.budget.status()).toMatchObject({
    bytesCharged: f.indexBytes,
    requests: 1,
    active: 0,
  });
});
