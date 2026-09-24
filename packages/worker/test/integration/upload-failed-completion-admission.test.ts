import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { settleFailedCompletion } from "../../src/services/uploads/failedCompletion";
import {
  completionModes,
  failedCompletionFixture as fixture,
  failedCompletionPrefix as prefix,
} from "../fixtures/failedCompletion";
import { systemMutationFault } from "../fixtures/systemMutationFault";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const initial = {
  state: "completing",
  cleanup_pending: 0,
  blob_state: "staging",
  reservation_state: "reserved",
  reserved_bytes: 3,
  physical_bytes: 3,
};
const terminal = {
  state: "failed",
  cleanup_pending: 1,
  blob_state: "orphan",
  reservation_state: "released",
  reserved_bytes: 0,
  physical_bytes: 3,
};

it.each(completionModes)(
  "requires admission before refunding failed %s publication",
  async (mode) => {
    const f = await fixture(mode);
    await expect(f.run(f.configure(undefined, env.DB, true))).rejects.toThrow(
      "mutation_unavailable",
    );
    expect(await f.snapshot()).toEqual(initial);
    expect(await f.receipt()).toBeNull();
  },
);
it.each(completionModes)(
  "settles %s under the actual owner's space and keeps physical bytes charged",
  async (mode) => {
    const f = await fixture(mode);
    await f.run();
    expect(await f.snapshot()).toEqual(terminal);
    expect(await f.receipt()).toEqual({
      state: "closed",
      committed_at: expect.any(Number),
      space_id: f.ids.space,
      system: 1,
      maintenance: 0,
    });
    expect(f.ids.space).not.toBe(f.actor.ids.space);
    await f.run(f.configure(undefined, env.DB, true));
    expect(f.permits).toHaveLength(1);
    expect(await f.snapshot()).toEqual(terminal);
  },
);
const faults = completionModes.flatMap((mode) =>
  (["ack", "rollback", "reads"] as const).map((fault) => ({ mode, fault })),
);
it.each(faults)(
  "handles $fault for $mode without refunding unknown storage",
  async ({ mode, fault: kind }) => {
    const f = await fixture(mode),
      fault = systemMutationFault(prefix, kind);
    const pending = f.run(f.configure(undefined, fault.db));
    if (kind === "rollback") await expect(pending).rejects.toThrow();
    else await pending;
    expect(fault.fired()).toBe(true);
    expect(fault.reads()).toBe(1);
    expect(await f.snapshot()).toEqual(kind === "rollback" ? initial : terminal);
    expect(await f.receipt()).toMatchObject({
      state: kind === "rollback" ? "active" : "closed",
      committed_at: kind === "rollback" ? null : expect.any(Number),
    });
  },
);
const boundaries = completionModes.flatMap((mode) =>
  (
    [
      "epoch",
      "mode",
      "revoked-admission",
      "blob-etag",
      "physical-removal",
      "live-transfer",
      "referenced-blob",
      "operation-step",
    ] as const
  ).map((change) => ({ mode, change })),
);
it.each(boundaries)("rechecks $change after $mode waits", async ({ mode, change }) => {
  const f = await fixture(mode);
  let changed = false;
  await expect(
    f.run(
      f.configure(async (grant) => {
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "mode") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (change === "revoked-admission")
          await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
            .bind(grant.id)
            .run();
        if (change === "blob-etag")
          await env.DB.prepare("UPDATE blobs SET r2_etag='different' WHERE id=?")
            .bind(f.blob)
            .run();
        if (change === "physical-removal")
          await atomicBatch(env.DB, [
            { sql: "UPDATE blobs SET state='deleted' WHERE id=?", values: [f.blob] },
            { sql: "UPDATE blob_storage SET removed_at=1 WHERE blob_id=?", values: [f.blob] },
          ]);
        if (change === "live-transfer")
          await env.DB.prepare("UPDATE uploads SET in_flight=1 WHERE id=?").bind(f.id).run();
        if (change === "referenced-blob")
          await env.DB.prepare(
            "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) VALUES(?,?,?,?,'published','published','file',?,1,1)",
          )
            .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.folder, f.blob)
            .run();
        if (change === "operation-step")
          await env.DB.prepare(
            "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
          )
            .bind(f.op, f.ids.file)
            .run();
        changed = true;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.snapshot()).toMatchObject({
    state: "completing",
    reservation_state: "reserved",
    reserved_bytes: 3,
  });
  expect(await f.receipt()).toMatchObject({ committed_at: null });
});
it.each(completionModes)(
  "records %s compensation after owner disable without impersonating its actor",
  async (mode) => {
    const f = await fixture(mode);
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
    await f.run();
    expect(await f.snapshot()).toEqual(terminal);
    expect(await f.receipt()).toMatchObject({
      space_id: f.ids.space,
      committed_at: expect.any(Number),
    });
  },
);
it.each(completionModes)("keeps %s replay read-only after GC finishes", async (mode) => {
  const f = await fixture(mode);
  await f.run();
  await atomicBatch(env.DB, [
    { sql: "UPDATE blobs SET state='deleted' WHERE id=?", values: [f.blob] },
    { sql: "UPDATE blob_storage SET removed_at=1 WHERE blob_id=?", values: [f.blob] },
    { sql: "UPDATE uploads SET cleanup_pending=0 WHERE id=?", values: [f.id] },
  ]);
  await f.run(f.configure(undefined, env.DB, true));
  expect(f.permits).toHaveLength(1);
  expect(await f.snapshot()).toEqual({
    ...terminal,
    blob_state: "deleted",
    cleanup_pending: 0,
    physical_bytes: 0,
  });
});
it.each(completionModes)(
  "does not use another %s settlement to close its rolled-back receipt",
  async (mode) => {
    const f = await fixture(mode),
      fault = systemMutationFault(prefix, "rollback");
    await f.run(
      f.configure(async () => {
        await atomicBatch(env.DB, [
          { sql: "UPDATE uploads SET state='failed',cleanup_pending=1 WHERE id=?", values: [f.id] },
          { sql: "UPDATE blobs SET state='orphan' WHERE id=?", values: [f.blob] },
          { sql: "UPDATE reservations SET state='released' WHERE id=?", values: [f.reservation] },
        ]);
      }, fault.db),
    );
    expect(fault.fired()).toBe(true);
    expect(await f.snapshot()).toEqual(terminal);
    expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
  },
);
it.each(completionModes)(
  "requires the original %s upload identity even for an already released result",
  async (mode) => {
    const f = await fixture(mode);
    await f.run();
    await expect(
      settleFailedCompletion(f.configure(), { ...f.row, owner_id: f.actor.ids.user }, f.op),
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(terminal);
  },
);
it("retains a single upload whose verified hash is absent", async () => {
  const f = await fixture("single");
  await env.DB.prepare("UPDATE blobs SET sha256_verified=NULL WHERE id=?").bind(f.blob).run();
  await expect(f.run()).rejects.toThrow();
  expect(await f.snapshot()).toEqual(initial);
});
it("requires the independently observed multipart object proof", async () => {
  const f = await fixture("multipart", 1, { objectProof: false });
  await expect(f.run()).rejects.toThrow();
  expect(await f.snapshot()).toEqual(initial);
});

it.each(
  completionModes.flatMap((mode) =>
    (["claimed", "committed"] as const).map((state) => ({ mode, state })),
  ),
)("never compensates $mode when publication is $state", async ({ mode, state }) => {
  const f = await fixture(mode, 1, { state });
  await expect(f.run()).rejects.toThrow();
  expect(await f.snapshot()).toEqual(initial);
  expect(await f.receipt()).toMatchObject({ committed_at: null });
});
it.each(completionModes)("does not release %s capacity without a physical charge", async (mode) => {
  const f = await fixture(mode, 1, { storage: false });
  await expect(f.run()).rejects.toThrow();
  expect(await f.snapshot()).toEqual({ ...initial, physical_bytes: 0 });
});
it.each(completionModes)(
  "rolls back all %s changes when reservation counters have drifted",
  async (mode) => {
    const f = await fixture(mode);
    await env.DB.prepare("UPDATE users SET reserved_bytes=0 WHERE id=?").bind(f.ids.user).run();
    await expect(f.run()).rejects.toThrow();
    expect(await f.snapshot()).toEqual({ ...initial, reserved_bytes: 0 });
    expect(await f.receipt()).toMatchObject({ state: "active", committed_at: null });
  },
);
it.each(completionModes)(
  "does not report %s settlement when both completion proofs are unreadable",
  async (mode) => {
    const f = await fixture(mode);
    let denied = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(s, {
                get(t, k) {
                  if (k === "bind") return (...values: unknown[]) => wrap(t.bind(...values));
                  if (k === "first" && sql.startsWith("SELECT 1 FROM uploads"))
                    return (...args: unknown[]) => {
                      if (fault.fired()) {
                        denied = true;
                        throw new Error("terminal_unreadable");
                      }
                      return Reflect.apply(t.first, t, args);
                    };
                  const v = Reflect.get(t, k, t);
                  return typeof v === "function" ? v.bind(t) : v;
                },
              });
            return wrap(target.prepare(sql));
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const fault = systemMutationFault(prefix, "reads", 1, db);
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow("terminal_unreadable");
    expect(fault.fired()).toBe(true);
    expect(denied).toBe(true);
    expect(await f.snapshot()).toEqual(terminal);
  },
);
