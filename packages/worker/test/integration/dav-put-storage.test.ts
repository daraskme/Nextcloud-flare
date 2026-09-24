import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { runGarbageCollection } from "../../src/jobs/gc";
import { davUploadMetadata } from "../../src/services/davUpload";
import { davBucket, davPutFixture as fixture } from "../fixtures/davPut";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { systemMutationFault } from "../fixtures/systemMutationFault";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps concurrent same-operation requests from dispatching another PUT", async () => {
  const f = await fixture(),
    started = deferred(),
    finish = deferred();
  let puts = 0;
  const bucket = davBucket({
    put: async (k, b, o) => {
      puts++;
      const object = await env.BLOBS.put(k, b, o);
      started.resolve();
      await finish.promise;
      return object;
    },
  });
  const first = f.run({ BLOBS: bucket });
  try {
    await started.promise;
    expect(await f.run({ BLOBS: bucket })).toMatchObject({ kind: "commit_unknown" });
    expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
  } finally {
    finish.resolve();
  }
  expect(await first).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(puts).toBe(1);
});

it("keeps a committed DAV object and ledger when namespace ACK and primary reconciliation are lost", async () => {
  const f = await fixture(),
    queries = new WeakMap<object, string>();
  let committed = false,
    denied = 0;
  const db = {
    prepare(sql: string) {
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(s, {
          get(t, k) {
            if (k === "bind") return (...values: unknown[]) => wrap(t.bind(...values));
            if (k === "first" && sql === "SELECT * FROM operations WHERE op_id=?")
              return (...args: unknown[]) => {
                if (committed) {
                  denied++;
                  throw new Error("primary_unreadable");
                }
                return Reflect.apply(t.first, t, args);
              };
            const v = Reflect.get(t, k, t);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
        queries.set(proxy, sql);
        return proxy;
      };
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const publication = statements.some((s) => queries.get(s)?.startsWith("INSERT INTO nodes"));
      const result = await env.DB.batch(statements);
      if (publication) {
        committed = true;
        throw new Error("namespace_ack_lost");
      }
      return result;
    },
  } as D1Database;
  let deletes = 0;
  expect(
    await f.run({
      DB: db,
      BLOBS: davBucket({
        delete: async () => {
          deletes++;
        },
      }),
    }),
  ).toMatchObject({ kind: "commit_unknown" });
  expect(committed).toBe(true);
  expect(denied).toBeGreaterThan(0);
  expect(deletes).toBe(0);
  expect(await f.row()).toMatchObject({ state: "completed" });
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await f.run()).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
});

it.each([0, 3])(
  "persists a %i-byte attempt before one conditional PUT and commits its ledger with the file",
  async (size) => {
    const f = await fixture(size);
    let puts = 0;
    const outcome = await f.run({
      BLOBS: davBucket({
        put: async (key, body, options) => {
          puts++;
          const row = (await f.row())!;
          expect(row).toMatchObject({
            state: "receiving",
            source: "dav",
            in_flight: 1,
            data_calls: 1,
            data_bytes: size,
            capability_kid: null,
          });
          expect(await f.counters()).toEqual({ reserved_bytes: size, physical_bytes: 0 });
          expect(options).toMatchObject({
            onlyIf: { etagDoesNotMatch: "*" },
            customMetadata: davUploadMetadata(row),
          });
          return env.BLOBS.put(key, body, options);
        },
      }),
    });
    expect(outcome).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    expect(await f.row()).toMatchObject({ state: "completed", in_flight: 0, accept_parts: 0 });
    expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: size });
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM operation_steps WHERE op_id=? AND kind='upload'")
        .bind(await f.op())
        .first("n"),
    ).toBe(1);
    await f.run({
      BLOBS: davBucket({
        put: async () => {
          throw new Error("reput");
        },
      }),
    });
    expect(puts).toBe(1);
  },
);

it("keeps a successful PUT with a lost response held and never repeats the key", async () => {
  const f = await fixture();
  let puts = 0,
    deletes = 0;
  const bucket = davBucket({
    put: async (key, body, options) => {
      puts++;
      await env.BLOBS.put(key, body, options);
      throw new Error("put_ack_lost");
    },
    delete: async () => {
      deletes++;
    },
  });
  await expect(f.run({ BLOBS: bucket })).rejects.toThrow("put_ack_lost");
  expect(await f.row()).toMatchObject({ state: "receiving", in_flight: 1 });
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
  expect(await f.run({ BLOBS: bucket })).toMatchObject({ kind: "commit_unknown" });
  expect({ puts, deletes }).toEqual({ puts: 1, deletes: 0 });
});

it.each([false, true])("does not dispatch on staging failure (saved=%s)", async (saved) => {
  const f = await fixture();
  let fired = false,
    puts = 0;
  const db = injectBatch(
    (sql) => sql.startsWith("INSERT INTO uploads"),
    async () => {
      fired = true;
      throw new Error("stage_ack_lost");
    },
    saved,
  );
  await expect(
    f.run({
      DB: db,
      BLOBS: davBucket({
        put: async () => {
          puts++;
          throw new Error("unexpected_put");
        },
      }),
    }),
  ).rejects.toThrow("stage_ack_lost");
  expect(fired).toBe(true);
  expect(puts).toBe(0);
  expect(await f.counters()).toEqual({ reserved_bytes: saved ? 3 : 0, physical_bytes: 0 });
  if (saved) {
    expect(await f.row()).toMatchObject({ state: "receiving" });
    expect(await f.run()).toMatchObject({ kind: "commit_unknown" });
  } else expect(await f.row()).toBeNull();
});

it.each(["ack", "rollback", "reads"] as const)(
  "handles %s recording native storage without deleting or refunding unknown bytes",
  async (mode) => {
    const f = await fixture(),
      fault = systemMutationFault("system:dav.put-stored:", mode);
    const run = f.run({ DB: fault.db });
    if (mode === "ack")
      expect(await run).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    else await expect(run).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    expect(await f.counters()).toEqual({
      reserved_bytes: mode === "ack" ? 0 : 3,
      physical_bytes: 3,
    });
    expect(await f.row()).toMatchObject({
      state: mode === "ack" ? "completed" : mode === "reads" ? "completing" : "receiving",
    });
  },
);

it("waits for the native storage result after a request stream fails", async () => {
  const f = await fixture(),
    started = deferred(),
    native = deferred(),
    readFailed = deferred();
  let source!: ReadableStreamDefaultController<Uint8Array>,
    finished = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      source = c;
    },
  });
  const running = f
    .run(
      {
        BLOBS: davBucket({
          put: async (_key, stream) => {
            started.resolve();
            try {
              await (stream as ReadableStream).pipeTo(new WritableStream());
            } catch {
              readFailed.resolve();
            }
            await native.promise;
            throw new Error("native_rejected");
          },
        }),
      },
      body,
    )
    .then(
      () => {
        finished = true;
        return null;
      },
      (error) => {
        finished = true;
        return error;
      },
    );
  await started.promise;
  source.error(new Error("request_broken"));
  await readFailed.promise;
  expect(finished).toBe(false);
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
  native.resolve();
  expect(await running).toBeInstanceOf(Error);
  expect(await f.row()).toMatchObject({ state: "receiving", in_flight: 1 });
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
});

it("turns a known failed publication into a charged orphan and replays without storage calls", async () => {
  const f = await fixture();
  let deletes = 0;
  const outcome = await f.run({
    BLOBS: davBucket({
      put: async (k, b, o) => {
        const object = await env.BLOBS.put(k, b, o);
        await f.conflict();
        return object;
      },
      delete: async () => {
        deletes++;
      },
    }),
  });
  expect(outcome).toMatchObject({
    kind: "terminal",
    operation: { state: "failed", errorCode: "name_conflict" },
  });
  const row = (await f.row())!;
  expect(row).toMatchObject({ state: "failed", cleanup_pending: 1 });
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT state FROM blobs WHERE id=?").bind(row.blob_id).first("state"),
  ).toBe("orphan");
  const replay = await f.run({
    BLOBS: davBucket({
      put: async () => {
        throw new Error("unexpected_put");
      },
      head: async () => {
        throw new Error("unexpected_head");
      },
    }),
  });
  expect(replay).toEqual(outcome);
  expect(deletes).toBe(0);
  // A proven completed write can enter GC immediately; unknown bodies must wait for expiry.
  await env.DB.prepare("UPDATE control SET gc_paused=0").run();
  expect(await runGarbageCollection(mutationEnv(), env.BLOBS, 1)).toMatchObject({ deleted: 1 });
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
  expect(await f.run()).toEqual(outcome);
});

it.each(["ack", "rollback", "reads"] as const)(
  "handles %s in failed publication settlement and keeps the original operation",
  async (mode) => {
    const f = await fixture(),
      fault = systemMutationFault("system:dav.put-failed:", mode);
    const run = f.run({
      DB: fault.db,
      BLOBS: davBucket({
        put: async (k, b, o) => {
          const object = await env.BLOBS.put(k, b, o);
          await f.conflict();
          return object;
        },
      }),
    });
    if (mode === "rollback") await expect(run).rejects.toThrow();
    else expect(await run).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
    expect(fault.fired()).toBe(true);
    expect(await f.counters()).toEqual({
      reserved_bytes: mode === "rollback" ? 3 : 0,
      physical_bytes: 3,
    });
    expect(await f.run()).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
    expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  },
);

it("does not delete an existing object when claiming the operation fails", async () => {
  const f = await fixture();
  let deleted = false,
    put = false,
    fired = false;
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO operations"),
    async () => {
      fired = true;
      throw new Error("claim_failed");
    },
    false,
  );
  await expect(
    f.run({
      DB: db,
      BLOBS: davBucket({
        delete: async () => {
          deleted = true;
        },
        put: async () => {
          put = true;
          throw new Error("unexpected_put");
        },
      }),
    }),
  ).rejects.toThrow();
  expect(fired).toBe(true);
  expect({ deleted, put }).toEqual({ deleted: false, put: false });
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 0 });
});

it("records a finished native PUT after its namespace permit is revoked and hands the failed publication to GC", async () => {
  const f = await fixture();
  const outcome = await f.run({
    BLOBS: davBucket({
      put: async (k, b, o) => {
        const object = await env.BLOBS.put(k, b, o),
          op = await f.op();
        await env.DB.prepare(
          "UPDATE permits SET state='revoked' WHERE permit_id=(SELECT permit_id FROM operations WHERE op_id=?)",
        )
          .bind(op)
          .run();
        return object;
      },
    }),
  });
  expect(outcome).toMatchObject({
    kind: "terminal",
    operation: { state: "failed", errorCode: "operation_failed" },
  });
  expect(
    await env.DB.prepare("SELECT error_code FROM operations WHERE op_id=?")
      .bind(await f.op())
      .first("error_code"),
  ).toBe("mutation_admission_closed");
  expect(await f.counters()).toEqual({ reserved_bytes: 0, physical_bytes: 3 });
  expect(await f.row()).toMatchObject({ state: "failed", cleanup_pending: 1, in_flight: 0 });
  expect(
    await env.DB.prepare("SELECT state FROM gc_candidates WHERE blob_id=?")
      .bind((await f.row())!.blob_id)
      .first("state"),
  ).toBe("candidate");
});
