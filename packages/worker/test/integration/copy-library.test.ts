import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { searchName } from "../../../shared/src/names";
import { authorizeNode } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { LibraryCursorTokens } from "../../src/auth/libraryCursor";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { prepareAuthorizedArchiveRead } from "../../src/services/archiveRead";
import { type CopyNodeRequest, copyNode } from "../../src/services/copyNode";
import { createFolder } from "../../src/services/createFolder";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { readArchiveBook, saveReadingState } from "../../src/services/libraryBook";
import { listLibrary } from "../../src/services/libraryList";
import { moveNode } from "../../src/services/moveNode";
import { putFile } from "../../src/services/putFile";
import { auditOwnerLedger } from "../../src/services/refs";
import { archiveFixture } from "../fixtures/archive";
import { archiveStorageFixture } from "../fixtures/archiveDerivative";
import { foundationFixture } from "../fixtures/foundation";
import { imageBytes } from "../fixtures/images/encoded";
import { clearEndedR2TestWrites } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

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

async function fixture(name = "book.cbz") {
  const f = await archiveStorageFixture(
    archiveFixture([
      { name: "10.png", content: imageBytes("red.png") },
      { name: "2.png", content: imageBytes("red.png") },
    ]).bytes,
    name,
    false,
  );
  await f.release();
  expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
  // The foundation seeds raw nodes; production namespace creation also creates their search rows.
  for (const [id, name] of [
    [f.ids.folder, "Folder"],
    [f.ids.file, "File"],
  ] as const) {
    const search = searchName(name);
    await atomicBatch(env.DB, [
      {
        sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
        values: [id, f.ids.space, search.textNorm, search.tokens, search.version],
      },
      {
        sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
        values: [id],
      },
    ]);
  }
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const request: CopyNodeRequest = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    sourceNodeId: f.node.id,
    destinationParentId: f.ids.folder,
    name: "Copied.cbz",
    depth: "infinity",
    lockTokens: [],
    operation: "node.copy",
  };
  const copy = async (patch: Partial<CopyNodeRequest> = {}, db = env.DB) => {
    const result = await copyNode(admitted(db), { ...request, ...patch });
    if (result.kind !== "terminal" || result.operation.state !== "committed")
      throw new Error("fixture_copy_failed");
    return { result, nodeId: result.operation.id + "_c0001" };
  };
  const read = (nodeId = f.node.id) => readArchiveBook(env.DB, principal, nodeId);
  const save = async (nodeId: string, page: number) => {
    const book = await read(nodeId);
    return saveReadingState(f.app, principal, nodeId, {
      blobId: book.blobId,
      generator: book.generator,
      indexHash: book.indexHash,
      page,
      previousUpdatedAt: book.reading?.updatedAt ?? null,
    });
  };
  const tokens = new LibraryCursorTokens(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const list = (root = f.ids.folder) => listLibrary(env.DB, principal, root, tokens);
  const index = (nodeId: string) =>
    env.DB.prepare("SELECT * FROM archive_index WHERE node_id=?").bind(nodeId).first();
  return { ...f, principal, request, copy, read, save, list, index };
}

it("reuses a published index without new R2 writes or storage charges and keeps positions independent", async () => {
  const f = await fixture();
  const before = await auditOwnerLedger(env.DB, f.ids.user),
    original = await f.read(),
    position = await f.save(f.node.id, 2),
    copied = await f.copy();
  const book = await f.read(copied.nodeId);
  expect(book).toMatchObject({
    nodeId: copied.nodeId,
    blobId: original.blobId,
    title: "Copied.cbz",
    pageCount: 2,
    indexHash: original.indexHash,
    reading: null,
  });
  expect((await f.list()).items.find((n) => n.id === copied.nodeId)).toMatchObject({
    title: "Copied.cbz",
    state: "ready",
    reading: null,
  });
  await f.save(copied.nodeId, 1);
  expect((await f.read()).reading).toEqual(position);
  expect((await f.read(copied.nodeId)).reading?.page).toBe(1);
  const source = await f.index(f.node.id),
    target = await f.index(copied.nodeId);
  expect(target).toMatchObject({
    r2_key: source!.r2_key,
    sha256: source!.sha256,
    json_bytes: source!.json_bytes,
  });
  expect(target!.id).not.toBe(source!.id);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM r2_write_attempts WHERE owner_id=? AND kind='archive.put'",
    )
      .bind(f.ids.user)
      .first("n"),
  ).toBe(1);
  const authorized = await authorizeNode(env.DB, f.principal, {
    operation: "library.read",
    nodeId: copied.nodeId,
    spaceId: f.ids.space,
  });
  const read = await prepareAuthorizedArchiveRead(env.DB, authorized),
    loaded = await read.load(env.BLOBS, AbortSignal.timeout(5000));
  expect(loaded.index.pages.map((i) => loaded.index.entries[i]!.path)).toEqual(["2.png", "10.png"]);
});

it("copies a folder's archive metadata, supports copying the copy, and leaves non-books alone", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE library_items SET title_override='表示名',author_override='著者',series_override='シリーズ' WHERE node_id=?",
  )
    .bind(f.node.id)
    .run();
  const first = await f.copy({
    sourceNodeId: f.ids.folder,
    destinationParentId: f.ids.root,
    name: "Books",
  });
  const shelf = await f.list(first.nodeId);
  expect(shelf.items).toHaveLength(1);
  expect(shelf.items[0]).toMatchObject({
    title: "表示名",
    author: "著者",
    series: "シリーズ",
    state: "ready",
  });
  const second = await f.copy({
    requestId: crypto.randomUUID(),
    sourceNodeId: shelf.items[0]!.id,
    name: "Again.cbz",
  });
  expect((await f.read(second.nodeId)).title).toBe("表示名");
  await env.DB.prepare("UPDATE library_items SET title_override='変更後' WHERE node_id=?")
    .bind(f.node.id)
    .run();
  expect((await f.read(second.nodeId)).title).toBe("表示名");
  // No dependency on the source node's lifetime or visibility remains after publication.
  await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.node.id).run();
  await expect(f.read()).rejects.toThrow();
  expect((await f.read(second.nodeId)).pageCount).toBe(2);
  expect((await f.read(shelf.items[0]!.id)).pageCount).toBe(2);
});

it("retains EPUB container metadata and index while leaving its body on the original-file path", async () => {
  const f = await fixture("novel.epub"),
    copied = await f.copy({ name: "Copied.epub" });
  expect(await f.index(copied.nodeId)).toMatchObject({
    r2_key: (await f.index(f.node.id))!.r2_key,
  });
  expect((await f.list()).items.find((n) => n.id === copied.nodeId)).toMatchObject({
    state: "original",
    title: "Copied.epub",
    pageCount: null,
  });
  await expect(f.read(copied.nodeId)).rejects.toThrow("archive_not_ready");
});

it.each(["generator", "page_count", "index_missing"])(
  "skips %s metadata without preventing the original COPY",
  async (failure) => {
    const f = await fixture();
    if (failure === "index_missing")
      await env.DB.prepare("DELETE FROM archive_index WHERE node_id=?").bind(f.node.id).run();
    else
      await env.DB.prepare(
        `UPDATE library_items SET ${failure === "generator" ? "generator_version='old'" : "page_count=3"} WHERE node_id=?`,
      )
        .bind(f.node.id)
        .run();
    const copied = await f.copy();
    expect(await f.index(copied.nodeId)).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM library_items WHERE node_id=?")
        .bind(copied.nodeId)
        .first(),
    ).toBeNull();
    expect((await f.list()).items.find((n) => n.id === copied.nodeId)?.state).toBe("pending");
  },
);

it("recovers a lost COPY acknowledgement without duplicating indexes or personal reading state", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO archive_index"),
    async () => {
      throw new Error("ack_lost");
    },
    true,
  );
  const first = await f.copy({}, db),
    position = await f.save(first.nodeId, 1);
  expect(await f.copy()).toEqual(first);
  expect((await f.read(first.nodeId)).reading).toEqual(position);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM archive_index WHERE blob_id=?")
      .bind(f.node.blob)
      .first("n"),
  ).toBe(2);
});

it("rolls back the namespace when index insertion fails", async () => {
  const f = await fixture();
  await env.DB.exec(
    "CREATE TRIGGER test_copy_library_failure BEFORE INSERT ON archive_index WHEN NEW.id LIKE 'ai_copy_%' BEGIN SELECT RAISE(ABORT,'test_copy_library_failure'); END",
  );
  try {
    await expect(f.copy()).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT 1 FROM nodes WHERE parent_id=? AND name='Copied.cbz'")
        .bind(f.ids.folder)
        .first(),
    ).toBeNull();
    expect((await f.read()).pageCount).toBe(2);
  } finally {
    await env.DB.exec("DROP TRIGGER test_copy_library_failure");
  }
});

it("keeps the copy readable when the source original is overwritten", async () => {
  const f = await fixture(),
    copied = await f.copy();
  const revision = (await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
    .bind(f.node.id)
    .first<number>("revision"))!;
  const result = await putFile(admitted(), {
    ...f.input,
    requestId: crypto.randomUUID(),
    name: "book.cbz",
    nodeId: f.node.id,
    expectedRevision: revision,
    body: new Blob([f.bytes]).stream(),
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  await expect(f.read()).rejects.toThrow("archive_not_ready");
  expect((await f.read(copied.nodeId)).blobId).toBe(f.node.blob);
  await f.save(copied.nodeId, 2);
  expect((await f.read(copied.nodeId)).reading?.page).toBe(2);
});

it("copies hundreds of indexed books without duplicating the physical artifact", async () => {
  const f = await fixture(),
    count = 399;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at)
        SELECT ?1||'_'||value,?2,?3,?4,'Book'||value||'.cbz','book'||value||'.cbz','file',?5,1,1,1 FROM json_each(?6)`,
      values: [
        f.node.id,
        f.ids.space,
        f.ids.user,
        f.ids.folder,
        f.node.blob,
        JSON.stringify(Array.from({ length: count }, (_, i) => i)),
      ],
    },
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        SELECT n.id,n.space_id,'book','book',1,1 FROM nodes n WHERE n.parent_id=?1 AND n.id>=?2 AND n.id<?3`,
      values: [f.ids.folder, f.node.id + "_", f.node.id + "~"],
    },
    {
      sql: `INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id>=? AND node_id<?`,
      values: [f.node.id + "_", f.node.id + "~"],
    },
    {
      sql: `INSERT INTO archive_index SELECT 'alias_'||n.id,n.id,a.blob_id,a.generator_version,a.r2_key,a.sha256,a.entry_count,a.json_bytes
        FROM nodes n CROSS JOIN archive_index a WHERE n.id>=? AND n.id<? AND a.node_id=?`,
      values: [f.node.id + "_", f.node.id + "~", f.node.id],
    },
    {
      sql: `INSERT INTO library_items(node_id,blob_id,kind,generator_version,title_extracted,page_count)
        SELECT n.id,n.current_blob_id,l.kind,l.generator_version,n.name,l.page_count FROM nodes n CROSS JOIN library_items l
        WHERE n.id>=? AND n.id<? AND l.node_id=?`,
      values: [f.node.id + "_", f.node.id + "~", f.node.id],
    },
  ]);
  const before = await auditOwnerLedger(env.DB, f.ids.user),
    copied = await f.copy({
      sourceNodeId: f.ids.folder,
      destinationParentId: f.ids.root,
      name: "Many books",
    });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM archive_index a JOIN nodes n ON n.id=a.node_id WHERE n.parent_id=?",
    )
      .bind(copied.nodeId)
      .first("n"),
  ).toBe(count + 1);
  const books = await f.list(copied.nodeId);
  expect(books.items).toHaveLength(200);
  expect(books.items.every((book) => book.state === "ready")).toBe(true);
  expect(books.nextCursor).not.toBeNull();
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM archive_derivative_objects WHERE source_blob_id=?",
    )
      .bind(f.node.blob)
      .first("n"),
  ).toBe(1);
  expect(
    await moveNode(admitted(), {
      principal: f.principal,
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      nodeId: f.ids.folder,
      destinationParentId: copied.nodeId,
      name: "Moved books",
      lockTokens: [],
    }),
  ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect((await f.read()).pageCount).toBe(2);
  expect(await auditOwnerLedger(env.DB, f.ids.user)).toEqual(before);
});

it("reads a copy through its selected destination share after the source share is revoked", async () => {
  const f = await fixture(),
    recipient = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, recipient.statements);
  const email = `${recipient.ids.user}@example.invalid`;
  await env.DB.prepare("UPDATE users SET email=? WHERE id=?").bind(email, recipient.ids.user).run();
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const sourceShare = await createInternalShare(f.app, owner, {
    kind: "internal",
    rootNodeId: f.ids.folder,
    role: "read",
    recipients: [email],
  });
  const folder = await createFolder(admitted(), {
    principal: f.principal,
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.root,
    name: "Destination",
    lockTokens: [],
  });
  if (folder.kind !== "terminal" || folder.operation.state !== "committed")
    throw new Error("fixture_folder");
  const destinationParentId = folder.operation.result!.nodeId!,
    destinationShare = await createInternalShare(f.app, owner, {
      kind: "internal",
      rootNodeId: destinationParentId,
      role: "edit",
      recipients: [email],
    });
  const principal = {
    kind: "user" as const,
    user_id: recipient.ids.user,
    credential_id: recipient.ids.credential,
    epoch: 1,
  };
  const copied = await f.copy({
    principal: { ...principal, selected_share: sourceShare },
    destination: { spaceId: f.ids.space, share: destinationShare },
    destinationParentId,
  });
  await updateInternalShare(f.app, owner, sourceShare.id, sourceShare.version, null);
  await expect(
    readArchiveBook(env.DB, { ...principal, selected_share: sourceShare }, f.node.id),
  ).rejects.toThrow();
  await expect(readArchiveBook(env.DB, principal, copied.nodeId)).rejects.toThrow();
  const book = await readArchiveBook(
    env.DB,
    { ...principal, selected_share: destinationShare },
    copied.nodeId,
  );
  expect(book).toMatchObject({ nodeId: copied.nodeId, pageCount: 2, reading: null });
});
