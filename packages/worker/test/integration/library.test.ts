import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleLibraryListHttp, handleLibraryRootsHttp } from "../../src/api/libraryShelf";
import { privateAppRoute } from "../../src/api/privateApp";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { AudioCursorTokens } from "../../src/auth/audioCursor";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { LibraryCursorTokens } from "../../src/auth/libraryCursor";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { readAccessSession } from "../../src/auth/sessions";
import { ShareTokens } from "../../src/auth/shareTokens";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { createInternalShare } from "../../src/services/internalShares";
import { readArchiveBook, saveReadingState } from "../../src/services/libraryBook";
import { libraryStatement, listLibrary } from "../../src/services/libraryList";
import {
  LIBRARY_ROOT_LIMIT,
  listLibraryRoots,
  updateLibraryRoot,
} from "../../src/services/libraryRoots";
import { createLinkShare } from "../../src/services/linkShares";
import { unlockShare } from "../../src/services/shareUnlock";
import { archiveFixture } from "../fixtures/archive";
import { archiveStorageFixture } from "../fixtures/archiveDerivative";
import { foundationFixture } from "../fixtures/foundation";
import { imageBytes } from "../fixtures/images/encoded";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE control SET backup_token=NULL,backup_frozen=0,restore_freeze_token=NULL",
  ).run();
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE state='active'").run();
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await runInDurableObject(control, (_, state) => state.storage.deleteAll());
  await evictDurableObject(control);
});
async function fixture() {
  const f = await archiveStorageFixture(
    archiveFixture([{ name: "1.png", content: imageBytes("red.png") }]).bytes,
    "book.cbz",
    false,
  );
  await f.release();
  expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
  const app = { ...f.app, APP_ORIGIN: "https://app.invalid" };
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new LibraryCursorTokens(ring),
    cursors = new NodeCursorTokens(ring);
  const list = (cursor?: string, p: Principal = principal, root = f.ids.folder, db = env.DB) =>
    listLibrary(db, p, root, tokens, cursor);
  const add = async (name: string, kind = "file", hidden = 0) => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,hidden,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1)",
    )
      .bind(
        id,
        f.ids.space,
        f.ids.user,
        f.ids.folder,
        name,
        name.toLowerCase(),
        kind,
        kind === "file" ? f.node.blob : null,
        hidden,
      )
      .run();
    return id;
  };
  const save = async () => {
    const book = await readArchiveBook(env.DB, principal, f.node.id);
    return saveReadingState(app, principal, f.node.id, {
      blobId: book.blobId,
      generator: book.generator,
      indexHash: book.indexHash,
      page: 1,
      previousUpdatedAt: null,
    });
  };
  return { ...f, app, principal, ring, tokens, cursors, list, add, save };
}
it("lists folders and current books, resumes only the reader's position, and exposes honest format states", async () => {
  const f = await fixture();
  const folder = await f.add("A folder", "folder");
  await f.add("manual.pdf");
  await f.add("novel.epub");
  await f.add("archive.7z");
  await f.add("new.zip");
  await f.add("ignore.txt");
  await f.add("secret.cbz", "file", 1);
  const state = await f.save(),
    page = await f.list();
  expect(page.items).toHaveLength(6);
  expect(page.items[0]).toMatchObject({ id: folder, kind: "folder", state: "folder" });
  expect(page.items.find((i) => i.id === f.node.id)).toMatchObject({
    state: "ready",
    pageCount: 1,
    reading: state,
  });
  expect(page.items.find((i) => i.name === "new.zip")).toMatchObject({
    state: "pending",
    reading: null,
    pageCount: null,
  });
  expect(page.items.find((i) => i.name === "manual.pdf")?.state).toBe("original");
  expect(page.items.find((i) => i.name === "novel.epub")?.state).toBe("original");
  expect(page.items.find((i) => i.name === "archive.7z")?.state).toBe("unsupported");
  expect((await f.list(undefined, f.principal, f.node.id)).items).toHaveLength(1);
  await expect(
    env.DB.prepare("UPDATE archive_index SET sha256=? WHERE node_id=?")
      .bind("0".repeat(64), f.node.id)
      .run(),
  ).rejects.toThrow("immutable_archive_index");
  await env.DB.prepare("UPDATE library_items SET generator_version='old' WHERE node_id=?")
    .bind(f.node.id)
    .run();
  expect((await f.list()).items.find((i) => i.id === f.node.id)).toMatchObject({
    state: "pending",
    pageCount: null,
    reading: null,
  });
});
it("pages through more than 200 books exactly once and binds cursors to credentials, roots and tree generation", async () => {
  const f = await fixture();
  await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<210)
    INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
    SELECT ?||i,?,?,?,printf('%06d.cbz',i),printf('%06d.cbz',i),'file',?,1,1 FROM seq`)
    .bind(f.node.id + "c", f.ids.space, f.ids.user, f.ids.folder, f.node.blob)
    .run();
  const first = await f.list();
  expect(first.items).toHaveLength(200);
  const next = await f.list(first.nextCursor!);
  expect(next.items).toHaveLength(12);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.items, ...next.items].map((i) => i.id)).size).toBe(212);
  await expect(f.cursors.verify(first.nextCursor!)).rejects.toThrow();
  await expect(new AudioCursorTokens(f.ring).verify(first.nextCursor!)).rejects.toThrow();
  await expect(f.list(first.nextCursor!, f.principal, f.ids.root)).rejects.toThrow(
    "invalid_library_cursor",
  );
  await expect(f.list(first.nextCursor! + "a")).rejects.toThrow("invalid_library_cursor");
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(f.ids.space)
    .run();
  await expect(f.list(first.nextCursor!)).rejects.toThrow("invalid_library_cursor");
});
it("bounds sparse first and late windows despite 50k non-books and 50k hidden siblings", {
  timeout: 120000,
}, async () => {
  const f = await fixture();
  for (const [prefix, hidden] of [
    ["a", 0],
    ["0-secret", 1],
  ] as const) {
    await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<50049)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,hidden,created_at,updated_at)
      SELECT ?||i,?,?,?,?||printf('%06d.txt',i),?||printf('%06d.txt',i),'file',?,1,1 FROM seq`)
      .bind(f.node.id + prefix, f.ids.space, f.ids.user, f.ids.folder, prefix, prefix, hidden)
      .run();
  }
  const measure = (name: string | null, id: string | null) =>
    env.DB.prepare(libraryStatement(false, name !== null))
      .bind(f.ids.folder, f.ids.space, f.ids.user, f.ids.user, name, id)
      .all<{ scanned: number; items: string }>();
  const first = await measure(null, null),
    late = await measure("a049999.txt", f.node.id + "a49999");
  expect(first.results[0]!.scanned).toBe(1000);
  expect(JSON.parse(first.results[0]!.items)).toEqual([]);
  expect(late.results[0]!.scanned).toBe(52);
  const measurements = [first, late].map((r) => ({ rows: r.meta.rows_read, ms: r.meta.duration }));
  console.info("library candidate budgets", JSON.stringify(measurements));
  expect(first.meta.rows_read).toBeLessThanOrEqual(10000);
  expect(late.meta.rows_read).toBeLessThan(1500);
  const page = await f.list();
  expect(page.items).toEqual([]);
  expect(page.nextCursor).not.toBeNull();
  const cursor = await f.tokens.verify(page.nextCursor!);
  expect(JSON.stringify(cursor)).not.toContain("secret");
  const tail = await f.list(
    await f.tokens.issue({ ...cursor, lastNameCi: "a049999.txt", lastId: f.node.id + "a49999" }),
  );
  expect(tail.items.map((i) => i.id)).toEqual([f.node.id]);
  expect(tail.nextCursor).toBeNull();
});
it.each(["hidden", "credential", "blob", "share"])(
  "rechecks %s before returning shelf metadata",
  async (kind) => {
    const f = await fixture();
    let p: Principal = f.principal;
    if (kind === "share") {
      const r = foundationFixture(crypto.randomUUID(), Date.now());
      await atomicBatch(env.DB, r.statements);
      const email = `${r.ids.user}@example.invalid`;
      await env.DB.prepare("UPDATE users SET email=? WHERE id=?").bind(email, r.ids.user).run();
      const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
      const share = await createInternalShare(f.app, owner, {
        kind: "internal",
        rootNodeId: f.ids.folder,
        role: "read",
        recipients: [email],
      });
      p = {
        kind: "user",
        user_id: r.ids.user,
        credential_id: r.ids.credential,
        epoch: 1,
        selected_share: { id: share.id, version: share.version },
      };
      await f.save();
      expect((await f.list(undefined, p)).items[0]?.reading).toBeNull();
    }
    const db = injectBatch(
      (sql) => sql.includes("WITH candidates AS MATERIALIZED"),
      async () => {
        if (kind === "hidden")
          await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
        if (kind === "credential")
          await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
            .bind(f.ids.session)
            .run();
        if (kind === "blob")
          await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
            .bind(f.node.id)
            .run();
        if (kind === "share")
          await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?")
            .bind(p.kind === "user" ? p.selected_share!.id : "")
            .run();
      },
      false,
    );
    if (kind === "blob") expect((await f.list(undefined, p, f.ids.folder, db)).items).toEqual([]);
    else await expect(f.list(undefined, p, f.ids.folder, db)).rejects.toThrow();
  },
);
it("registers only owned folders, keeps unavailable registrations removable, and handles repeat requests", async () => {
  const f = await fixture(),
    g = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, g.statements);
  await updateLibraryRoot(f.app, f.principal, f.ids.folder, true);
  await updateLibraryRoot(f.app, f.principal, f.ids.folder, true);
  expect((await listLibraryRoots(env.DB, f.principal)).items).toEqual([
    { nodeId: f.ids.folder, name: "Folder" },
  ]);
  await expect(updateLibraryRoot(f.app, f.principal, f.node.id, true)).rejects.toThrow();
  await expect(updateLibraryRoot(f.app, f.principal, g.ids.folder, true)).rejects.toThrow();
  await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
  expect((await listLibraryRoots(env.DB, f.principal)).items).toEqual([
    { nodeId: f.ids.folder, name: null },
  ]);
  await updateLibraryRoot(f.app, f.principal, f.ids.folder, false);
  await updateLibraryRoot(f.app, f.principal, f.ids.folder, false);
  expect((await listLibraryRoots(env.DB, f.principal)).items).toEqual([]);
});
it("enforces the registration limit and recovers a lost database acknowledgement", async () => {
  const f = await fixture();
  for (let i = 0; i < LIBRARY_ROOT_LIMIT; i++)
    await updateLibraryRoot(f.app, f.principal, await f.add(`Folder${i}`, "folder"), true);
  await expect(updateLibraryRoot(f.app, f.principal, f.ids.folder, true)).rejects.toThrow(
    "library_roots_limit",
  );
  const roots = await listLibraryRoots(env.DB, f.principal);
  expect(roots.items).toHaveLength(LIBRARY_ROOT_LIMIT);
  await updateLibraryRoot(f.app, f.principal, roots.items[0]!.nodeId, false);
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO library_roots"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  await updateLibraryRoot({ ...f.app, DB: db }, f.principal, f.ids.folder, true);
  expect((await listLibraryRoots(env.DB, f.principal)).items).toHaveLength(LIBRARY_ROOT_LIMIT);
});
it.each(["hidden", "credential", "freeze"])("rejects a raced %s registration", async (kind) => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO library_roots"),
    async () => {
      if (kind === "hidden")
        await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
      if (kind === "credential")
        await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
          .bind(f.ids.session)
          .run();
      if (kind === "freeze")
        await env.DB.prepare("UPDATE control SET backup_frozen=1,backup_token='test'").run();
    },
    false,
  );
  await expect(
    updateLibraryRoot({ ...f.app, DB: db }, f.principal, f.ids.folder, true),
  ).rejects.toThrow();
  expect(
    (await env.DB.prepare("SELECT * FROM library_roots WHERE user_id=?").bind(f.ids.user).all())
      .results,
  ).toEqual([]);
});
it("routes private shelf/roots with exact query and CSRF checks", async () => {
  const f = await fixture(),
    csrf = new CsrfTokens(f.ring, f.ring, f.app.APP_ORIGIN);
  const url = `${f.app.APP_ORIGIN}/api/v1/library/items?scopeRoot=${f.ids.folder}`;
  expect(privateAppRoute(new Request(url))).toBe(true);
  expect(
    (await handleLibraryListHttp(new Request(url), f.app, f.principal, f.cursors)).status,
  ).toBe(200);
  for (const query of ["&cursor=", "&scopeRoot=x", "&recursive=1", "&shareId=x"])
    expect(
      (await handleLibraryListHttp(new Request(url + query), f.app, f.principal, f.cursors)).status,
    ).toBe(400);
  const headers = {
    Origin: f.app.APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
  };
  const { token } = await csrf.issue(
    env.DB,
    new Request(`${f.app.APP_ORIGIN}/api/v1/csrf`, { method: "POST", headers }),
    { kind: "access", credentialId: f.ids.credential, epoch: 1 },
  );
  const request = (extra: object = {}, csrfToken = "") =>
    new Request(`${f.app.APP_ORIGIN}/api/v1/library/roots`, {
      method: "POST",
      headers: { ...headers, "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ nodeId: f.ids.folder, ...extra }),
    });
  expect(privateAppRoute(request())).toBe(true);
  expect((await handleLibraryRootsHttp(request(), f.app, f.principal, csrf)).status).toBe(403);
  expect(
    (await handleLibraryRootsHttp(request({ userId: "other" }, token), f.app, f.principal, csrf))
      .status,
  ).toBe(400);
  expect((await handleLibraryRootsHttp(request({}, token), f.app, f.principal, csrf)).status).toBe(
    200,
  );
});
it("offers public shelf pagination without personal reading state and checks the exact unlock session", async () => {
  const f = await fixture(),
    owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createLinkShare(f.app, owner, {
    kind: "link",
    rootNodeId: f.ids.folder,
    role: "read",
  });
  const tokens = new ShareTokens(f.ring, f.app.APP_ORIGIN),
    csrf = new CsrfTokens(f.ring, f.ring, f.app.APP_ORIGIN);
  const unlocked = await unlockShare(f.app, (await tokens.challenge(share.id, 1)).claims, {
    secret: share.secret,
  });
  await f.save();
  const cookie = `__Host-ncf_share_${share.id}=${await tokens.issue(unlocked.claims)}`;
  const app = { ...f.app, EDGE_LIMITER: { limit: async () => ({ success: true }) } },
    deps = { tokens, csrf, cursors: f.cursors };
  const request = (query = "", session = unlocked.claims.session_id) =>
    new Request(`${f.app.APP_ORIGIN}/api/v1/public/shares/${share.id}/library${query}`, {
      headers: {
        Origin: f.app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        Cookie: cookie,
        "Share-Session": session,
      },
    });
  expect(publicShareRoute(request())).toBe(true);
  const response = await handlePublicShareHttp(request(), app, 1, deps);
  expect(response.status).toBe(200);
  expect((await response.json<{ items: { reading: unknown }[] }>()).items[0]?.reading).toBeNull();
  expect((await handlePublicShareHttp(request("", "wrong"), app, 1, deps)).status).toBe(412);
  expect((await handlePublicShareHttp(request(`?nodeId=${f.ids.root}`), app, 1, deps)).status).toBe(
    404,
  );
  await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?").bind(share.id).run();
  expect((await handlePublicShareHttp(request(), app, 1, deps)).status).not.toBe(200);
});
