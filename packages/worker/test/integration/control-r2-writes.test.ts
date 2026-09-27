import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { type R2WriteGrant, type R2WriteRequest } from "../../src/db/r2Write";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { ControlR2Writes } from "../../src/do/controlR2Writes";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { trackedR2Write } from "../../src/services/r2Write";
import { acquireGlobalMutation, acquireMutation } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const owner = crypto.randomUUID(),
  space = crypto.randomUUID(),
  root = crypto.randomUUID();
let epoch: number;
const keys = new Set<string>();
const request = (): R2WriteRequest => ({
  id: crypto.randomUUID(),
  epoch,
  ownerId: owner,
  kind: "manifest.put",
  key: `target-sets/${crypto.randomUUID()}`,
  deadline: Date.now() + 5000,
});
const row = (id: string) =>
  env.DB.prepare("SELECT * FROM r2_write_attempts WHERE id=?")
    .bind(id)
    .first<Record<string, unknown>>();
const local = (state: DurableObjectState) =>
  state.storage.sql.exec("SELECT * FROM control_r2_write_receipts").toArray();
async function audit() {
  const error = await runInDurableObject(control(), async (instance) => {
    try {
      await instance.beginRecoveryAudit(epoch);
      for (let i = 0; i < 20; i++)
        if ((await instance.nextRecoveryAuditPage(epoch, 20)).completed) return null;
      return "audit_fixture_incomplete";
    } catch (error) {
      return String(error);
    }
  });
  if (error) throw Error(error);
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES(?,'https://access.invalid',?,'fixture@example.invalid','app_admin',10000000,1)",
      values: [owner, owner],
    },
    {
      sql: "INSERT INTO spaces(id,owner_id,root_node_id) VALUES(?,?,?)",
      values: [space, owner, root],
    },
    {
      sql: "INSERT INTO nodes(id,space_id,owner_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,'','','root',1,1)",
      values: [root, space, owner],
    },
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [owner],
    },
  ]);
});
beforeEach(async () => {
  // All native test actions have ended. Reset only fixture holds; production has no such bypass.
  await env.DB.prepare(
    "UPDATE r2_write_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE state='pending'",
  ).run();
  await runInDurableObject(control(), async (_instance, state) => state.storage.deleteAll());
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  await audit();
  await control().resumeAdmission(epoch);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (keys.size) await env.BLOBS.delete([...keys]);
  keys.clear();
});
function fixtureWrites(state: DurableObjectState, db = env.DB, current = () => {}) {
  return new ControlR2Writes(
    state.storage,
    db,
    current,
    (r) => acquireMutation(r),
    () =>
      acquireGlobalMutation({
        epoch,
        permitId: `global:r2.write-settle:${crypto.randomUUID()}`,
        deadline: Date.now() + 5000,
      }),
    (epoch, deadline) =>
      acquireGlobalMutation({
        epoch,
        deadline,
        permitId: `global:r2.manifest-delete:${crypto.randomUUID()}`,
      }),
  );
}

function configured(methods: {
  beginR2Write?: (r: R2WriteRequest) => Promise<R2WriteGrant>;
  finishR2Write?: (g: R2WriteGrant, outcome: "succeeded" | "not_started") => Promise<void>;
}) {
  const stub = control();
  return {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        beginR2Write: (r: R2WriteRequest) => stub.beginR2Write(r),
        finishR2Write: (g: R2WriteGrant, outcome: "succeeded" | "not_started") =>
          stub.finishR2Write(g, outcome),
        ...methods,
      }),
    } as unknown as typeof env.CONTROL,
  };
}

it("does not dispatch from a lost grant RPC reply", async () => {
  let issued: R2WriteGrant | undefined;
  const action = vi.fn(async () => undefined);
  await expect(
    trackedR2Write(
      configured({
        beginR2Write: async (r) => {
          issued = await control().beginR2Write(r);
          throw Error("rpc_reply_lost");
        },
      }),
      request(),
      action,
    ),
  ).rejects.toThrow(/mutation_unavailable/);
  expect(action).not.toHaveBeenCalled();
  expect(await row(issued!.id)).toMatchObject({ state: "pending" });
});

it("allows exact unpublished manifest cleanup after quiesce and tracks the DELETE", async () => {
  const r = request();
  keys.add(r.key);
  await trackedR2Write(env, r, () => env.BLOBS.put(r.key, "manifest"));
  await control().quiesce(epoch);
  await trackedR2Write(env, { ...r, kind: "manifest.delete" }, () => env.BLOBS.delete(r.key));
  expect(await env.BLOBS.head(r.key)).toBeNull();
  expect(
    (
      await env.DB.prepare(
        "SELECT state FROM r2_write_attempts WHERE r2_key=? AND kind='manifest.delete'",
      )
        .bind(r.key)
        .first()
    )?.state,
  ).toBe("succeeded");
  expect(await control().status()).toMatchObject({ maintenance: true, gcPaused: true });
});

it("does not issue a cleanup grant without proof of its own successful staging", async () => {
  const r = { ...request(), kind: "manifest.delete" as const };
  await control().quiesce(epoch);
  await runInDurableObject(control(), async (instance, state) => {
    await expect(instance.beginR2Write(r)).rejects.toThrow();
    expect(local(state)).toHaveLength(0);
  });
  expect(await row(r.id)).toMatchObject({ state: "not_started" });
});

it("settles an expired returned grant as never dispatched", async () => {
  let issued: R2WriteGrant | undefined;
  const action = vi.fn(async () => undefined);
  await expect(
    trackedR2Write(
      configured({
        beginR2Write: async (r) => {
          issued = await control().beginR2Write(r);
          vi.spyOn(Date, "now").mockReturnValue(issued.deadline + 1);
          return issued;
        },
      }),
      request(),
      action,
    ),
  ).rejects.toThrow(/mutation_unavailable/);
  expect(action).not.toHaveBeenCalled();
  expect(await row(issued!.id)).toMatchObject({ state: "not_started" });
});

it.each(["grant", "native"])(
  "retains a timeout during %s and reconciles only its late continuation",
  async (phase) => {
    let release!: () => void, entered!: () => void, finished!: () => void;
    const wait = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r)),
      ended = new Promise<void>((r) => (finished = r));
    let issued: R2WriteGrant | undefined;
    let calls = 0;
    const app = configured({
      beginR2Write: async (r) => {
        issued = await control().beginR2Write(r);
        if (phase === "grant") {
          entered();
          await wait;
        }
        return issued;
      },
      finishR2Write: async (g, outcome) => {
        await control().finishR2Write(g, outcome);
        finished();
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = expect(
        trackedR2Write(app, request(), async () => {
          calls++;
          entered();
          await wait;
          return "done";
        }),
      ).rejects.toThrow(/mutation_unavailable/);
      await started;
      await vi.advanceTimersByTimeAsync(25000);
      await outcome;
      expect(await row(issued!.id)).toMatchObject({ state: "pending" });
      release();
      await ended;
      expect(calls).toBe(phase === "native" ? 1 : 0);
      expect(await row(issued!.id)).toMatchObject({
        state: phase === "native" ? "succeeded" : "not_started",
      });
    } finally {
      release();
      vi.useRealTimers();
    }
  },
);

it("bounds all outstanding grants to 32 and returns capacity only after settlement", async () => {
  const grants: R2WriteGrant[] = [];
  for (let i = 0; i < 32; i++) grants.push(await control().beginR2Write(request()));
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.beginR2Write(request())).rejects.toThrow(/capacity/);
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM r2_write_attempts WHERE state='pending'").first(
      "n",
    ),
  ).toBe(32);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='active'",
    ).first("n"),
  ).toBe(0);
  await control().finishR2Write(grants[0]!, "not_started");
  expect(await control().beginR2Write(request())).toMatchObject({ epoch, ownerId: owner });
});

it.each(["closed", "bad-key", "bad-owner", "bad-epoch", "expired"])(
  "rejects %s before reserving or dispatching",
  async (kind) => {
    const r = request();
    if (kind === "closed") await control().quiesce(epoch);
    if (kind === "bad-key") r.key = "sys/epoch/1.json";
    if (kind === "bad-owner") r.ownerId = "../other";
    if (kind === "bad-epoch") r.epoch = 0;
    if (kind === "expired") r.deadline = Date.now() - 1;
    await runInDurableObject(control(), async (instance, state) => {
      await expect(instance.beginR2Write(r)).rejects.toThrow();
      expect(local(state)).toHaveLength(0);
    });
    expect(await row(r.id)).toBeNull();
  },
);

it("persists a grant before dispatch, settles success, and refuses replay across eviction", async () => {
  const r = request(),
    g = await control().beginR2Write(r);
  expect(await row(r.id)).toMatchObject({ state: "pending", token: g.token });
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance, state) => {
    expect(local(state)).toHaveLength(1);
    await expect(instance.beginR2Write(r)).rejects.toThrow();
  });
  await control().finishR2Write(g, "succeeded");
  await control().finishR2Write(g, "succeeded");
  await evictDurableObject(control());
  await runInDurableObject(control(), async (instance, state) => {
    expect(local(state)).toHaveLength(0);
    await expect(instance.beginR2Write({ ...r, deadline: Date.now() + 5000 })).rejects.toThrow();
    expect(local(state)).toHaveLength(0);
  });
  expect(await row(r.id)).toMatchObject({ state: "succeeded" });
});
it("holds the actual native PUT through quiesce and only settles after its success", async () => {
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const r = request();
  keys.add(r.key);
  const writing = trackedR2Write(env, r, async () => {
    entered();
    await wait;
    return env.BLOBS.put(r.key, "manifest");
  });
  await started;
  await control().quiesce(epoch);
  await runInDurableObject(control(), async (instance, state) => {
    expect(local(state)).toHaveLength(1);
    await expect(instance.nextRecoveryAuditPage(epoch)).rejects.toThrow(/r2_write_unsettled/);
    await expect(instance.resumeAdmission(epoch)).rejects.toThrow();
  });
  release();
  await writing;
  // This test staged an unpublished fixture manifest. Remove it before the separate full audit.
  await env.BLOBS.delete(r.key);
  keys.delete(r.key);
  await audit();
  await control().resumeAdmission(epoch);
  expect(await control().status()).toMatchObject({ maintenance: false });
});
it("keeps a rejected native write unknown even when its object can be read", async () => {
  const r = request();
  keys.add(r.key);
  await expect(
    trackedR2Write(env, r, async () => {
      await env.BLOBS.put(r.key, "manifest");
      throw Error("ack_lost");
    }),
  ).rejects.toThrow(/mutation_unavailable/);
  expect(await env.BLOBS.head(r.key)).not.toBeNull();
  await control().quiesce(epoch);
  await evictDurableObject(control());
  expect(await control().repairR2WriteSettlements(epoch)).toMatchObject({
    checked: 0,
    unknown: 1,
    databasePending: 1,
  });
  const id = crypto.randomUUID();
  await control().prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
  await runInDurableObject(control(), async (instance) => {
    await expect(
      instance.freezeDatabaseRestore(epoch, id, {
        target: { mode: "remote", accountId: "a".repeat(32), databaseId: crypto.randomUUID() },
        blobs: { accountId: "a".repeat(32), bucket: "test-blobs", jurisdiction: "default" },
        backups: { accountId: "a".repeat(32), bucket: "test-backups", jurisdiction: "default" },
      }),
    ).rejects.toThrow(/r2_write_unsettled/);
  });
});
it("keeps the D1 hold after all ControlDO storage is lost", async () => {
  await control().beginR2Write(request());
  await runInDurableObject(control(), async (_instance, state) => state.storage.deleteAll());
  await evictDurableObject(control());
  epoch = (await control().recover()).epoch;
  expect(await env.DB.prepare(RECOVERY_FINAL_QUERY).bind(epoch).first()).toBeNull();
  await expect(env.DB.prepare("UPDATE control SET maintenance=0").run()).rejects.toThrow(
    /r2_write_unsettled/,
  );
});
it.each(["before", "after"])("does not return a grant on %s-dispatch D1 ACK loss", async (when) => {
  const r = request();
  await runInDurableObject(control(), async (_instance, state) => {
    const db = injectBatch(
      (sql) => sql.startsWith("INSERT INTO r2_write_attempts"),
      async () => {
        throw Error("lost");
      },
      when === "after",
    );
    const writes = fixtureWrites(state, db);
    await expect(writes.begin(r)).rejects.toThrow("lost");
    expect(local(state)).toHaveLength(0);
  });
  expect(await row(r.id)).toMatchObject({ state: "not_started" });
});
it("records local native success when its D1 settlement fails, then repairs after eviction", async () => {
  const g = await control().beginR2Write(request());
  await runInDurableObject(control(), async (_instance, state) => {
    const db = injectBatch(
      (sql) => sql.startsWith("UPDATE r2_write_attempts"),
      async () => {
        throw Error("unavailable");
      },
      false,
    );
    await expect(fixtureWrites(state, db).finish(g, "succeeded")).rejects.toThrow(/unsettled/);
    expect(local(state)).toMatchObject([{ state: "succeeded" }]);
  });
  await control().quiesce(epoch);
  await evictDurableObject(control());
  expect(await control().repairR2WriteSettlements(epoch)).toMatchObject({
    reconciled: 1,
    localPending: 0,
    databasePending: 0,
  });
  expect(await row(g.id)).toMatchObject({ state: "succeeded" });
});
it("recovers a lost settlement ACK from the exact terminal receipt", async () => {
  const g = await control().beginR2Write(request());
  await runInDurableObject(control(), async (_instance, state) => {
    const db = injectBatch(
      (sql) => sql.startsWith("UPDATE r2_write_attempts"),
      async () => {
        throw Error("ack_lost");
      },
      true,
    );
    await fixtureWrites(state, db).finish(g, "succeeded");
    expect(local(state)).toHaveLength(0);
  });
});
it("repairs retained local proof after D1 receipt retention has elapsed", async () => {
  const startedAt = Date.now() - 86410000;
  const grant: R2WriteGrant = {
    ...request(),
    startedAt,
    deadline: startedAt + 5000,
    token: crypto.randomUUID(),
  };
  await env.DB.prepare("INSERT INTO r2_write_attempts VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(
      grant.id,
      grant.token,
      epoch,
      owner,
      grant.kind,
      grant.key,
      grant.deadline,
      startedAt,
      "succeeded",
      startedAt,
    )
    .run();
  await runInDurableObject(control(), async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'succeeded')",
      grant.id,
      grant.token,
      JSON.stringify(grant),
    );
  });
  await control().quiesce(epoch);
  expect(await control().repairR2WriteSettlements(epoch)).toMatchObject({
    reconciled: 1,
    localPending: 0,
    databasePending: 0,
  });
  expect(await row(grant.id)).toMatchObject({ state: "succeeded" });
});
it.each(["token", "key", "ownerId", "epoch"] as const)(
  "refuses a changed settlement %s",
  async (field) => {
    const g = await control().beginR2Write(request());
    const changed = {
      ...g,
      [field]:
        field === "epoch"
          ? epoch + 1
          : field === "key"
            ? `target-sets/${crypto.randomUUID()}`
            : crypto.randomUUID(),
    };
    await runInDurableObject(control(), async (instance) => {
      await expect(instance.finishR2Write(changed, "succeeded")).rejects.toThrow();
    });
    expect(await row(g.id)).toMatchObject({ state: "pending" });
    await control().finishR2Write(g, "not_started");
  },
);
it.each(["proof", "used", "remove"])(
  "rolls back local %s failure without releasing evidence",
  async (kind) => {
    const g = await control().beginR2Write(request());
    await runInDurableObject(control(), async (instance, state) => {
      const operation = kind === "proof" ? "UPDATE" : kind === "used" ? "INSERT" : "DELETE";
      const table = kind === "used" ? "control_r2_write_used" : "control_r2_write_receipts";
      state.storage.sql.exec(
        `CREATE TRIGGER fail_receipt BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
      );
      await expect(instance.finishR2Write(g, "succeeded")).rejects.toThrow();
      expect(local(state)).toHaveLength(1);
      state.storage.sql.exec("DROP TRIGGER fail_receipt");
      await instance.finishR2Write(g, "succeeded");
      expect(local(state)).toHaveLength(0);
    });
  },
);
it("never turns an opposite terminal outcome into a new proof", async () => {
  const g = await control().beginR2Write(request());
  await control().finishR2Write(g, "not_started");
  await runInDurableObject(control(), async (instance) => {
    await expect(instance.finishR2Write(g, "succeeded")).rejects.toThrow();
  });
  expect(await row(g.id)).toMatchObject({ state: "not_started" });
});
