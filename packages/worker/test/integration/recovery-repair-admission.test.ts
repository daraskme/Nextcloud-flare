import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import {
  rebuildRecoverySearchFts,
  releaseStaleRecoveryReservations,
} from "../../src/do/recoveryAudit";
import { davUploadHistory } from "../fixtures/davUploadHistory";
import { foundationFixture } from "../fixtures/foundation";
import { acquireGlobalMutation, mutationEnv } from "../fixtures/mutationAdmission";
import {
  recoveryRepairFixture,
  repairKinds,
  resetRecoveryRepairs,
} from "../fixtures/recoveryRepair";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

const admin = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await atomicBatch(env.DB, admin.statements);
});
beforeEach(() => resetRecoveryRepairs(admin));
afterEach(() => vi.restoreAllMocks());
it("keeps untracked legacy DAV storage held while releasing an ordinary old-epoch reservation", async () => {
  const f = await davUploadHistory({ operationState: "failed" });
  await env.DB.prepare("DELETE FROM uploads WHERE id=?").bind(f.id).run();
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,2,'reserved',1,1)",
  )
    .bind("plain-" + f.id, f.ids.user)
    .run();
  expect(await releaseStaleRecoveryReservations(mutationEnv(), 2)).toBe(1);
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
  expect(
    await env.DB.prepare("SELECT state FROM reservations WHERE id=?")
      .bind(f.reservation)
      .first("state"),
  ).toBe("reserved");
});
it("rechecks an operation added to a reservation while generic recovery waits", async () => {
  const dav = await davUploadHistory({ operationState: "failed" });
  await env.DB.prepare("DELETE FROM uploads WHERE id=?").bind(dav.id).run();
  const f = await recoveryRepairFixture("reservation-release", admin);
  await expect(
    f.run(
      f.configure(async () => {
        await env.DB.prepare("UPDATE reservations SET op_id=? WHERE id=?")
          .bind(dav.operationId, f.id)
          .run();
      }),
    ),
  ).rejects.toThrow();
  expect(await f.read()).toBe("reserved");
  expect(await f.receipt()).toMatchObject({ committed_at: null });
});
it("rebuilds an empty restored database with an explicit ownerless scope", async () => {
  const db = env.TEST_BOOTSTRAP_RACE;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  await rebuildRecoverySearchFts(mutationEnv(db, db), 1);
  expect(
    await db
      .prepare("SELECT space_id,system,maintenance,state,committed_at FROM mutation_admissions")
      .first(),
  ).toEqual({
    space_id: null,
    system: 1,
    maintenance: 1,
    state: "closed",
    committed_at: expect.any(Number),
  });
  expect(await db.prepare("SELECT COUNT(*) n FROM users").first("n")).toBe(0);
});
it("does not invent a space for a reservation owner restored without one", async () => {
  const owner = crypto.randomUUID(),
    id = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES(?,'https://access.invalid',?,'missing@invalid','member',100,1)",
      values: [owner, owner],
    },
    {
      sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,3,'reserved',1,1)",
      values: [id, owner],
    },
  ]);
  await expect(releaseStaleRecoveryReservations(mutationEnv(), 2)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(owner)
      .first("reserved_bytes"),
  ).toBe(3);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM mutation_admissions WHERE state<>'closed'").first(
      "n",
    ),
  ).toBe(0);
});
it.each(repairKinds)("requires shared admission for %s", async (kind) => {
  const f = await recoveryRepairFixture(kind, admin);
  await expect(f.run(f.configure(undefined, env.DB, true))).rejects.toThrow();
  expect(f.permits).toHaveLength(1);
  expect(await f.receipt()).toBeNull();
  expect(await f.read()).toBe(f.initial);
});
it.each(repairKinds)("commits %s under only its own active receipt", async (kind) => {
  const f = await recoveryRepairFixture(kind, admin);
  expect(await f.run()).toBe(kind === "fts-rebuild" ? undefined : 1);
  expect(await f.read()).toBe(f.terminal);
  expect(await f.receipt()).toEqual({
    state: "closed",
    committed_at: expect.any(Number),
    space_id: kind === "fts-rebuild" ? null : f.ids.space,
    system: 1,
    maintenance: 1,
  });
  if (kind === "reservation-release")
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first("reserved_bytes"),
    ).toBe(0);
});
const faultCases = repairKinds.flatMap((kind) =>
  (["ack", "rollback", "reads"] as const).map((mode) => ({ kind, mode })),
);
it.each(faultCases)(
  "handles $mode for $kind without returning unknown capacity",
  async ({ kind, mode }) => {
    const f = await recoveryRepairFixture(kind, admin),
      fault = systemMutationFault(f.prefix, mode);
    const run = f.run(f.configure(undefined, fault.db));
    if (mode === "rollback") await expect(run).rejects.toThrow();
    else expect(await run).toBe(kind === "fts-rebuild" ? undefined : 1);
    expect(fault.fired()).toBe(true);
    expect(fault.reads()).toBe(1);
    expect(await f.read()).toBe(mode === "rollback" ? f.initial : f.terminal);
    expect(await f.receipt()).toMatchObject({
      state: mode === "rollback" ? "active" : "closed",
      committed_at: mode === "rollback" ? null : expect.any(Number),
    });
  },
);
it.each(repairKinds)(
  "rejects %s if neither its receipt nor terminal proof is readable",
  async (kind) => {
    const f = await recoveryRepairFixture(kind, admin),
      fault = systemMutationFault(f.prefix, "reads");
    let denied = false;
    const db = new Proxy(fault.db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            const matches =
              kind === "fts-rebuild"
                ? sql.includes("'integrity-check'")
                : sql.startsWith(
                    "SELECT 1 FROM " + (kind === "outbox-fail" ? "outbox" : "reservations"),
                  ) && sql.includes("state='");
            if (!matches) return statement;
            const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(s, {
                get(t, k) {
                  if (k === "bind") return (...v: unknown[]) => wrap(t.bind(...v));
                  if (k === "run" || k === "first")
                    return () => {
                      denied = true;
                      throw new Error("proof_unavailable");
                    };
                  const value = Reflect.get(t, k, t);
                  return typeof value === "function" ? value.bind(t) : value;
                },
              });
            return wrap(statement);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(f.run(f.configure(undefined, db))).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    expect(denied).toBe(true);
    expect(await f.read()).toBe(f.terminal);
  },
);
it.each(repairKinds)("checks the fixed deadline after %s admission", async (kind) => {
  const f = await recoveryRepairFixture(kind, admin),
    now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await expect(
    f.run(
      f.configure(async () => {
        clock.mockReturnValue(now + 25001);
      }),
    ),
  ).rejects.toThrow("recovery_repair_budget");
  expect(await f.read()).toBe(f.initial);
  expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
});
const otherCases = repairKinds.flatMap((kind) =>
  (["waiting", "active"] as const).map((state) => ({ kind, state })),
);
it.each(otherCases)("rejects $kind while another receipt is $state", async ({ kind, state }) => {
  const f = await recoveryRepairFixture(kind, admin);
  let changed = false;
  await expect(
    f.run(
      f.configure(async () => {
        const id = crypto.randomUUID(),
          permitId = "global:r2.probe-phase:" + id;
        if (state === "active")
          await acquireGlobalMutation({ permitId, epoch: 2, deadline: Date.now() + 5000 });
        else
          await env.DB.prepare(
            "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,NULL,2,1,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
          )
            .bind(id, permitId)
            .run();
        changed = true;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.read()).toBe(f.initial);
  expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
});
const stateCases = repairKinds.flatMap((kind) =>
  (
    [
      "epoch",
      "mode",
      "pause",
      "bootstrap-subject",
      "partial-bootstrap",
      "disabled-bootstrap",
    ] as const
  ).map((change) => ({ kind, change })),
);
it.each(stateCases)("rechecks $change after $kind waits", async ({ kind, change }) => {
  const f = await recoveryRepairFixture(kind, admin);
  let changed = false;
  await expect(
    f.run(
      f.configure(async () => {
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=3").run();
        if (change === "mode") await env.DB.prepare("UPDATE control SET maintenance=0").run();
        if (change === "pause") await env.DB.prepare("UPDATE control SET gc_paused=0").run();
        if (change === "bootstrap-subject")
          await env.DB.prepare("UPDATE control SET bootstrap_sub='changed'").run();
        if (change === "partial-bootstrap")
          await env.DB.prepare(
            "UPDATE control SET bootstrap_done_at=NULL,bootstrap_iss=NULL,bootstrap_sub=NULL",
          ).run();
        if (change === "disabled-bootstrap")
          await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
            .bind(admin.ids.user)
            .run();
        changed = true;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.read()).toBe(f.initial);
});
it.each(["reservation-release", "outbox-fail"] as const)(
  "repairs disabled owners through their actual space for %s",
  async (kind) => {
    const f = await recoveryRepairFixture(kind, admin);
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
    expect(await f.run()).toBe(1);
    expect(await f.receipt()).toMatchObject({
      space_id: f.ids.space,
      committed_at: expect.any(Number),
    });
    const count = f.permits.length;
    expect(await f.run()).toBe(0);
    expect(f.permits).toHaveLength(count);
  },
);
it.each(["reservation-release", "outbox-fail"] as const)(
  "stops the %s pass before another grant after its budget expires",
  async (kind) => {
    const f = await recoveryRepairFixture(kind, admin);
    await recoveryRepairFixture(kind, admin);
    const now = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const db = injectBatch(
      (sql) =>
        sql.includes(
          kind === "outbox-fail"
            ? "UPDATE outbox SET state='failed'"
            : "UPDATE reservations SET state='released'",
        ),
      async () => {
        clock.mockReturnValue(now + 25001);
      },
      true,
    );
    expect(await f.run(f.configure(undefined, db))).toBe(1);
    expect(f.permits).toHaveLength(1);
    expect(
      await env.DB.prepare(
        kind === "outbox-fail"
          ? "SELECT COUNT(*) n FROM outbox WHERE state='pending'"
          : "SELECT COUNT(*) n FROM reservations WHERE state='reserved'",
      ).first("n"),
    ).toBe(1);
  },
);

it("retains a reservation attached to an upload while waiting", async () => {
  const f = await recoveryRepairFixture("reservation-release", admin),
    blob = crypto.randomUUID();
  let changed = false;
  await expect(
    f.run(
      f.configure(async () => {
        await atomicBatch(env.DB, [
          {
            sql: "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,3,'etag','staging',1)",
            values: [blob, f.ids.user, `u/${f.ids.user}/b/${blob}`],
          },
          {
            sql: `INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,capability_hash,epoch,created_at,expires_at,last_progress_at)
        VALUES(?,?,?,?,?,?,?,'single','created',3,'cap',1,1,2,1)`,
            values: [
              crypto.randomUUID(),
              f.ids.user,
              f.ids.space,
              f.ids.root,
              blob,
              f.ids.credential,
              f.id,
            ],
          },
        ]);
        changed = true;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.read()).toBe("reserved");
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(3);
  expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
});
it("does not release a replacement reservation with the same ID", async () => {
  const f = await recoveryRepairFixture("reservation-release", admin);
  let changed = false;
  await expect(
    f.run(
      f.configure(async () => {
        await atomicBatch(env.DB, [
          { sql: "UPDATE reservations SET state='released' WHERE id=?", values: [f.id] },
          { sql: "DELETE FROM reservations WHERE id=?", values: [f.id] },
          {
            sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES(?,?,7,'reserved',1,1)",
            values: [f.id, f.ids.user],
          },
        ]);
        changed = true;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.read()).toBe("reserved");
  expect(
    await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
      .bind(f.ids.user)
      .first("reserved_bytes"),
  ).toBe(7);
});
it.each(["identity", "provenance", "claim"] as const)(
  "rechecks notification %s after admission",
  async (change) => {
    const f = await recoveryRepairFixture("outbox-fail", admin);
    let changed = false;
    await expect(
      f.run(
        f.configure(async () => {
          if (change === "identity")
            await atomicBatch(env.DB, [
              { sql: "DELETE FROM outbox WHERE outbox_id=?", values: [f.id] },
              {
                sql: "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',1,1,1)",
                values: [f.id, f.opId, f.ids.root],
              },
            ]);
          if (change === "provenance")
            await env.DB.prepare("DELETE FROM operation_steps WHERE op_id=?").bind(f.opId).run();
          if (change === "claim")
            await env.DB.prepare(
              "UPDATE outbox SET state='sent',dispatch_token='dispatch',dispatch_expires_at=1,claim_token='claim',claim_expires_at=strftime('%s','now')*1000+60000 WHERE outbox_id=?",
            )
              .bind(f.id)
              .run();
          changed = true;
        }),
      ),
    ).rejects.toThrow();
    expect(changed).toBe(true);
    expect(await f.read()).toBe(change === "claim" ? "sent" : "pending");
    expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
  },
);
it.each(repairKinds)(
  "does not use another %s completion to close its rolled-back receipt",
  async (kind) => {
    const f = await recoveryRepairFixture(kind, admin),
      fault = systemMutationFault(f.prefix, "rollback");
    let changed = false;
    await expect(
      f.run(
        f.configure(async () => {
          if (kind === "fts-rebuild")
            await env.DB.prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')").run();
          else
            await env.DB.prepare(
              kind === "outbox-fail"
                ? "UPDATE outbox SET state='failed' WHERE outbox_id=?"
                : "UPDATE reservations SET state='released' WHERE id=?",
            )
              .bind(f.id)
              .run();
          changed = true;
        }, fault.db),
      ),
    ).rejects.toThrow();
    expect(changed).toBe(true);
    expect(fault.fired()).toBe(true);
    expect(await f.read()).toBe(f.terminal);
    expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
  },
);
