import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { assertExists, assertOneChange, atomicBatch } from "../../src/db/primary";
import { observePhysicalObject } from "../../src/services/physical";
import {
  finishReservationStatements,
  physicalQuota,
  type ReservationInput,
  reservationStatements,
} from "../../src/services/quota";
import { addPinStatements, auditOwnerLedger, removePinStatements } from "../../src/services/refs";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const reservation: ReservationInput = {
    id: `res-${f.ids.user}`,
    ownerId: f.ids.user,
    bytes: 10,
    expiresAt: Date.now() + 600000,
    epoch: 1,
  };
  return { ...f, reservation };
}
async function refs(blobId: string) {
  return env.DB.prepare("SELECT ref_count FROM blobs WHERE id=?").bind(blobId).first("ref_count");
}
async function audit(userId: string) {
  const result = await auditOwnerLedger(env.DB, userId);
  expect(result).not.toBeNull();
  expect(result?.incorrect_refs).toBe(0);
  expect(result?.used_bytes).toBe(result?.actual_used_bytes);
  expect(result?.reserved_bytes).toBe(result?.actual_reserved_bytes);
  expect(result?.physical_bytes).toBe(result?.observed_physical_bytes);
  return result;
}

it("reserves once on replay, rejects a changed intent and releases without counter drift", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE users SET quota_bytes=13 WHERE id=?").bind(f.ids.user).run();
  await Promise.all([
    atomicBatch(env.DB, reservationStatements(f.reservation)),
    atomicBatch(env.DB, reservationStatements(f.reservation)),
  ]);
  expect((await audit(f.ids.user))?.reserved_bytes).toBe(10);
  await expect(
    atomicBatch(env.DB, reservationStatements({ ...f.reservation, bytes: 9 })),
  ).rejects.toThrow();
  await expect(
    atomicBatch(env.DB, reservationStatements({ ...f.reservation, id: "extra", bytes: 1 })),
  ).rejects.toThrow();
  await atomicBatch(
    env.DB,
    finishReservationStatements(f.reservation.id, f.ids.user, 1, "released"),
  );
  await atomicBatch(
    env.DB,
    finishReservationStatements(f.reservation.id, f.ids.user, 1, "released"),
  );
  expect((await audit(f.ids.user))?.reserved_bytes).toBe(0);
  await expect(atomicBatch(env.DB, reservationStatements(f.reservation))).rejects.toThrow();
});

it("serializes competing reservations at the owner limit and rolls back the loser", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE users SET quota_bytes=13 WHERE id=?").bind(f.ids.user).run();
  const results = await Promise.allSettled(
    ["a", "b"].map((suffix) =>
      atomicBatch(
        env.DB,
        reservationStatements({ ...f.reservation, id: `${f.reservation.id}-${suffix}` }),
      ),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await audit(f.ids.user))?.reserved_bytes).toBe(10);
});

it("acquires the owner and upload-only share budgets together", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at,reservation_limit) VALUES(?,?,?,'upload_only',?,9)",
  )
    .bind(f.ids.user, f.ids.user, f.ids.folder, Date.now())
    .run();
  const reservation = { ...f.reservation, share: { id: f.ids.user, version: 1 } };
  await expect(atomicBatch(env.DB, reservationStatements(reservation))).rejects.toThrow();
  expect((await audit(f.ids.user))?.reserved_bytes).toBe(0);
  await env.DB.prepare("UPDATE shares SET reservation_limit=10 WHERE id=?").bind(f.ids.user).run();
  await atomicBatch(env.DB, reservationStatements(reservation));
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(10);
  await atomicBatch(env.DB, finishReservationStatements(reservation.id, f.ids.user, 1, "released"));
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM shares WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(0);
  await audit(f.ids.user);
});

it("consumes reservation and publishes a reference atomically, including a later batch failure", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE users SET quota_bytes=13 WHERE id=?").bind(f.ids.user).run();
  await atomicBatch(env.DB, reservationStatements(f.reservation));
  const blob = `new-${f.ids.blob}`;
  await env.DB.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,10,'etag','staging',?)",
  )
    .bind(blob, f.ids.user, blob, Date.now())
    .run();
  const publish = [
    ...finishReservationStatements(f.reservation.id, f.ids.user, 1, "consumed"),
    {
      sql: "INSERT INTO node_versions(id,node_id,blob_id,revision,created_at) VALUES(?,?,?,2,?)",
      values: [blob, f.ids.file, blob, Date.now()],
    },
    assertOneChange,
  ];
  await expect(
    atomicBatch(env.DB, [...publish, assertExists("SELECT 1 WHERE 0")]),
  ).rejects.toThrow();
  expect((await audit(f.ids.user))?.reserved_bytes).toBe(10);
  expect(await refs(blob)).toBe(0);
  await atomicBatch(env.DB, publish);
  expect(await audit(f.ids.user)).toMatchObject({ used_bytes: 13, reserved_bytes: 0 });
  await expect(
    atomicBatch(env.DB, finishReservationStatements(f.reservation.id, f.ids.user, 1, "released")),
  ).rejects.toThrow();
});

it("charges an owner only once for COW/current/version/trash references and excludes pins from logical quota", async () => {
  const f = await fixture();
  const copy = `copy-${f.ids.file}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) SELECT ?,space_id,owner_id,parent_id,'Copy','copy','file',current_blob_id,created_at,updated_at FROM nodes WHERE id=?",
      values: [copy, f.ids.file],
    },
    assertOneChange,
    {
      sql: "INSERT INTO node_versions(id,node_id,blob_id,revision,created_at) VALUES(?,?,?,1,?)",
      values: [copy, f.ids.file, f.ids.blob, Date.now()],
    },
    ...addPinStatements({ id: copy, blobId: f.ids.blob, purpose: "backup", expiresAt: null }, 1),
  ]);
  expect(await refs(f.ids.blob)).toBe(4);
  expect((await audit(f.ids.user))?.used_bytes).toBe(3);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES(?,?,?,?,'trashed',?,1)",
      values: [copy, f.ids.user, f.ids.space, copy, Date.now()],
    },
    {
      sql: "UPDATE nodes SET deleted_at=?,deleted_op_id=? WHERE id=?",
      values: [Date.now(), copy, copy],
    },
  ]);
  expect((await audit(f.ids.user))?.used_bytes).toBe(3);
  await atomicBatch(env.DB, [
    { sql: "DELETE FROM node_versions WHERE id=?", values: [copy] },
    { sql: "DELETE FROM nodes WHERE id=?", values: [copy] },
    { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [f.ids.file] },
  ]);
  expect(await refs(f.ids.blob)).toBe(1);
  expect((await audit(f.ids.user))?.used_bytes).toBe(0);
  await atomicBatch(env.DB, removePinStatements(copy, f.ids.blob, 1));
  await atomicBatch(env.DB, removePinStatements(copy, f.ids.blob, 1));
  expect(await refs(f.ids.blob)).toBe(0);
});

it("replaces a last current reference at an exact quota without depending on trigger order", async () => {
  const f = await fixture();
  const blob = `new-${f.ids.blob}`;
  await env.DB.prepare("UPDATE users SET quota_bytes=3 WHERE id=?").bind(f.ids.user).run();
  await env.DB.prepare(
    "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','committed',?)",
  )
    .bind(blob, f.ids.user, blob, Date.now())
    .run();
  await atomicBatch(env.DB, [
    { sql: "UPDATE nodes SET current_blob_id=? WHERE id=?", values: [blob, f.ids.file] },
    assertOneChange,
  ]);
  expect(await refs(f.ids.blob)).toBe(0);
  expect(await refs(blob)).toBe(1);
  expect((await audit(f.ids.user))?.used_bytes).toBe(3);
});

it("keeps multiple pins independent and rejects reference 1001 without partial side effects", async () => {
  const f = await fixture();
  await env.DB.prepare(`WITH RECURSIVE count(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM count WHERE n<999)
    INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) SELECT ?||'-pin-'||n,?,'backup',NULL,1 FROM count`)
    .bind(f.ids.user, f.ids.blob)
    .run();
  expect(await refs(f.ids.blob)).toBe(1000);
  await expect(
    atomicBatch(
      env.DB,
      addPinStatements(
        {
          id: `overflow-${f.ids.user}`,
          blobId: f.ids.blob,
          purpose: "zip",
          expiresAt: Date.now() + 1000,
        },
        1,
      ),
    ),
  ).rejects.toThrow();
  await atomicBatch(env.DB, removePinStatements(`${f.ids.user}-pin-1`, f.ids.blob, 1));
  expect(await refs(f.ids.blob)).toBe(999);
  await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(f.ids.file).run();
  await expect(
    env.DB.prepare("UPDATE blobs SET state='deleting' WHERE id=?").bind(f.ids.blob).run(),
  ).rejects.toThrow();
  await audit(f.ids.user);
});

it("counts staging/orphan physical bytes from R2 once, even after response loss or quota reduction", async () => {
  const f = await fixture();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  await env.DB.prepare("UPDATE blobs SET state='orphan' WHERE id=?").bind(f.ids.blob).run();
  await env.DB.prepare("UPDATE users SET quota_bytes=1 WHERE id=?").bind(f.ids.user).run();
  await env.BLOBS.put(key, new Uint8Array([1, 2, 3]));
  try {
    const lossy = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        await env.DB.batch(statements);
        throw new Error("response_lost");
      },
    } as unknown as D1Database;
    await expect(observePhysicalObject(lossy, env.BLOBS, f.ids.blob, 1)).rejects.toThrow(
      "response_lost",
    );
    await observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1);
    await observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1);
    expect((await audit(f.ids.user))?.physical_bytes).toBe(3);
    await expect(
      atomicBatch(env.DB, reservationStatements({ ...f.reservation, bytes: 0 })),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE blob_storage SET removed_at=? WHERE blob_id=?")
        .bind(Date.now(), f.ids.blob)
        .run(),
    ).rejects.toThrow();
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("accounts size-mismatched objects while rejecting publication, and rejects stale-epoch observations", async () => {
  const f = await fixture();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  await expect(observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1)).rejects.toThrow(
    "physical_object_mismatch",
  );
  await env.BLOBS.put(key, new Uint8Array(2));
  try {
    await expect(observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1)).rejects.toThrow();
    expect((await audit(f.ids.user))?.physical_bytes).toBe(2);
    await expect(observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1)).rejects.toThrow();
    expect((await audit(f.ids.user))?.physical_bytes).toBe(2);
    const other = await fixture();
    const otherKey = `u/${other.ids.user}/b/${other.ids.blob}`;
    await env.BLOBS.put(otherKey, new Uint8Array(3));
    try {
      await expect(observePhysicalObject(env.DB, env.BLOBS, other.ids.blob, 2)).rejects.toThrow();
      expect((await audit(other.ids.user))?.physical_bytes).toBe(0);
    } finally {
      await env.BLOBS.delete(otherKey);
    }
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("uses the physical reserve cap and exact integer arithmetic at the maximum quota", async () => {
  expect(physicalQuota(7_505_999_378_950_825)).toBe(9_007_199_254_740_990);
  expect(physicalQuota(13)).toBe(15);
  const f = await fixture();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  await env.BLOBS.put(key, new Uint8Array(3));
  try {
    await observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1);
    await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?").bind(f.ids.file).run();
    await env.DB.prepare("UPDATE users SET quota_bytes=10 WHERE id=?").bind(f.ids.user).run();
    await expect(atomicBatch(env.DB, reservationStatements(f.reservation))).rejects.toThrow(); // 3 + 10 > 12
    await atomicBatch(env.DB, reservationStatements({ ...f.reservation, bytes: 9 }));
    expect((await audit(f.ids.user))?.reserved_bytes).toBe(9);
  } finally {
    await env.BLOBS.delete(key);
  }
});

it("unaccounts a physically deleted object once and preserves the removal tombstone", async () => {
  const f = await fixture();
  const key = `u/${f.ids.user}/b/${f.ids.blob}`;
  await env.BLOBS.put(key, new Uint8Array(3));
  try {
    await observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1);
    await atomicBatch(env.DB, [
      { sql: "UPDATE nodes SET current_blob_id=NULL WHERE id=?", values: [f.ids.file] },
      {
        sql: "INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',0)",
        values: [f.ids.blob],
      },
      { sql: "UPDATE blobs SET state='deleting' WHERE id=?", values: [f.ids.blob] },
      { sql: "UPDATE gc_candidates SET state='deleting' WHERE blob_id=?", values: [f.ids.blob] },
    ]);
    expect((await audit(f.ids.user))?.physical_bytes).toBe(3);
    await env.BLOBS.delete(key);
    expect(await env.BLOBS.head(key)).toBeNull();
    // Fixture for the future fenced GC finalizer, after actual R2 absence verification.
    await atomicBatch(env.DB, [
      { sql: "UPDATE blobs SET state='deleted' WHERE id=?", values: [f.ids.blob] },
      { sql: "UPDATE gc_candidates SET state='deleted' WHERE blob_id=?", values: [f.ids.blob] },
      {
        sql: "UPDATE blob_storage SET removed_at=? WHERE blob_id=?",
        values: [Date.now(), f.ids.blob],
      },
    ]);
    await env.DB.prepare("UPDATE blob_storage SET removed_at=removed_at WHERE blob_id=?")
      .bind(f.ids.blob)
      .run();
    expect((await audit(f.ids.user))?.physical_bytes).toBe(0);
    await expect(
      env.DB.prepare("UPDATE blob_storage SET removed_at=NULL WHERE blob_id=?")
        .bind(f.ids.blob)
        .run(),
    ).rejects.toThrow();
    await expect(observePhysicalObject(env.DB, env.BLOBS, f.ids.blob, 1)).rejects.toThrow();
  } finally {
    await env.BLOBS.delete(key);
  }
});
