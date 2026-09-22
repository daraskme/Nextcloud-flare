import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { inspectRecoveryPage, type RecoveryCursor } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

const fixtures: ReturnType<typeof foundationFixture>[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("UPDATE control SET bootstrap_done_at=1,maintenance=1,gc_paused=1").run();
  for (let i = 0; i < 2; i++) {
    const fixture = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
    fixtures.push(fixture);
    await atomicBatch(env.DB, fixture.statements);
    const key = `u/${fixture.ids.user}/b/${fixture.ids.blob}`;
    const object = await env.BLOBS.put(key, "abc");
    if (!object) throw new Error("fixture_r2_put_failed");
    await env.DB.prepare(`INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at)
      VALUES(?,3,?,1)`)
      .bind(fixture.ids.blob, object.etag)
      .run();
  }
  const bootstrapUser = fixtures[0]?.ids.user;
  if (!bootstrapUser) throw new Error("missing_fixture");
  await env.DB.prepare("UPDATE control SET bootstrap_iss=?,bootstrap_sub=? WHERE singleton=1")
    .bind("https://access.invalid", bootstrapUser)
    .run();
});

it("checks users, ledgers, roots and R2 blobs in bounded pages", async () => {
  let cursor: RecoveryCursor | null = { stage: "users", afterId: "" };
  let examined = 0;
  let pages = 0;
  while (cursor) {
    const page = await inspectRecoveryPage(env.DB, env.BLOBS, 1, cursor, 1);
    expect(page.examined).toBeLessThanOrEqual(1);
    examined += page.examined;
    cursor = page.next;
    if (++pages > 25) throw new Error("recovery_page_loop");
  }
  expect(examined).toBe(10);
});

it("detects source rows missing their credential registry entries", async () => {
  const owner = fixtures[0];
  if (!owner) throw new Error("missing_fixture");
  const accessId = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const shareId = crypto.randomUUID();
  const shareSessionId = crypto.randomUUID();
  const serviceId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sessions(id,user_id,kind,fingerprint,epoch,issued_at,expires_at,last_seen_at)
    VALUES(?,?,'access',?,1,1,2,1)`)
    .bind(accessId, owner.ids.user, accessId)
    .run();
  await env.DB.prepare(`INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
    VALUES(?,?,?,'recovery','digest','salt','PBKDF2-SHA256','{"iterations":100000}','kid',1,2)`)
    .bind(passwordId, owner.ids.user, owner.ids.root)
    .run();
  await env.DB.prepare(
    "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',1)",
  )
    .bind(shareId, owner.ids.user, owner.ids.root)
    .run();
  await env.DB.prepare(`INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
    VALUES(?,?,1,?,1,1,2)`)
    .bind(shareSessionId, shareId, shareSessionId)
    .run();
  await env.DB.prepare(`INSERT INTO service_principals(id,access_iss,common_name,mapped_user_id,space_id,root_node_id)
    VALUES(?,'https://access.invalid',?,?,?,?)`)
    .bind(serviceId, serviceId, owner.ids.user, owner.ids.space, owner.ids.root)
    .run();
  try {
    for (const tag of ["a", "p", "s", "v"]) {
      await expect(
        inspectRecoveryPage(
          env.DB,
          env.BLOBS,
          1,
          { stage: "credential_sources", afterId: `${tag}:` },
          20,
        ),
      ).rejects.toThrow(/recovery_credential_registry_missing/);
    }
  } finally {
    await env.DB.prepare("DELETE FROM service_principals WHERE id=?").bind(serviceId).run();
    await env.DB.prepare("DELETE FROM share_sessions WHERE id=?").bind(shareSessionId).run();
    await env.DB.prepare("DELETE FROM shares WHERE id=?").bind(shareId).run();
    await env.DB.prepare("DELETE FROM app_passwords WHERE id=?").bind(passwordId).run();
    await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(accessId).run();
  }
});

it("detects an R2 object without a durable D1 owner", async () => {
  const key = `orphan/${crypto.randomUUID()}`;
  await env.BLOBS.put(key, "unexpected");
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "r2", afterId: "" }, 20),
    ).rejects.toThrow(/recovery_untracked_r2_object/);
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("keeps the final fence closed until a reservation is released", async () => {
  const owner = fixtures[0];
  if (!owner) throw new Error("missing_fixture");
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch)
    VALUES(?,?,1,'reserved',?,1)`)
    .bind(id, owner.ids.user, Date.now() + 60000)
    .run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "fence", afterId: "" }),
    ).rejects.toThrow(/recovery_final_fence_pending/);
    await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?").bind(id).run();
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "fence", afterId: "" }),
    ).resolves.toEqual({ examined: 0, next: null });
  } finally {
    await env.DB.prepare("UPDATE reservations SET state='released' WHERE id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM reservations WHERE id=?").bind(id).run();
  }
});

it("rejects share counter drift and a live root from another owner", async () => {
  const owner = fixtures[0];
  const other = fixtures[1];
  if (!owner || !other) throw new Error("missing_fixture");
  const shareId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',1)",
  )
    .bind(shareId, owner.ids.user, owner.ids.root)
    .run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "shares", afterId: "" }),
    ).resolves.toMatchObject({ examined: 1, next: { stage: "credentials" } });
    await env.DB.prepare("UPDATE shares SET reserved_bytes=1 WHERE id=?").bind(shareId).run();
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "shares", afterId: "" }),
    ).rejects.toThrow(/recovery_share_mismatch/);
    await env.DB.prepare("UPDATE shares SET reserved_bytes=0,root_node_id=? WHERE id=?")
      .bind(other.ids.root, shareId)
      .run();
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "shares", afterId: "" }),
    ).rejects.toThrow(/recovery_share_mismatch/);
  } finally {
    await env.DB.prepare("DELETE FROM shares WHERE id=?").bind(shareId).run();
  }
});

it("rejects a credential registry row with the wrong session kind", async () => {
  const owner = fixtures[0];
  if (!owner) throw new Error("missing_fixture");
  const sessionId = crypto.randomUUID();
  const credentialId = `as:${sessionId}`;
  await env.DB.prepare(`INSERT INTO sessions(id,user_id,kind,fingerprint,epoch,issued_at,expires_at,last_seen_at)
    VALUES(?,?,'share',?,1,1,2,1)`)
    .bind(sessionId, owner.ids.user, sessionId)
    .run();
  await env.DB.prepare("INSERT INTO credentials(id,kind,session_id) VALUES(?,'access',?)")
    .bind(credentialId, sessionId)
    .run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "credentials", afterId: "" }, 20),
    ).rejects.toThrow(/recovery_credential_mismatch/);
  } finally {
    await env.DB.prepare("DELETE FROM credentials WHERE id=?").bind(credentialId).run();
    await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(sessionId).run();
  }
});

it("checks outbox provenance and dispatch lease shape", async () => {
  const fixture = fixtures[0];
  if (!fixture) throw new Error("missing_fixture");
  const opId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const failedOpId = crypto.randomUUID();
  const failedOutboxId = crypto.randomUUID();
  const permitId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,1,1,'released')",
  )
    .bind(permitId, fixture.ids.space)
    .run();
  await env.DB.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,
    credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,
    claimed_expires_at,expected_steps,created_at,updated_at)
    VALUES(?,'user',?,?,1,?,'node.create','committed','digest',1,?,1,1,0,1,1)`)
    .bind(opId, fixture.ids.user, fixture.ids.credential, fixture.ids.space, permitId)
    .run();
  await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
    VALUES(?,?,'node.created',?,'pending',1,1,1)`)
    .bind(outboxId, opId, fixture.ids.folder)
    .run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "outbox", afterId: "" }),
    ).resolves.toMatchObject({ examined: 1, next: { stage: "shares" } });
    await env.DB.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,
      credential_version,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,
      claimed_expires_at,expected_steps,created_at,updated_at)
      VALUES(?,'user',?,?,1,?,'node.create','failed','digest',1,?,1,1,0,1,1)`)
      .bind(failedOpId, fixture.ids.user, fixture.ids.credential, fixture.ids.space, permitId)
      .run();
    await env.DB.prepare(`INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
      VALUES(?,?,'node.created',?,'pending',1,1,1)`)
      .bind(failedOutboxId, failedOpId, fixture.ids.folder)
      .run();
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "outbox", afterId: "" }),
    ).rejects.toThrow(/recovery_outbox_provenance_mismatch/);
    await env.DB.prepare("DELETE FROM outbox WHERE outbox_id=?").bind(failedOutboxId).run();
    await env.DB.prepare("DELETE FROM operations WHERE op_id=?").bind(failedOpId).run();
    await env.DB.prepare("UPDATE outbox SET state='sent' WHERE outbox_id=?").bind(outboxId).run();
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "outbox", afterId: "" }),
    ).rejects.toThrow(/recovery_outbox_dispatch_mismatch/);
  } finally {
    await env.DB.prepare("DELETE FROM outbox WHERE outbox_id=?").bind(failedOutboxId).run();
    await env.DB.prepare("DELETE FROM outbox WHERE outbox_id=?").bind(outboxId).run();
    await env.DB.prepare("DELETE FROM operations WHERE op_id=?").bind(failedOpId).run();
    await env.DB.prepare("DELETE FROM operations WHERE op_id=?").bind(opId).run();
    await env.DB.prepare("DELETE FROM permits WHERE permit_id=?").bind(permitId).run();
  }
});

it("fails a user page on ledger drift", async () => {
  const user = fixtures[0]?.ids.user;
  if (!user) throw new Error("missing_fixture");
  await env.DB.prepare("UPDATE users SET used_bytes=used_bytes+1 WHERE id=?").bind(user).run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "users", afterId: "" }, 20),
    ).rejects.toThrow(/recovery_ledger_mismatch/);
  } finally {
    await env.DB.prepare("UPDATE users SET used_bytes=used_bytes-1 WHERE id=?").bind(user).run();
  }
});

it("fails a blob page when the recorded R2 object is missing", async () => {
  const fixture = fixtures[0];
  if (!fixture) throw new Error("missing_fixture");
  const key = `u/${fixture.ids.user}/b/${fixture.ids.blob}`;
  await env.BLOBS.delete(key);
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "blobs", afterId: "" }, 20),
    ).rejects.toThrow(/recovery_r2_mismatch/);
  } finally {
    await env.BLOBS.put(key, "abc");
  }
});

it("refuses a page while an open permit or partial bootstrap remains", async () => {
  const fixture = fixtures[0];
  if (!fixture) throw new Error("missing_fixture");
  const permitId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES(?,?,1,?,'open')",
  )
    .bind(permitId, fixture.ids.space, Date.now() + 60000)
    .run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "users", afterId: "" }),
    ).rejects.toThrow(/recovery_not_quiesced/);
  } finally {
    await env.DB.prepare("UPDATE permits SET state='revoked' WHERE permit_id=?")
      .bind(permitId)
      .run();
  }
  await env.DB.prepare("UPDATE control SET bootstrap_done_at=NULL").run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "users", afterId: "" }),
    ).rejects.toThrow(/recovery_partial_bootstrap/);
  } finally {
    await env.DB.prepare("UPDATE control SET bootstrap_done_at=1").run();
  }
  await env.DB.prepare("UPDATE control SET bootstrap_sub='wrong-user'").run();
  try {
    await expect(
      inspectRecoveryPage(env.DB, env.BLOBS, 1, { stage: "users", afterId: "" }),
    ).rejects.toThrow(/recovery_bootstrap_mismatch/);
  } finally {
    await env.DB.prepare("UPDATE control SET bootstrap_sub=?").bind(fixture.ids.user).run();
  }
});
