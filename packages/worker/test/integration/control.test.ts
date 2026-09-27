import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlEpochHistory } from "../../src/do/controlEpochHistory";
import { EPOCH_PREFIX, recoverEpochFloor } from "../../src/do/epochHistory";
import { foundationFixture } from "../fixtures/foundation";
import { grantPermit } from "../fixtures/mutationAdmission";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  const objects = await env.BACKUPS.list({ prefix: EPOCH_PREFIX });
  if (objects.objects.length) await env.BACKUPS.delete(objects.objects.map((object) => object.key));
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=1,gc_paused=1 WHERE singleton=1",
  ).run();
});

async function history(epoch: number) {
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}${epoch}.json`,
    JSON.stringify({ epoch, at: 1, reason: "operator" }),
  );
}

it("refuses startup without history or an operator EPOCH_FLOOR", async () => {
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.recover()).rejects.toThrow(/epoch_floor_required/);
    await expect(instance.status()).rejects.toThrow(/control_not_ready/);
  });
});

it("scans numeric maximum rather than lexicographic last key", async () => {
  await history(9);
  await history(100);
  await history(20);
  expect(await control().recover()).toEqual({ epoch: 101, maintenance: true, gcPaused: true });
  expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(101);
  expect(await (await env.BACKUPS.get(`${EPOCH_PREFIX}101.json`))?.json()).toMatchObject({
    epoch: 101,
  });
});

it("uses a D1 lower bound if it is higher than R2 history", async () => {
  await history(10);
  await env.DB.prepare("UPDATE control SET epoch=40").run();
  expect((await control().recover()).epoch).toBe(41);
});

it("persists through eviction and never reuses an epoch after total DO storage loss", async () => {
  await history(40);
  expect((await control().recover()).epoch).toBe(41);
  await evictDurableObject(control());
  expect((await control().status()).epoch).toBe(41);
  await runInDurableObject(control(), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(control());
  await env.DB.prepare("UPDATE control SET epoch=1").run(); // simulate old D1 restoration too
  expect((await control().recover()).epoch).toBe(42);
});

it("fences parallel epoch requests and rejects a retried old expected epoch", async () => {
  await history(8);
  await control().recover();
  await runInDurableObject(control(), async (instance) => {
    const results = await Promise.allSettled([
      instance.bumpEpoch(9, "operator"),
      instance.bumpEpoch(9, "operator"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(instance.bumpEpoch(9, "operator")).rejects.toThrow(/epoch_conflict/);
  });
  expect((await control().status()).epoch).toBe(10);
});

it("keeps history and a pending epoch after D1 failure, then reconciles after eviction", async () => {
  await history(4);
  await env.DB.prepare(
    "CREATE TRIGGER reject_control BEFORE UPDATE ON control BEGIN SELECT RAISE(ABORT,'injected'); END",
  ).run();
  try {
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.recover()).rejects.toThrow(/injected/);
    });
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_control").run();
  }
  expect(await env.BACKUPS.head(`${EPOCH_PREFIX}5.json`)).not.toBeNull();
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.status()).rejects.toThrow(/control_not_ready/);
  });
  await evictDurableObject(control());
  expect((await control().recover()).epoch).toBe(5);
});

it("does not publish before an R2 write succeeds, and preserves the pending intent", async () => {
  await history(30);
  await runInDurableObject(control(), async (instance, state) => {
    // Insert the state at the durable boundary before external I/O, as on an interrupted request.
    state.storage.sql.exec(
      "UPDATE control_state SET phase='pending',pending_epoch=31,pending_at=99,pending_reason='restore',pending_token='attempt'",
    );
    new ControlEpochHistory(state.storage.sql).reserve(
      { epoch: 31, at: 99, reason: "restore" },
      "attempt",
    );
    await env.BACKUPS.put(
      `${EPOCH_PREFIX}31.json`,
      JSON.stringify({ epoch: 31, at: 98, reason: "operator" }),
    );
    await expect(instance.recover()).rejects.toThrow(/epoch_history_conflict/);
    await expect(instance.status()).rejects.toThrow(/control_not_ready/);
  });
  expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
});

it("revokes open permits and fails only old claimed operations, preserving terminal results", async () => {
  const { ids, statements } = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, statements);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO permits VALUES(?,?,1,?,'open')",
      values: [ids.user, ids.space, Date.now() + 60000],
    },
    ...["claimed", "committed", "failed"].map((state) => ({
      sql: "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,created_at,updated_at) VALUES(?,'user',?,?,?,'node.create',?,'digest',1,?,1,1,0,'{}',1,1)",
      values: [`${ids.user}-${state}`, ids.user, ids.credential, ids.space, state, ids.user],
    })),
  ]);
  await history(1);
  await control().recover();
  const rows = (
    await env.DB.prepare(
      "SELECT state,error_code FROM operations WHERE principal_id=? ORDER BY op_id",
    )
      .bind(ids.user)
      .all()
  ).results;
  expect(rows).toEqual([
    { state: "failed", error_code: "stale_epoch" },
    { state: "committed", error_code: null },
    { state: "failed", error_code: null },
  ]);
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind(ids.user)
      .first("state"),
  ).toBe("revoked");
});

it("quiesces D1 admission, revokes open permits, and preserves terminal operations", async () => {
  await history(1);
  await control().recover();
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 2);
  await atomicBatch(env.DB, [
    ...["claimed", "committed"].map((state) => ({
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,
        request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
        VALUES(?,'user',?,?,?,'node.create',?,'digest',2,?,?,?,0,1,1)`,
      values: [
        `${f.ids.user}-${state}`,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        state,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
      ],
    })),
  ]);
  expect(await control().quiesce(2)).toEqual({
    epoch: 2,
    maintenance: true,
    gcPaused: true,
    activeJobLease: false,
  });
  expect(await control().quiesce(2)).toMatchObject({ activeJobLease: false });
  expect(await env.DB.prepare("SELECT maintenance,gc_paused FROM control").first()).toMatchObject({
    maintenance: 1,
    gc_paused: 1,
  });
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind(permit.permit_id)
      .first("state"),
  ).toBe("revoked");
  expect(
    (
      await env.DB.prepare(
        "SELECT state,error_code FROM operations WHERE principal_id=? ORDER BY op_id",
      )
        .bind(f.ids.user)
        .all()
    ).results,
  ).toEqual([
    { state: "failed", error_code: "maintenance" },
    { state: "committed", error_code: null },
  ]);
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.quiesce(1)).rejects.toThrow(/quiesce_epoch_conflict/);
  });
});

it("reports an active job lease after closing admission", async () => {
  await history(1);
  await control().recover();
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 2);
  const opId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,
        request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
        VALUES(?,'user',?,?,?,'node.create','committed','digest',2,?,?,?,0,1,1)`,
      values: [
        opId,
        f.ids.user,
        f.ids.credential,
        f.ids.space,
        permit.permit_id,
        permit.expires_at,
        permit.expires_at,
      ],
    },
    {
      sql: `INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,grant_snapshot,created_at,updated_at)
        VALUES(?,?,?,?,'node.create','running',2,'{}',1,1)`,
      values: [opId, f.ids.user, f.ids.credential, opId],
    },
    {
      sql: "INSERT INTO job_leases(job_id,claim_token,epoch,expires_at,attempt) VALUES(?,?,2,?,1)",
      values: [opId, crypto.randomUUID(), Date.now() + 60000],
    },
  ]);
  expect((await control().quiesce(2)).activeJobLease).toBe(true);
  await env.DB.prepare("UPDATE job_leases SET expires_at=0 WHERE job_id=?").bind(opId).run();
  expect((await control().quiesce(2)).activeJobLease).toBe(false);
});

it("leaves D1 unchanged and DO admission closed if quiesce fails mid-batch", async () => {
  await history(1);
  await control().recover();
  await env.DB.prepare("UPDATE control SET maintenance=0,gc_paused=0").run();
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const permit = await grantPermit(env.DB, crypto.randomUUID(), f.ids.space, 2);
  const opId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,
    space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,
    expected_steps,created_at,updated_at)
    VALUES(?,'user',?,?,?,'node.create','claimed','digest',2,?,?,?,0,1,1)`)
    .bind(
      opId,
      f.ids.user,
      f.ids.credential,
      f.ids.space,
      permit.permit_id,
      permit.expires_at,
      permit.expires_at,
    )
    .run();
  await env.DB.prepare(`CREATE TRIGGER reject_quiesce BEFORE UPDATE OF state ON operations
    WHEN OLD.state='claimed' BEGIN SELECT RAISE(ABORT,'injected_quiesce'); END`).run();
  try {
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.quiesce(2)).rejects.toThrow(/injected_quiesce/);
    });
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_quiesce").run();
  }
  expect(await control().status()).toEqual({ epoch: 2, maintenance: true, gcPaused: true });
  expect(await env.DB.prepare("SELECT maintenance,gc_paused FROM control").first()).toMatchObject({
    maintenance: 0,
    gc_paused: 0,
  });
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind(permit.permit_id)
      .first("state"),
  ).toBe("open");
  expect(
    await env.DB.prepare("SELECT state FROM operations WHERE op_id=?").bind(opId).first("state"),
  ).toBe("claimed");
});

it("rejects any non-singleton ControlDO", async () => {
  const other = env.CONTROL.get(env.CONTROL.idFromName("other"));
  await runInDurableObject(other, async (instance) => {
    await expect(instance.recover()).rejects.toThrow(/singleton/);
  });
});

it("retains an unknown native PUT across eviction even when exact readback exists", async () => {
  await history(1);
  const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
    await env.BACKUPS.put(...args);
    throw new Error("lost_response");
  });
  const get = vi.fn((key: string) => env.BACKUPS.get(key));
  const bucket = {
    list: (options: R2ListOptions) => env.BACKUPS.list(options),
    get,
    put,
  } as unknown as R2Bucket;
  await runInDurableObject(control(), async (_instance, state) => {
    const custom = new ControlDO(state, { ...env, BACKUPS: bucket });
    await expect(custom.recover()).rejects.toThrow(/lost_response/);
    await expect(custom.recover()).rejects.toThrow(/epoch_history_write_unsettled/);
    expect(state.storage.sql.exec("SELECT state FROM control_epoch_write").one()).toEqual({
      state: "pending",
    });
  });
  expect(await env.BACKUPS.head(`${EPOCH_PREFIX}2.json`)).not.toBeNull();
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.recover()).rejects.toThrow(/epoch_history_write_unsettled/);
    await expect(instance.status()).rejects.toThrow(/control_not_ready/);
  });
  expect(await env.DB.prepare("SELECT epoch FROM control").first("epoch")).toBe(1);
  expect(put).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
});

it("fails closed on list failure unless the operator explicitly supplied a floor", async () => {
  const bucket = {
    list: async () => {
      throw new Error("offline");
    },
  } as unknown as R2Bucket;
  await expect(recoverEpochFloor(bucket, 1)).rejects.toThrow(/offline/);
  expect(await recoverEpochFloor(bucket, 1, 1000)).toBe(1000);
});
