import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { PageReadingUpdate } from "../../../shared/src/library";
import { handleReadingStateHttp } from "../../src/api/library";
import { privateAppRoute } from "../../src/api/privateApp";
import type { Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { CsrfTokens } from "../../src/auth/csrf";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/controlName";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { createInternalShare } from "../../src/services/internalShares";
import { ReadingConflict, readArchiveBook, saveReadingState } from "../../src/services/libraryBook";
import { putFile } from "../../src/services/putFile";
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
async function fixture() {
  const bytes = archiveFixture([
    { name: "1.png", content: imageBytes("red.png") },
    { name: "2.png", content: imageBytes("red.png") },
  ]).bytes;
  const f = await archiveStorageFixture(bytes, "book.cbz", false);
  await f.release();
  expect(await consumeOutbox(f.app, f.outboxId)).toBe("completed");
  const app = { ...f.app, APP_ORIGIN: "https://app.invalid" };
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const book = await readArchiveBook(env.DB, principal, f.node.id);
  const input: PageReadingUpdate = {
    blobId: book.blobId,
    generator: book.generator,
    indexHash: book.indexHash,
    page: 2,
    previousUpdatedAt: null,
  };
  const read = (p: Principal = principal) => readArchiveBook(env.DB, p, f.node.id);
  const save = (update = input, p: Principal = principal, db = env.DB) =>
    saveReadingState({ ...app, DB: db }, p, f.node.id, update);
  const rows = async () =>
    (
      await env.DB.prepare(
        "SELECT user_id,blob_id,position_json,updated_at FROM user_reading_state WHERE node_id=? ORDER BY user_id",
      )
        .bind(f.node.id)
        .all()
    ).results;
  return { ...f, app, principal, book, inputForPut: f.input, input, read, save, rows };
}
async function shared(f: Awaited<ReturnType<typeof fixture>>) {
  const recipient = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, recipient.statements);
  const email = `${recipient.ids.user}@example.invalid`;
  await env.DB.prepare("UPDATE users SET email=? WHERE id=?").bind(email, recipient.ids.user).run();
  const owner = (await readAccessSession(env.DB, f.ids.credential, 1))!;
  const share = await createInternalShare(f.app, owner, {
    kind: "internal",
    rootNodeId: f.ids.folder,
    role: "read",
    recipients: [email],
  });
  return {
    kind: "user" as const,
    user_id: recipient.ids.user,
    credential_id: recipient.ids.credential,
    epoch: 1,
    selected_share: { id: share.id, version: share.version },
  };
}
it("resumes each user's own position on a read share and charges the owner's mutation permit", async () => {
  const f = await fixture(),
    recipient = await shared(f);
  expect(f.book.reading).toBeNull();
  const owner = await f.save();
  expect((await f.read()).reading).toEqual(owner);
  expect((await f.read(recipient)).reading).toBeNull();
  const other = await f.save({ ...f.input, page: 1 }, recipient);
  expect((await f.read(recipient)).reading).toEqual(other);
  expect((await f.read()).reading).toEqual(owner);
  const { selected_share: _, ...unselected } = recipient;
  await expect(f.save(f.input, unselected)).rejects.toThrow();
  await expect(f.read(unselected)).rejects.toThrow();
  const receipts = await env.DB.prepare(
    "SELECT space_id,state FROM mutation_admissions WHERE permit_id LIKE 'reading.write:%' AND space_id=?",
  )
    .bind(f.ids.space)
    .all();
  expect(receipts.results).toHaveLength(2);
  expect(
    receipts.results.every((row) => row.space_id === f.ids.space && row.state === "closed"),
  ).toBe(true);
});
it("allows only one concurrent CAS writer and advances timestamps monotonically", async () => {
  const f = await fixture();
  const writes = await Promise.allSettled([f.save(), f.save({ ...f.input, page: 1 })]);
  expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (writes.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
  ).toBeInstanceOf(ReadingConflict);
  const current = (await f.read()).reading!;
  const next = await f.save({ ...f.input, previousUpdatedAt: current.updatedAt });
  expect(next.updatedAt).toBeGreaterThan(current.updatedAt);
  await expect(f.save()).rejects.toBeInstanceOf(ReadingConflict);
  expect(await f.rows()).toHaveLength(1);
});
it("invalidates the old position after a real overwrite and keeps only the new original's state", async () => {
  const f = await fixture();
  await f.save();
  const revision = (await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
    .bind(f.node.id)
    .first<number>("revision"))!;
  const updated = await putFile(admitted(), {
    ...f.inputForPut,
    requestId: crypto.randomUUID(),
    name: "book.cbz",
    nodeId: f.node.id,
    expectedRevision: revision,
    body: new Blob([f.bytes]).stream(),
  });
  if (updated.kind !== "terminal") throw new Error("fixture_overwrite");
  expect(updated.operation.state).toBe("committed");
  await env.DB.prepare(
    "UPDATE outbox SET state='sent',dispatch_token=?,dispatch_expires_at=? WHERE outbox_id=?",
  )
    .bind(crypto.randomUUID(), Date.now() + 30000, `${updated.operation.id}_event`)
    .run();
  expect(await consumeOutbox(f.app, `${updated.operation.id}_event`)).toBe("completed");
  const book = await f.read();
  expect(book.blobId).not.toBe(f.book.blobId);
  expect(book.reading).toBeNull();
  await expect(f.save()).rejects.toThrow("authorization_denied");
  await f.save({ ...f.input, blobId: book.blobId, indexHash: book.indexHash });
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.blob_id).toBe(book.blobId);
});
it.each(["index", "page", "shape"])(
  "ignores stale or malformed %s in saved JSON and can replace it safely",
  async (kind) => {
    const f = await fixture();
    const position = {
      kind: "page",
      generator: f.book.generator,
      indexHash: kind === "index" ? "0".repeat(64) : f.book.indexHash,
      page: kind === "page" ? 3 : 1,
      ...(kind === "shape" ? { extra: "bad" } : {}),
    };
    await env.DB.prepare("INSERT INTO user_reading_state VALUES(?,?,?,?,1)")
      .bind(f.ids.user, f.node.id, f.node.blob, JSON.stringify(position))
      .run();
    expect((await f.read()).reading).toBeNull();
    await f.save();
    expect((await f.read()).reading?.page).toBe(2);
  },
);
it.each([
  "credential",
  "hidden",
  "parent",
  "blob",
  "index",
  "generator",
  "epoch",
  "share",
  "freeze",
])("rechecks %s in the final reading-state transaction", async (kind) => {
  const f = await fixture(),
    p: Extract<Principal, { kind: "user" }> = kind === "share" ? await shared(f) : f.principal;
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO user_reading_state"),
    async () => {
      if (kind === "credential")
        await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
          .bind(f.ids.session)
          .run();
      if (kind === "hidden")
        await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.ids.folder).run();
      if (kind === "parent")
        await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
          .bind(f.ids.root, f.node.id)
          .run();
      if (kind === "blob")
        await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
          .bind(f.node.id)
          .run();
      if (kind === "index")
        await env.DB.prepare("UPDATE archive_index SET sha256=? WHERE node_id=?")
          .bind("f".repeat(64), f.node.id)
          .run();
      if (kind === "generator")
        await env.DB.prepare("UPDATE library_items SET generator_version='old' WHERE node_id=?")
          .bind(f.node.id)
          .run();
      if (kind === "epoch") await env.DB.prepare("UPDATE control SET maintenance=1,epoch=2").run();
      if (kind === "share")
        await env.DB.prepare("UPDATE share_grants SET disabled_at=1 WHERE share_id=? AND user_id=?")
          .bind(p.selected_share?.id ?? "", p.user_id)
          .run();
      if (kind === "freeze")
        await env.DB.prepare("UPDATE control SET backup_frozen=1,backup_token='test'").run();
    },
    false,
  );
  await expect(f.save(f.input, p, db)).rejects.toThrow();
  expect(await f.rows()).toEqual([]);
});
it("does not clobber a position changed between preflight and commit", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO user_reading_state"),
    async () => {
      await f.save({ ...f.input, page: 1 });
    },
    false,
  );
  await expect(f.save(f.input, f.principal, db)).rejects.toBeInstanceOf(ReadingConflict);
  expect((await f.read()).reading?.page).toBe(1);
});
it("recovers an acknowledged database commit after its response is lost", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO user_reading_state"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const result = await f.save(f.input, f.principal, db);
  expect((await f.read()).reading).toEqual(result);
  expect(await f.rows()).toHaveLength(1);
});
it.each([0, 1.1, 3, 10001, NaN])("rejects an invalid or out-of-book page %s", async (page) => {
  const f = await fixture();
  await expect(f.save({ ...f.input, page })).rejects.toThrow("invalid_reading_update");
  expect(await f.rows()).toEqual([]);
});
it("checks CSRF, exact body fields, generation, and conflicts on the private PUT route", async () => {
  const f = await fixture();
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const csrf = new CsrfTokens(ring, ring, f.app.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request(`${f.app.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: { Origin: f.app.APP_ORIGIN, "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: f.principal.credential_id, epoch: 1 },
  );
  const request = (body: unknown = f.input, token?: string) =>
    new Request(`${f.app.APP_ORIGIN}/api/v1/library/${f.node.id}/reading-state`, {
      method: "PUT",
      headers: {
        Origin: f.app.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      body: JSON.stringify(body),
    });
  const http = (body: unknown, token = issued.token) =>
    handleReadingStateHttp(request(body, token), f.app, f.principal, csrf);
  expect(privateAppRoute(request())).toBe(true);
  expect((await http(f.input, "")).status).toBe(403);
  expect((await http({ ...f.input, userId: "other" })).status).toBe(400);
  expect((await http({ ...f.input, previousUpdatedAt: undefined })).status).toBe(400);
  expect((await http({ ...f.input, indexHash: "f".repeat(64) })).status).toBe(404);
  const response = await http(f.input);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await http(f.input)).status).toBe(409);
});
