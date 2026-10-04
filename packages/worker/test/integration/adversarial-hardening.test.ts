import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { acceptContentTicket } from "../../src/auth/contentAccept";
import { ContentTokens, contentKeyRing } from "../../src/auth/contentTokens";
import { ListCursorTokens } from "../../src/auth/listCursor";
import { atomicBatch, type SqlStatement } from "../../src/db/primary";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { prepareCookieBlobRead } from "../../src/services/blobRead";
import { issueContentTicket } from "../../src/services/contentTicket";
import { readNodePath } from "../../src/services/nodeRead";
import { putFile } from "../../src/services/putFile";
import { trashNode } from "../../src/services/trashNode";
import { listTrash } from "../../src/services/trashRead";
import { davPutFixture } from "../fixtures/davPut";
import { foundationFixture } from "../fixtures/foundation";
import { multipartInventoryFixture } from "../fixtures/multipartInventory";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { admitted } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
});

async function fixture() {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  const first = await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc");
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
  return { f, now, tokens, principal };
}

// H1: a DAV PUT overwrite must not rewrite a file whose blob carries an
// NCFENC2 encryption mark — the same guard rename/move/copy already enforce.
it("refuses a DAV PUT overwrite on an encryption-marked file", async () => {
  const f = await davPutFixture(3);
  await env.DB.prepare(`INSERT INTO blob_encryption(
    blob_id,owner_id,header_sha256,signer_rsa_fingerprint,signer_signing_fingerprint,
    required_admin_fingerprint,crypto_id,format_version,admin_receipt_state,verified_at)
    VALUES(?,?,'${"a".repeat(64)}','${"A".repeat(43)}','${"B".repeat(43)}',
      '${"C".repeat(43)}','fixture-crypto',2,'pending',?)`)
    .bind(f.ids.blob, f.ids.user, Date.now())
    .run();
  await expect(
    putFile(f.app, {
      ...f.input,
      nodeId: f.ids.file,
      parentId: f.ids.folder,
      name: "File",
      body: new Blob(["xyz"]).stream(),
    }),
  ).rejects.toThrow("encrypted_operation_forbidden");
});

// H2: byte delivery through a share requires the share's 'download' action —
// 'read' alone only covers listing/metadata scope.
it("denies internal-share byte delivery until the download action exists", async () => {
  const { f, now, tokens, principal } = await fixture();
  const shareId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [shareId, f.ids.user, f.ids.folder, now],
    },
    {
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')",
      values: [shareId],
    },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [shareId, f.ids.user],
    },
  ]);
  await expect(
    issueContentTicket(
      mutationEnv(),
      env.BLOBS,
      tokens,
      principal,
      [{ spaceId: f.ids.space, nodeId: f.ids.file }],
      "content",
      now + 300_000,
      { id: shareId, version: 1 },
    ),
  ).rejects.toThrow();
  await env.DB.prepare("INSERT INTO share_actions(share_id,action) VALUES(?,'download')")
    .bind(shareId)
    .run();
  const issued = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: f.ids.file }],
    "content",
    now + 300_000,
    { id: shareId, version: 1 },
  );
  const accepted = await acceptContentTicket(mutationEnv(), tokens, issued.ticket);
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
  ).resolves.toMatchObject({ budgetId: issued.budgetId });
});

// H3: trash_ops.actor_id keeps the initiating principal so overwrite receipts
// reconcile, while every owner-facing read grants the space owner visibility.
it("keeps the initiator in trash_ops while the owner sees the op", async () => {
  const { f, now } = await fixture();
  const recipient = foundationFixture(crypto.randomUUID(), now);
  const shareId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    ...recipient.statements,
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [shareId, f.ids.user, f.ids.folder, now],
    },
    {
      sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read'),(?,'edit')",
      values: [shareId, shareId],
    },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [shareId, recipient.ids.user],
    },
  ]);
  const trashed = await trashNode(admitted(), {
    principal: {
      kind: "user",
      user_id: recipient.ids.user,
      credential_id: recipient.ids.credential,
      epoch: 1,
      internal_share: {
        share_id: shareId,
        share_version: 1,
        recipient: { kind: "direct", version: 1 },
      },
    },
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.file,
    lockTokens: [],
  });
  expect(trashed.kind).toBe("terminal");
  if (trashed.kind !== "terminal") throw new Error("trash_not_terminal");
  expect(
    await env.DB.prepare("SELECT actor_id FROM trash_ops WHERE root_node_id=?")
      .bind(f.ids.file)
      .first<string>("actor_id"),
  ).toBe(recipient.ids.user);
  const ring = await contentKeyRing("cursor", {
    cursor: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const listed = await listTrash(
    env.DB,
    { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch: 1 },
    new ListCursorTokens(ring),
    f.ids.space,
  );
  expect(listed.items.map((item) => item.opId)).toContain(trashed.operation.id);
});

// M1: trashing a subtree revokes only the tickets/content sessions whose
// recorded node set intersects it — never every set the owner holds.
it("cancels only the tickets covering a trashed subtree", async () => {
  const { f, now, tokens, principal } = await fixture();
  const secondFolder = crypto.randomUUID();
  const secondFile = crypto.randomUUID();
  const secondBlob = crypto.randomUUID();
  const secondKey = `u/${f.ids.user}/b/${secondBlob}`;
  const second = await env.BLOBS.put(secondKey, "de");
  if (!second) throw new Error("r2_fixture_failed");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'Second','second','folder',?,?)",
      values: [secondFolder, f.ids.space, f.ids.user, f.ids.root, now, now],
    },
    {
      sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,2,?,'committed',?)",
      values: [secondBlob, f.ids.user, secondKey, `"b-${secondBlob}"`, now],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'Other','other','file',?,?,?)",
      values: [secondFile, f.ids.space, f.ids.user, secondFolder, secondBlob, now, now],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,2,?,?)",
      values: [secondBlob, second.etag, now],
    },
  ]);
  const kept = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: f.ids.file }],
    "content",
    now + 300_000,
  );
  const dropped = await issueContentTicket(
    mutationEnv(),
    env.BLOBS,
    tokens,
    principal,
    [{ spaceId: f.ids.space, nodeId: secondFile }],
    "content",
    now + 300_000,
  );
  const keptSession = await acceptContentTicket(mutationEnv(), tokens, kept.ticket);
  const droppedSession = await acceptContentTicket(mutationEnv(), tokens, dropped.ticket);
  expect(
    await env.DB.prepare(
      "SELECT node_id FROM target_set_nodes WHERE target_set_id IN (?,?) ORDER BY node_id",
    )
      .bind(kept.targetSetId, dropped.targetSetId)
      .all<{ node_id: string }>(),
  ).toMatchObject({
    results: expect.arrayContaining([{ node_id: f.ids.file }, { node_id: secondFile }]),
  });
  const trashed = await trashNode(admitted(), {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: secondFolder,
    lockTokens: [],
  });
  expect(trashed.kind).toBe("terminal");
  const tickets = await env.DB.prepare(
    "SELECT id,cancelled_at IS NOT NULL AS cancelled FROM tickets WHERE id IN (?,?) ORDER BY id",
  )
    .bind(kept.ticketId, dropped.ticketId)
    .all<{ id: string; cancelled: number }>();
  expect(Object.fromEntries((tickets.results ?? []).map((row) => [row.id, row.cancelled]))).toEqual(
    { [kept.ticketId]: 0, [dropped.ticketId]: 1 },
  );
  const sessions = await env.DB.prepare(
    "SELECT id,revoked_at IS NOT NULL AS revoked FROM content_sessions WHERE id IN (?,?) ORDER BY id",
  )
    .bind(keptSession.sessionId, droppedSession.sessionId)
    .all<{ id: string; revoked: number }>();
  expect(Object.fromEntries((sessions.results ?? []).map((row) => [row.id, row.revoked]))).toEqual({
    [keptSession.sessionId]: 0,
    [droppedSession.sessionId]: 1,
  });
});

// M2: a single space cannot occupy the whole 256-slot waiting window — 64 per
// space, 224 for non-system callers total, leaving room for system/global work.
it("bounds waiting admissions per space and reserves slots for system work", async () => {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...f.statements, ...other.statements]);
  const insert = (spaceId: string | null, system: number, permitId = crypto.randomUUID()) =>
    env.DB.prepare(
      `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until)
      VALUES(?,?,?,1,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`,
    )
      .bind(crypto.randomUUID(), permitId, spaceId, system, 0)
      .run();
  const fill = async (spaceId: string | null, system: number, count: number) => {
    const statements: SqlStatement[] = [];
    for (let i = 0; i < count; i++)
      statements.push({
        sql: `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until)
          VALUES(?,?,?,1,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`,
        values: [crypto.randomUUID(), crypto.randomUUID(), spaceId, system, 0],
      });
    for (let start = 0; start < statements.length; start += 45)
      await atomicBatch(env.DB, statements.slice(start, start + 45));
  };
  const third = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const fourth = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...third.statements, ...fourth.statements]);
  await fill(f.ids.space, 0, 64);
  await expect(insert(f.ids.space, 0)).rejects.toThrow("mutation_unavailable");
  await insert(other.ids.space, 0);
  await fill(other.ids.space, 0, 63);
  await fill(third.ids.space, 0, 64);
  await fill(fourth.ids.space, 0, 32); // non-system waiting total reaches 224
  await expect(insert(third.ids.space, 0)).rejects.toThrow("mutation_unavailable");
  for (let i = 0; i < 32; i++) await insert(null, 1, `global:${crypto.randomUUID()}`); // system work still admitted
  await expect(insert(null, 1, `global:${crypto.randomUUID()}`)).rejects.toThrow(
    "mutation_unavailable",
  ); // 256 total
});

// M5: an expired claimed settlement may be handed to a later proven closure run;
// a live claim, a non-proven run, or a settled row stays immutable.
it("allows settlement handover only to a proven run over an expired claim", async () => {
  const f = await multipartInventoryFixture({ known: true });
  await f.handle.abort();
  const now = Date.now();
  const source = JSON.stringify(new R2S3Inventory(inventoryEnv).source);
  await atomicBatch(env.DB, [
    {
      sql: `UPDATE uploads SET state='failed',accept_parts=0,in_flight=0,cleanup_pending=1,
        multipart_cleanup_started_at=? WHERE id=?`,
      values: [now, f.id],
    },
    { sql: "UPDATE blobs SET state='orphan' WHERE id=?", values: [f.blob] },
    {
      sql: `INSERT INTO multipart_inventory_scans(
        upload_id,r2_key,source,epoch,round_id,pages,completed_at,next_scan_at
      ) VALUES(?,?,?,?,?,1,?,0)`,
      values: [f.id, f.key, source, 1, crypto.randomUUID(), now],
    },
  ]);
  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();
  const runStale = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO multipart_closure_runs(id,source,epoch,phase,not_before,scan_round_id,proven_at,created_at,updated_at)
        VALUES(?,?,1,'proven',0,'scan-a',?,?,?)`,
      values: [runA, source, now - 10, now - 10, now - 10],
    },
    {
      sql: `INSERT INTO multipart_closure_runs(id,source,epoch,phase,not_before,scan_round_id,proven_at,created_at,updated_at)
        VALUES(?,?,1,'proven',0,'scan-b',?,?,?)`,
      values: [runB, source, now - 10, now - 10, now - 10],
    },
    {
      sql: `INSERT INTO multipart_closure_runs(id,source,epoch,phase,not_before,scan_round_id,created_at,updated_at)
        VALUES(?,?,1,'stale',0,'scan-c',?,?)`,
      values: [runStale, source, now - 10, now - 10],
    },
    {
      sql: `INSERT INTO multipart_upload_settlements(upload_id,closure_id,owner_id,reservation_id,
        token,lease_expires_at,claimed_at,state) VALUES(?,?,?,?,?,1,?,'claimed')`,
      values: [f.id, runA, f.ids.user, f.reservation, crypto.randomUUID(), now - 10],
    },
  ]);
  await expect(
    env.DB.prepare("UPDATE multipart_upload_settlements SET closure_id=? WHERE upload_id=?")
      .bind(runStale, f.id)
      .run(),
  ).rejects.toThrow("immutable_multipart_upload_settlement");
  await env.DB.prepare(
    `UPDATE multipart_upload_settlements SET lease_expires_at=strftime('%s','now')*1000+60000
      WHERE upload_id=?`,
  )
    .bind(f.id)
    .run();
  await expect(
    env.DB.prepare("UPDATE multipart_upload_settlements SET closure_id=? WHERE upload_id=?")
      .bind(runB, f.id)
      .run(),
  ).rejects.toThrow("immutable_multipart_upload_settlement");
  await env.DB.prepare(
    "UPDATE multipart_upload_settlements SET lease_expires_at=1 WHERE upload_id=?",
  )
    .bind(f.id)
    .run();
  await env.DB.prepare("UPDATE multipart_upload_settlements SET closure_id=? WHERE upload_id=?")
    .bind(runB, f.id)
    .run();
  expect(
    await env.DB.prepare("SELECT closure_id FROM multipart_upload_settlements WHERE upload_id=?")
      .bind(f.id)
      .first<string>("closure_id"),
  ).toBe(runB);
});

// L1: /nodes/:id/path must not reveal ancestors above a caller's share root.
it("truncates breadcrumb paths at the principal's share root", async () => {
  const { f, now } = await fixture();
  const shareId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
      values: [shareId, f.ids.user, f.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
    {
      sql: `INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
        VALUES(?,?,1,?,1,?,?)`,
      values: [sessionId, shareId, `digest-${sessionId}`, now, now + 400_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [`ss:${sessionId}`, sessionId],
    },
  ]);
  const linkPath = await readNodePath(
    env.DB,
    {
      kind: "link_share",
      share_id: shareId,
      share_version: 1,
      credential_id: `ss:${sessionId}`,
      epoch: 1,
    },
    f.ids.file,
  );
  expect(linkPath.path.map((row) => row.id)).toEqual([f.ids.folder, f.ids.file]);

  const recipient = foundationFixture(crypto.randomUUID(), now);
  const internalId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    ...recipient.statements,
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [internalId, f.ids.user, f.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [internalId] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [internalId, recipient.ids.user],
    },
  ]);
  const sharedPath = await readNodePath(
    env.DB,
    {
      kind: "user",
      user_id: recipient.ids.user,
      credential_id: recipient.ids.credential,
      epoch: 1,
    },
    f.ids.file,
  );
  expect(sharedPath.path.map((row) => row.id)).toEqual([f.ids.folder, f.ids.file]);

  const fullPath = await readNodePath(
    env.DB,
    {
      kind: "user",
      user_id: f.ids.user,
      credential_id: f.ids.credential,
      epoch: 1,
    },
    f.ids.file,
  );
  expect(fullPath.path.map((row) => row.id)).toEqual([f.ids.root, f.ids.folder, f.ids.file]);
});
