import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import type { Env } from "../../src/env";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { cleanupTransferObjects, transferFixture } from "../fixtures/uploadTransfer";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(cleanupTransferObjects);
const facts = ["upload.observe", "upload.multipart-observe", "upload.multipart-record"] as const;
const kinds = [
  ...facts,
  "upload.multipart-head",
  "upload.multipart-stop",
  "upload.multipart-abort",
] as const;
type ObservedKind = (typeof kinds)[number];
const writes: Record<ObservedKind, string> = {
  "upload.observe": "INSERT INTO blob_storage",
  "upload.multipart-observe": "INSERT INTO blob_storage",
  "upload.multipart-record": "SET r2_upload_id=?",
  "upload.multipart-head": "SET control_calls=control_calls+1",
  "upload.multipart-stop": "SET state='failed',accept_parts=0",
  "upload.multipart-abort": "SET cleanup_pending=1,cleanup_calls=cleanup_calls+1",
};
function faultDatabase(kind: ObservedKind, mode: "ack" | "all_reads" | "rollback") {
  const queries = new WeakMap<object, string>();
  let attempted = false,
    reads = 0;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, field) {
            if (field === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (field === "first")
              return async (...args: unknown[]) => {
                if (sql.includes("committed_at IS NOT NULL")) {
                  reads++;
                  if (mode === "all_reads") throw new Error("receipt_read_lost");
                }
                if (attempted && mode === "all_reads" && sql.startsWith("SELECT * FROM uploads"))
                  throw new Error("upload_read_lost");
                return Reflect.apply(target.first, target, args);
              };
            const value = Reflect.get(target, field);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        queries.set(proxy, sql);
        return proxy;
      };
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const matches = statements.some((s) => (queries.get(s) ?? "").includes(writes[kind]));
      if (matches) attempted = true;
      const result = await env.DB.batch(
        matches && mode === "rollback"
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (matches && mode !== "rollback") throw new Error("system_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  return { db, reads: () => reads };
}
async function fixture(kind: ObservedKind) {
  const f = await transferFixture(
    kind === "upload.observe"
      ? "single-start"
      : kind === "upload.multipart-head" || kind === "upload.multipart-observe"
        ? "multipart-complete"
        : "multipart-start",
  );
  let aborts = 0;
  const configure = (
    db = env.DB,
    gate = (request: MutationRequest) => acquireSystemMutation(request),
  ) => {
    const app = f.configure(undefined, db, async (request) => {
      if (
        kind === "upload.multipart-abort" &&
        request.permitId.startsWith("system:upload.multipart-record:")
      )
        throw new Error("record_unavailable");
      return gate(request);
    });
    const stub = app.CONTROL.get(app.CONTROL.idFromName("fixture"));
    app.CONTROL = {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        ...stub,
        status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      }),
    } as unknown as Env["CONTROL"];
    const bucket = app.BLOBS;
    app.BLOBS = new Proxy(bucket, {
      get(target, field) {
        if (field === "createMultipartUpload")
          return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
            if (kind === "upload.multipart-stop") throw new Error("r2_init_failed");
            const multipart = await target.createMultipartUpload(...args);
            return new Proxy(multipart, {
              get(handle, key) {
                if (key === "abort")
                  return async () => {
                    aborts++;
                    return handle.abort();
                  };
                const value = Reflect.get(handle, key);
                return typeof value === "function" ? value.bind(handle) : value;
              },
            });
          };
        const value = Reflect.get(target, field);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return app;
  };
  const run = (app = configure()) =>
    f.run(app).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const receipt = () =>
    env.DB.prepare(
      "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? ORDER BY seq",
    )
      .bind(f.f.ids.space, "system:" + kind + ":%")
      .all()
      .then((r) => r.results);
  const row = () =>
    env.DB.prepare("SELECT state,r2_upload_id,cleanup_calls,control_calls FROM uploads WHERE id=?")
      .bind(f.created.id)
      .first();
  return { ...f, configure, run, receipt, row, aborts: () => aborts };
}
it.each(kinds)("records %s and its exact receipt together", async (kind) => {
  const f = await fixture(kind);
  const outcome = await f.run();
  expect("error" in outcome).toBe(
    kind === "upload.multipart-stop" || kind === "upload.multipart-abort",
  );
  expect(await f.receipt()).toEqual([
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
  ]);
  if (kind === "upload.multipart-abort") expect(f.aborts()).toBe(1);
});
it.each(kinds)(
  "overload at %s keeps the reservation and does not bypass admission",
  async (kind) => {
    const f = await fixture(kind);
    const result = await f.run(
      f.configure(env.DB, async (r) => {
        if (r.permitId.startsWith("system:" + kind + ":")) throw new Error("capacity_full");
        return acquireSystemMutation(r);
      }),
    );
    expect(result).toHaveProperty("error");
    expect(await f.receipt()).toEqual([]);
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    if (kind === "upload.multipart-head") expect(f.calls.head).toBe(0);
    if (kind === "upload.multipart-abort") expect(f.aborts()).toBe(0);
    if (kind === "upload.multipart-record")
      expect(await f.row()).toMatchObject({ r2_upload_id: null });
  },
);
it.each(facts)("exact DB receipt recovers a lost ACK for %s", async (kind) => {
  const f = await fixture(kind),
    fault = faultDatabase(kind, "ack");
  const result = await f.run(f.configure(fault.db));
  if ("error" in result) throw result.error;
  expect(fault.reads()).toBe(1);
  expect(await f.receipt()).toEqual([
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
  ]);
  expect(f.calls.put + f.calls.create + f.calls.complete).toBe(1);
});
it.each(facts)("rollback at %s retains unknown capacity without a commit proof", async (kind) => {
  const f = await fixture(kind),
    fault = faultDatabase(kind, "rollback");
  expect(await f.run(f.configure(fault.db))).toHaveProperty("error");
  expect(await f.receipt()).toEqual([
    { state: "active", committed_at: null, system: 1, maintenance: 0 },
  ]);
  expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
});
it.each(facts)("lost ACK and readback at %s retain durable bytes and reservation", async (kind) => {
  const f = await fixture(kind),
    fault = faultDatabase(kind, "all_reads");
  expect(await f.run(f.configure(fault.db))).toHaveProperty("error");
  expect(await f.receipt()).toEqual([
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
  ]);
  expect(await f.counters()).toMatchObject({
    reserved_bytes: 3,
    physical_bytes: kind === "upload.multipart-record" ? 0 : 3,
  });
  expect(f.calls.put + f.calls.create + f.calls.complete).toBe(1);
});
it.each(["upload.observe", "upload.multipart-head", "upload.multipart-record"] as const)(
  "post-dispatch stop, disable and revocation preserve physical facts at %s",
  async (kind) => {
    const f = await fixture(kind);
    const result = await f.run(
      f.configure(env.DB, async (r) => {
        if (r.permitId.startsWith("system:" + kind + ":")) {
          await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
            .bind(Date.now(), f.f.ids.session)
            .run();
          await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
            .bind(Date.now(), f.f.ids.user)
            .run();
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        }
        return acquireSystemMutation(r);
      }),
    );
    expect(result).toHaveProperty("error");
    expect(await f.receipt()).toEqual([
      { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 1 },
    ]);
    expect(await f.counters()).toMatchObject({
      reserved_bytes: 3,
      physical_bytes: kind === "upload.multipart-record" ? 0 : 3,
    });
    if (kind === "upload.multipart-record")
      expect((await f.row())!.r2_upload_id).toEqual(expect.any(String));
  },
);
it.each(["upload.multipart-head", "upload.multipart-abort"] as const)(
  "lost direct claim ACK at %s never authorizes external dispatch",
  async (kind) => {
    const f = await fixture(kind),
      fault = faultDatabase(kind, "ack");
    expect(await f.run(f.configure(fault.db))).toHaveProperty("error");
    expect(fault.reads()).toBe(0);
    expect(await f.receipt()).toEqual([
      { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
    ]);
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    if (kind === "upload.multipart-abort") expect(f.aborts()).toBe(0);
    else {
      expect(f.calls.head).toBe(0);
      expect(f.calls.complete).toBe(1);
      const retried = await f.run();
      if ("error" in retried) throw retried.error;
      // Observation HEAD plus the independent publication proof HEAD.
      expect(f.calls.head).toBe(2);
      expect(f.calls.complete).toBe(1);
    }
  },
);
it("a stop receipt recovers ACK loss without refund or a second create", async () => {
  const f = await fixture("upload.multipart-stop"),
    fault = faultDatabase("upload.multipart-stop", "ack");
  expect(await f.run(f.configure(fault.db))).toHaveProperty("error");
  expect(fault.reads()).toBe(1);
  expect(await f.row()).toMatchObject({ state: "failed", r2_upload_id: null });
  expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
  expect(await f.receipt()).toEqual([
    { state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 },
  ]);
});
it.each(facts)(
  "rejects a foreign-space grant at %s without using or releasing it",
  async (kind) => {
    const f = await fixture(kind);
    expect(
      await f.run(
        f.configure(env.DB, async (request) => {
          const admission = await acquireSystemMutation(request);
          return request.permitId.startsWith("system:" + kind + ":")
            ? { ...admission, space_id: "foreign-space" }
            : admission;
        }),
      ),
    ).toHaveProperty("error");
    expect(await f.receipt()).toEqual([
      { state: "active", committed_at: null, system: 1, maintenance: 0 },
    ]);
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
  },
);
it.each([0, 1])(
  "keeps a delayed known R2 ID after epoch rotation with maintenance=%s",
  async (maintenance) => {
    const f = await fixture("upload.multipart-record"),
      app = f.configure();
    const bucket = app.BLOBS;
    app.BLOBS = new Proxy(bucket, {
      get(target, field) {
        if (field === "createMultipartUpload")
          return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
            const result = await target.createMultipartUpload(...args);
            await env.DB.prepare("UPDATE control SET epoch=2,maintenance=?")
              .bind(maintenance)
              .run();
            return result;
          };
        const value = Reflect.get(target, field);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await f.run(app)).toHaveProperty("error");
    expect((await f.row())!.r2_upload_id).toEqual(expect.any(String));
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect(await f.receipt()).toEqual([
      { state: "closed", committed_at: expect.any(Number), system: 1, maintenance },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT epoch FROM mutation_admissions WHERE space_id=? AND permit_id LIKE 'system:upload.multipart-record:%'",
      )
        .bind(f.f.ids.space)
        .first("epoch"),
    ).toBe(2);
  },
);
