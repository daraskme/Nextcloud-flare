import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { inspectRecoveryFinalFence } from "../../src/do/recoveryAudit";
import type { Env } from "../../src/env";
import { handleDeadLetterBatch } from "../../src/jobs/deadLetter";
import { dispatchTreeJob, treeJobRow } from "../../src/jobs/treeJobStore";
import {
  failTreeJob,
  processTreeJob,
  reconcileStoppedTreeJobs,
} from "../../src/jobs/treeJobWorker";
import { purgeTrash } from "../../src/services/purgeTrash";
import { restoreTrash } from "../../src/services/restoreTrash";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM job_leases").run();
  await env.DB.prepare(
    `UPDATE bulk_jobs SET state='failed',checkpoint='{"phase":"failed","cursor":null}',
    dispatch_state='failed',dispatch_token=NULL,dispatch_expires_at=NULL WHERE state IN ('pending','running')`,
  ).run();
});

async function audit(
  control: DurableObjectStub<import("../../src/do/ControlDO").ControlDO>,
  epoch: number,
) {
  let done = false;
  for (let n = 0; n < 30 && !done; n++)
    done = (await control.nextRecoveryAuditPage(epoch, 20)).completed;
  expect(done).toBe(true);
}

async function dispatchedJob() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const epoch = (await control.recover()).epoch;
  await atomicBatch(
    env.DB,
    f.statements.map((statement) =>
      statement.sql.startsWith("INSERT INTO sessions")
        ? {
            sql: statement.sql.replace("?,1,?,?,?)", "?,?,?,?,?)"),
            values: [...statement.values!.slice(0, 3), epoch, ...statement.values!.slice(3)],
          }
        : statement,
    ),
  );
  const object = (await env.BLOBS.put(`u/${f.ids.user}/b/${f.ids.blob}`, "abc"))!;
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
  )
    .bind(f.ids.blob, object.etag)
    .run();
  await env.DB.prepare(
    "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
  )
    .bind(f.ids.user)
    .run();
  await control.beginRecoveryAudit(epoch);
  await control.failStaleOutbox(epoch);
  await audit(control, epoch);
  await control.resumeAdmission(epoch);
  const root = `large_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)",
  )
    .bind(root, f.ids.space, f.ids.user, f.ids.root, root, root)
    .run();
  await env.DB.prepare(`WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<999)
    INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    SELECT ?||n,?,?,?,?||n,?||n,'folder',1,1 FROM seq`)
    .bind(root + "_", f.ids.space, f.ids.user, root, root + "_", root + "_")
    .run();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch,
  };
  const result = await trashNode(env as Env, {
    principal,
    requestId: crypto.randomUUID(),
    nodeId: root,
    spaceId: f.ids.space,
    lockTokens: [],
  });
  if (result.kind !== "terminal") throw new Error("missing_async_job");
  const id = (await env.DB.prepare("SELECT id FROM bulk_jobs WHERE op_id=?")
    .bind(result.operation.id)
    .first<string>("id"))!;
  expect(await dispatchTreeJob(env, { async send() {} }, id, epoch)).toBe("sent");
  return { id, epoch, control, root, f, principal };
}

function crashDb(): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          if (sql.startsWith("WITH RECURSIVE d(id,depth,path)"))
            throw new Error("simulated_worker_crash_after_claim");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function expire(id: string) {
  await env.DB.prepare(
    "UPDATE job_leases SET expires_at=strftime('%s','now')*1000-1 WHERE job_id=?",
  )
    .bind(id)
    .run();
}

async function finish(id: string, epoch: number) {
  for (let n = 0; n < 10; n++) {
    await dispatchTreeJob(env, { async send() {} }, id, epoch);
    const result = await processTreeJob(env, id);
    if (result === "completed") return;
    expect(result).toBe("progressed");
  }
  throw new Error("job_did_not_finish");
}

it.each([false, true])(
  "repairs crash-after-claim safely after maintenance and expiry (new epoch: %s)",
  async (bump) => {
    const { id, epoch, control, root } = await dispatchedJob();
    await expect(processTreeJob({ DB: crashDb(), systemControl: control }, id)).rejects.toThrow(
      "simulated_worker_crash_after_claim",
    );
    const lease = await env.DB.prepare("SELECT * FROM job_leases WHERE job_id=?").bind(id).first();
    expect((await control.quiesce(epoch)).activeJobLease).toBe(true);
    const recoveryEpoch = bump ? (await control.bumpEpoch(epoch, "operator")).epoch : epoch;
    await runInDurableObject(control, async (instance) => {
      await expect(instance.reconcileTreeJobs(recoveryEpoch)).rejects.toThrow(
        "recovery_job_lease_active",
      );
    });
    expect(
      await env.DB.prepare("SELECT * FROM job_leases WHERE job_id=?").bind(id).first(),
    ).toEqual(lease);
    await expire(id);
    await expect(inspectRecoveryFinalFence(env.DB, recoveryEpoch)).rejects.toThrow(
      "recovery_final_fence",
    );
    expect(await control.reconcileTreeJobs(recoveryEpoch)).toMatchObject({
      reconciled: 1,
      audit: { completed: false },
    });
    expect(await treeJobRow(env.DB, id)).toMatchObject({
      state: "failed",
      operation_state: "failed",
      error_code: "maintenance",
      dispatch_state: "failed",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM job_leases").first("n")).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM trash_ops WHERE op_id=(SELECT op_id FROM bulk_jobs WHERE id=?)",
      )
        .bind(id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE (id=? OR parent_id=?) AND deleted_at IS NULL",
      )
        .bind(root, root)
        .first("n"),
    ).toBe(1001);
    await runInDurableObject(control, async (instance) => {
      await expect(instance.resumeAdmission(recoveryEpoch)).rejects.toThrow(
        "recovery_audit_incomplete",
      );
    });
    await audit(control, recoveryEpoch);
    expect(await control.resumeAdmission(recoveryEpoch)).toMatchObject({
      maintenance: false,
      gcPaused: true,
    });
    expect(await processTreeJob(env, id)).toBe("failed");
  },
);

it("reconciles an unclaimed tree job stopped by a released backup barrier", async () => {
  const { id, epoch, control, root } = await dispatchedJob();
  const backupId = crypto.randomUUID();
  expect((await control.beginBackup(epoch, backupId)).state).toBe("frozen");
  try {
    expect(await treeJobRow(env.DB, id)).toMatchObject({
      state: "pending",
      operation_state: "failed",
    });
    expect(
      await env.DB.prepare(
        "SELECT error_code FROM operations WHERE op_id=(SELECT op_id FROM bulk_jobs WHERE id=?)",
      )
        .bind(id)
        .first("error_code"),
    ).toBe("backup");
  } finally {
    await control.cancelBackup(epoch, backupId);
  }
  await control.quiesce(epoch);
  await expect(inspectRecoveryFinalFence(env.DB, epoch)).rejects.toThrow("recovery_final_fence");
  expect((await control.reconcileTreeJobs(epoch)).reconciled).toBe(1);
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "failed",
    error_code: "backup",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE (id=? OR parent_id=?) AND deleted_at IS NULL",
    )
      .bind(root, root)
      .first("n"),
  ).toBe(1001);
  await audit(control, epoch);
  expect((await control.resumeAdmission(epoch)).maintenance).toBe(false);
});

it("reconciles partial trash manifests without a lease and leaves the tree unchanged", async () => {
  const { id, epoch, control, root } = await dispatchedJob();
  expect(await processTreeJob(env, id)).toBe("progressed");
  const row = (await treeJobRow(env.DB, id))!;
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_members WHERE trash_op_id=?")
      .bind(row.op_id)
      .first("n"),
  ).toBe(250);
  await control.quiesce(epoch);
  await expect(inspectRecoveryFinalFence(env.DB, epoch)).rejects.toThrow("recovery_final_fence");
  expect((await control.reconcileTreeJobs(epoch)).reconciled).toBe(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_members WHERE trash_op_id=?")
      .bind(row.op_id)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE (id=? OR parent_id=?) AND deleted_at IS NULL",
    )
      .bind(root, root)
      .first("n"),
  ).toBe(1001);
  await audit(control, epoch);
  await control.resumeAdmission(epoch);
});

it.each(["node.restore", "node.purge"] as const)(
  "reconciles partial %s setup without changing the committed trash",
  async (kind) => {
    const { id, epoch, control, f, principal } = await dispatchedJob();
    await finish(id, epoch);
    const trash = (await treeJobRow(env.DB, id))!;
    const request = {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      trashOpId: trash.op_id,
    };
    const result =
      kind === "node.restore"
        ? await restoreTrash(env as Env, {
            ...request,
            destinationParentId: f.ids.root,
            lockTokens: [],
          })
        : await purgeTrash(env as Env, request);
    if (result.kind !== "terminal" || !result.operation.job) throw new Error("missing_job");
    const jobId = result.operation.job.id;
    await dispatchTreeJob(env, { async send() {} }, jobId, epoch);
    expect(await processTreeJob(env, jobId)).toBe("progressed");
    const before = await env.DB.prepare(
      "SELECT id,revision,deleted_op_id,current_blob_id FROM nodes ORDER BY id",
    ).all();
    const job = (await treeJobRow(env.DB, jobId))!;
    if (kind === "node.purge")
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM purge_members WHERE purge_op_id=?")
          .bind(job.op_id)
          .first("n"),
      ).toBe(250);
    await control.bumpEpoch(epoch, "operator");
    expect((await control.reconcileTreeJobs(epoch + 1)).reconciled).toBe(1);
    expect(await treeJobRow(env.DB, jobId)).toMatchObject({
      state: "failed",
      operation_state: "failed",
      error_code: "stale_epoch",
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT id,revision,deleted_op_id,current_blob_id FROM nodes ORDER BY id",
        ).all()
      ).results,
    ).toEqual(before.results);
    expect(
      await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
        .bind(trash.op_id)
        .first("state"),
    ).toBe("trashed");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_members WHERE trash_op_id=?")
        .bind(trash.op_id)
        .first("n"),
    ).toBe(1001);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM purge_members WHERE purge_op_id=?")
        .bind(job.op_id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM purge_blobs WHERE purge_op_id=?")
        .bind(job.op_id)
        .first("n"),
    ).toBe(0);
    await control.failStaleOutbox(epoch + 1);
    await audit(control, epoch + 1);
    await control.resumeAdmission(epoch + 1);
  },
);

it("refuses mismatched operation provenance without deleting any setup", async () => {
  const { id, epoch, control, f } = await dispatchedJob();
  await control.quiesce(epoch);
  const row = (await treeJobRow(env.DB, id))!;
  await env.DB.prepare("UPDATE operation_steps SET affected_id=? WHERE op_id=?")
    .bind(f.ids.root, row.op_id)
    .run();
  await runInDurableObject(control, async (instance) => {
    await expect(instance.reconcileTreeJobs(epoch)).rejects.toThrow();
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow("recovery_audit_incomplete");
  });
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "pending",
    operation_state: "failed",
  });
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
      .bind(row.op_id)
      .first("state"),
  ).toBe("pending");
});

it("atomically refuses a replacement lease installed after the repair snapshot", async () => {
  const { id, epoch, control } = await dispatchedJob();
  await expect(processTreeJob({ DB: crashDb(), systemControl: control }, id)).rejects.toThrow();
  await control.quiesce(epoch);
  await expire(id);
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await target
              .prepare(
                "UPDATE job_leases SET claim_token='replacement',expires_at=strftime('%s','now')*1000+60000 WHERE job_id=?",
              )
              .bind(id)
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    reconcileStoppedTreeJobs({ DB: db, systemControl: control }, epoch),
  ).rejects.toThrow();
  expect(raced).toBe(true);
  expect(
    await env.DB.prepare("SELECT claim_token FROM job_leases WHERE job_id=?")
      .bind(id)
      .first("claim_token"),
  ).toBe("replacement");
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "running",
    operation_state: "failed",
  });
  expect(
    await env.DB.prepare(
      "SELECT state FROM trash_ops WHERE op_id=(SELECT op_id FROM bulk_jobs WHERE id=?)",
    )
      .bind(id)
      .first("state"),
  ).toBe("pending");
});

it.each(["epoch", "gc", "bootstrap", "admission"] as const)(
  "atomically refuses a %s change after acquiring the repair admission",
  async (change) => {
    const { id, epoch, control, f } = await dispatchedJob();
    await control.quiesce(epoch);
    let raced = false;
    let recoveryEpoch = epoch;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              if (change === "epoch")
                recoveryEpoch = (await control.bumpEpoch(epoch, "operator")).epoch;
              else if (change === "gc")
                await target.prepare("UPDATE control SET gc_paused=0").run();
              else if (change === "bootstrap")
                await target.prepare("UPDATE control SET bootstrap_sub='missing'").run();
              else
                await control.acquireSystemMutation({
                  epoch,
                  spaceId: f.ids.space,
                  permitId: "system:tree-job.fail:" + crypto.randomUUID(),
                  deadline: Date.now() + 5000,
                });
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      reconcileStoppedTreeJobs({ DB: db, systemControl: control }, epoch),
    ).rejects.toThrow();
    expect(raced).toBe(true);
    expect(await treeJobRow(env.DB, id)).toMatchObject({
      state: "pending",
      operation_state: "failed",
    });
    expect(
      await env.DB.prepare(
        "SELECT state FROM trash_ops WHERE op_id=(SELECT op_id FROM bulk_jobs WHERE id=?)",
      )
        .bind(id)
        .first("state"),
    ).toBe("pending");
    if (change === "bootstrap")
      await env.DB.prepare("UPDATE control SET bootstrap_sub=?").bind(f.ids.user).run();
    await control.quiesce(recoveryEpoch);
  },
);

it("refuses an expired lease with mismatched source epoch", async () => {
  const { id, epoch, control } = await dispatchedJob();
  await expect(processTreeJob({ DB: crashDb(), systemControl: control }, id)).rejects.toThrow();
  await control.quiesce(epoch);
  await env.DB.prepare("UPDATE job_leases SET epoch=epoch+1,expires_at=0 WHERE job_id=?")
    .bind(id)
    .run();
  const lease = await env.DB.prepare("SELECT * FROM job_leases WHERE job_id=?").bind(id).first();
  await runInDurableObject(control, async (instance) => {
    await expect(instance.reconcileTreeJobs(epoch)).rejects.toThrow();
  });
  expect(await env.DB.prepare("SELECT * FROM job_leases WHERE job_id=?").bind(id).first()).toEqual(
    lease,
  );
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "running",
    operation_state: "failed",
  });
});

it("recovers the repair commit receipt after a lost batch response and is idempotent", async () => {
  const { id, epoch, control } = await dispatchedJob();
  await control.quiesce(epoch);
  let lost = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (!lost) {
            lost = true;
            throw new Error("lost_repair_ack");
          }
          return result;
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await reconcileStoppedTreeJobs({ DB: db, systemControl: control }, epoch)).toBe(1);
  expect(lost).toBe(true);
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "failed",
    operation_state: "failed",
  });
  expect((await control.reconcileTreeJobs(epoch)).reconciled).toBe(0);
  await audit(control, epoch);
  await control.resumeAdmission(epoch);
});

it("refuses stopped repair in open mode or while the D1 backup freeze is present", async () => {
  const { id, epoch, control } = await dispatchedJob();
  await expect(
    reconcileStoppedTreeJobs({ DB: env.DB, systemControl: control }, epoch),
  ).rejects.toThrow();
  await control.quiesce(epoch);
  const backupId = crypto.randomUUID();
  await control.beginBackup(epoch, backupId);
  try {
    expect(await env.DB.prepare("SELECT backup_frozen FROM control").first("backup_frozen")).toBe(
      1,
    );
    await runInDurableObject(control, async (instance) => {
      await expect(
        reconcileStoppedTreeJobs({ DB: env.DB, systemControl: instance }, epoch),
      ).rejects.toThrow();
    });
    expect(await treeJobRow(env.DB, id)).toMatchObject({ state: "pending" });
  } finally {
    await control.releaseBackup(epoch, backupId);
  }
});

it("retries stale DLQ while an actual replacement worker owns its claim and lets it finish", async () => {
  const { id, epoch, control } = await dispatchedJob();
  let reached!: () => void;
  let unblock!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (prop === "all")
          return async () => {
            reached();
            await gate;
            return target.all();
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) =>
          sql.startsWith("WITH RECURSIVE d(id,depth,path)")
            ? wrap(target.prepare(sql))
            : target.prepare(sql);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const work = processTreeJob({ DB: db, systemControl: control }, id);
  await paused;
  const lease = await env.DB.prepare("SELECT * FROM job_leases WHERE job_id=?").bind(id).first();
  expect(lease).not.toBeNull();
  let acked = 0,
    retried = 0;
  try {
    expect(
      await handleDeadLetterBatch(env, {
        messages: [
          {
            id: "old_exhausted_delivery",
            attempts: 6,
            body: { treeJobId: id },
            ack() {
              acked++;
            },
            retry() {
              retried++;
            },
          },
        ],
      }),
    ).toEqual({ acked: 0, retried: 1 });
    expect(await treeJobRow(env.DB, id)).toMatchObject({
      state: "running",
      operation_state: "claimed",
      error_code: null,
    });
    expect(
      await env.DB.prepare("SELECT * FROM job_leases WHERE job_id=?").bind(id).first(),
    ).toEqual(lease);
    expect([acked, retried]).toEqual([0, 1]);
  } finally {
    unblock();
  }
  expect(await work).toBe("progressed");
  await finish(id, epoch);
});

it("terminates an expired tree lease on DLQ", async () => {
  const { id, control } = await dispatchedJob();
  await expect(processTreeJob({ DB: crashDb(), systemControl: control }, id)).rejects.toThrow();
  await expire(id);
  expect(
    await handleDeadLetterBatch(env, {
      messages: [
        {
          id: "expired_delivery",
          attempts: 6,
          body: { treeJobId: id },
          ack() {},
          retry() {},
        },
      ],
    }),
  ).toEqual({ acked: 1, retried: 0 });
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "failed",
    operation_state: "failed",
    error_code: "queue_exhausted",
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM job_leases WHERE job_id=?").bind(id).first("n"),
  ).toBe(0);
});

it("rechecks DLQ lease absence atomically when a worker claims after the snapshot", async () => {
  const { id, epoch, control } = await dispatchedJob();
  const row = (await treeJobRow(env.DB, id))!;
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await target
              .prepare(
                "INSERT INTO job_leases(job_id,claim_token,epoch,expires_at,attempt) VALUES(?,'replacement',?,strftime('%s','now')*1000+60000,1)",
              )
              .bind(id, epoch)
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await failTreeJob({ DB: db, systemControl: control }, row, "queue_exhausted")).toBe(
    "retry",
  );
  expect(raced).toBe(true);
  expect(
    await env.DB.prepare("SELECT claim_token FROM job_leases WHERE job_id=?")
      .bind(id)
      .first("claim_token"),
  ).toBe("replacement");
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "pending",
    operation_state: "claimed",
  });
});

it("preserves worker-owned authorization error cleanup despite its live lease", async () => {
  const { id, f } = await dispatchedJob();
  await env.DB.prepare("UPDATE sessions SET revoked_at=strftime('%s','now')*1000 WHERE id=?")
    .bind(f.ids.session)
    .run();
  expect(await processTreeJob(env, id)).toBe("failed");
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "failed",
    operation_state: "failed",
    error_code: "mutation_rejected",
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM job_leases WHERE job_id=?").bind(id).first("n"),
  ).toBe(0);
});

it("cannot clean up a replacement lease with a superseded worker-owned claim", async () => {
  const { id, f, control } = await dispatchedJob();
  await env.DB.prepare("UPDATE sessions SET revoked_at=strftime('%s','now')*1000 WHERE id=?")
    .bind(f.ids.session)
    .run();
  let batches = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2)
            await target
              .prepare(
                "UPDATE job_leases SET claim_token='replacement',expires_at=strftime('%s','now')*1000+60000 WHERE job_id=?",
              )
              .bind(id)
              .run();
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await processTreeJob({ DB: db, systemControl: control }, id)).toBe("retry");
  expect(batches).toBe(2);
  expect(
    await env.DB.prepare("SELECT claim_token FROM job_leases WHERE job_id=?")
      .bind(id)
      .first("claim_token"),
  ).toBe("replacement");
  expect(await treeJobRow(env.DB, id)).toMatchObject({
    state: "running",
    operation_state: "claimed",
    error_code: null,
  });
});
