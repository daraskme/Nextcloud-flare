import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { handleUploadHttp } from "../../src/api/uploads";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { acquireMutation } from "../fixtures/mutationAdmission";
import {
  settlementActions as actions,
  cleanupTransferObjects,
  transferFixture as fixture,
  type SettlementAction,
} from "../fixtures/uploadTransfer";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(cleanupTransferObjects);
const targets = (r: MutationRequest, action: SettlementAction) =>
  r.permitId.startsWith("upload." + action + ":");
const finalState = (action: SettlementAction) =>
  action === "single-abort" ? "aborted" : action === "multipart-abort" ? "aborting" : "completed";
const writes = (sql: string, action: SettlementAction) =>
  sql.includes(
    {
      "single-abort": "SET state='aborted',accept_parts=0",
      "multipart-abort": "SET state='aborting',accept_parts=0",
      "multipart-verify": "SET multipart_object_etag=?",
    }[action],
  );
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture) {
  return env.DB.prepare(
    "SELECT u.state,u.multipart_object_etag,u.write_attempt_id,b.state AS blob_state,b.r2_etag,b.sha256_verified,r.state AS reservation_state FROM uploads u JOIN blobs b ON b.id=u.blob_id JOIN reservations r ON r.id=u.reservation_id WHERE u.id=?",
  )
    .bind(f.created.id)
    .first();
}
async function unchanged(f: Fixture) {
  expect(await snapshot(f)).toMatchObject({
    state: f.action === "multipart-verify" ? "completing" : "created",
    blob_state: "staging",
    reservation_state: "reserved",
    multipart_object_etag: null,
    sha256_verified: null,
  });
  expect(await f.counters()).toMatchObject({
    reserved_bytes: 3,
    physical_bytes: f.action === "multipart-verify" ? 3 : 0,
  });
  expect(f.calls.put + f.calls.create).toBe(0);
  expect(f.calls.complete).toBe(f.action === "multipart-verify" ? 1 : 0);
}
function faultDatabase(
  action: SettlementAction,
  options: {
    lostAck?: boolean;
    rollback?: boolean;
    loseReceipt?: boolean;
    loseUpload?: boolean;
    before?: () => Promise<void>;
  },
) {
  const queries = new WeakMap<object, string>();
  let batches = 0,
    reads = 0,
    attempted = false;
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
                  if (options.loseReceipt) throw new Error("receipt_read_lost");
                }
                if (attempted && options.loseUpload && sql.startsWith("SELECT * FROM uploads"))
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
      const matches = statements.some((s) => writes(queries.get(s) ?? "", action));
      if (matches) {
        batches++;
        attempted = true;
        if (options.before) await options.before();
      }
      const result = await env.DB.batch(
        matches && options.rollback
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (matches && options.lostAck) throw new Error("lost_settlement_ack");
      return result;
    },
  } as unknown as D1Database;
  return { db, reads: () => reads, batches: () => batches };
}

it.each(actions)(
  "commits %s and its exact receipt together, releasing the shared slot",
  async (action) => {
    const f = await fixture(action);
    await f.run();
    expect(await snapshot(f)).toMatchObject({ state: finalState(action), sha256_verified: null });
    expect(await f.receipt()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    expect(await f.counters()).toMatchObject({
      reserved_bytes: action === "multipart-abort" ? 3 : 0,
      physical_bytes: action === "multipart-verify" ? 3 : 0,
    });
    const ledger = JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM mutation_admissions WHERE space_id=?")
          .bind(f.f.ids.space)
          .all()
      ).results,
    );
    expect(ledger).not.toContain(f.created.capability);
  },
);
it.each(actions)("rejects overloaded %s without applying the transition", async (action) => {
  const f = await fixture(action);
  await expect(
    f.run(
      f.configure(async (r) => {
        if (targets(r, action)) throw new Error("full");
        return acquireMutation(r);
      }),
    ),
  ).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.receipt()).toEqual([]);
  await unchanged(f);
});
it.each(
  actions.flatMap((action) =>
    ["credential", "maintenance", "epoch", "revision", "disabled"].map((boundary) => ({
      action,
      boundary,
    })),
  ),
)("rechecks $boundary after waiting for $action", async ({ action, boundary }) => {
  const f = await fixture(action);
  await expect(
    f.run(
      f.configure(async (r) => {
        const grant = await acquireMutation(r);
        if (targets(r, action)) {
          if (boundary === "credential")
            await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
              .bind(f.f.ids.session)
              .run();
          if (boundary === "maintenance")
            await env.DB.prepare("UPDATE control SET maintenance=1").run();
          if (boundary === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
          if (boundary === "revision")
            await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
              .bind(f.f.ids.folder)
              .run();
          if (boundary === "disabled")
            await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?")
              .bind(f.f.ids.user)
              .run();
        }
        return grant;
      }),
    ),
  ).rejects.toThrow();
  expect((await f.receipt())[0]!.committed_at).toBeNull();
  await unchanged(f);
});
it.each(actions)(
  "rolls back %s metadata, refund and exact commit marker atomically",
  async (action) => {
    const f = await fixture(action),
      fault = faultDatabase(action, { rollback: true });
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
    expect(fault.batches()).toBe(1);
    expect(await f.receipt()).toEqual([{ state: "active", committed_at: null }]);
    await unchanged(f);
  },
);
it.each(actions)("recovers the exact %s commit after losing its batch ACK", async (action) => {
  const f = await fixture(action),
    fault = faultDatabase(action, { lostAck: true });
  await f.run(f.configure(undefined, fault.db));
  expect(fault.batches()).toBe(1);
  expect(fault.reads()).toBe(1);
  expect(await f.receipt()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
  expect(await snapshot(f)).toMatchObject({ state: finalState(action) });
  const before = { ...f.calls };
  await f.run();
  expect(f.calls).toEqual(before);
});
it.each(actions)("does not treat another caller's %s outcome as its own commit", async (action) => {
  const f = await fixture(action);
  const fault = faultDatabase(action, {
    before: async () => {
      await f.run();
      throw new Error("our_batch_not_sent");
    },
  });
  const pending = f.run(f.configure(undefined, fault.db));
  if (action === "single-abort") await expect(pending).rejects.toThrow("our_batch_not_sent");
  else await pending;
  expect(await snapshot(f)).toMatchObject({ state: finalState(action) });
  expect(await f.receipt()).toEqual([
    { state: "active", committed_at: null },
    { state: "closed", committed_at: expect.any(Number) },
  ]);
  expect(f.calls.complete).toBe(action === "multipart-verify" ? 1 : 0);
});
it.each(actions)(
  "allows read-only %s replay after all acknowledgement reads were lost",
  async (action) => {
    const f = await fixture(action),
      fault = faultDatabase(action, { lostAck: true, loseReceipt: true, loseUpload: true });
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
    expect(await f.receipt()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    expect(await snapshot(f)).toMatchObject({
      state: action === "multipart-verify" ? "completing" : finalState(action),
    });
    if (action === "multipart-verify")
      expect(await f.counters()).toMatchObject({ physical_bytes: 3, reserved_bytes: 3 });
    await f.run();
    expect(await snapshot(f)).toMatchObject({ state: finalState(action) });
    expect(f.calls.complete).toBe(action === "multipart-verify" ? 1 : 0);
  },
);
it.each(["single-abort", "multipart-abort"] as const)(
  "reads an existing %s receipt without acquiring another slot",
  async (action) => {
    const f = await fixture(action);
    await f.run();
    let calls = 0;
    await f.run(
      f.configure(async () => {
        calls++;
        throw new Error("full");
      }),
    );
    expect(calls).toBe(0);
    expect(await f.receipt()).toHaveLength(1);
  },
);
it.each(actions)("returns HTTP 503/Retry-After for overloaded %s", async (action) => {
  const f = await fixture(action);
  const app = f.configure(async (r) => {
    if (targets(r, action)) throw new Error("full");
    return acquireMutation(r);
  });
  const response = await handleUploadHttp(
    new Request(
      "https://app.invalid/api/v1/uploads/" +
        f.created.id +
        (action === "multipart-verify" ? "/complete" : ""),
      {
        method: action === "multipart-verify" ? "POST" : "DELETE",
        headers: {
          Origin: app.APP_ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": "test",
          "Upload-Capability": f.created.capability,
          "Idempotency-Key": "complete",
        },
        body: "{}",
      },
    ),
    app,
    f.input.principal,
    { verify: async () => {} },
    f.capabilities,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  await unchanged(f);
});
it.each(["single-abort", "multipart-abort"] as const)(
  "checks real credential expiry after %s waits",
  async (action) => {
    const f = await fixture(action),
      expiry = Math.ceil(Date.now() / 1000) * 1000 + 3000;
    await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE id=?")
      .bind(expiry, f.f.ids.session)
      .run();
    let waited = false;
    await expect(
      f.run(
        f.configure(async (r) => {
          const admission = await acquireMutation(r);
          if (targets(r, action)) {
            expect(Date.now()).toBeLessThan(expiry);
            waited = true;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, expiry - Date.now() + 30)),
            );
          }
          return admission;
        }),
      ),
    ).rejects.toThrow();
    expect(waited).toBe(true);
    await unchanged(f);
  },
);
it("retains physical/reserved bytes after multipart verification overload and never completes R2 twice", async () => {
  const f = await fixture("multipart-verify");
  await expect(
    f.run(
      f.configure(async (r) => {
        if (targets(r, "multipart-verify")) throw new Error("full");
        return acquireMutation(r);
      }),
    ),
  ).rejects.toThrow();
  expect(await f.counters()).toEqual({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect(await snapshot(f)).toMatchObject({ multipart_object_etag: null, sha256_verified: null });
  await f.run();
  expect(f.calls.complete).toBe(1);
  expect(await f.counters()).toEqual({ used_bytes: 6, reserved_bytes: 0, physical_bytes: 3 });
});
it("an upload claim racing a queued abort keeps its reservation and charges the late PUT", async () => {
  const f = await fixture("single-abort"),
    app = f.configure();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const bucket = new Proxy(app.BLOBS, {
    get(target, field) {
      if (field === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          reached();
          await gate;
          return target.put(...args);
        };
      const value = Reflect.get(target, field);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let pending: Promise<unknown> | undefined;
  try {
    await f.run(
      f.configure(async (r) => {
        if (targets(r, "single-abort")) {
          pending = writeSingleUpload(
            { ...app, BLOBS: bucket },
            f.input.principal,
            f.created.id,
            f.created.capability,
            f.capabilities,
            new Blob(["abc"]).stream(),
            3,
          );
          void pending.catch(() => {});
          await started;
        }
        return acquireMutation(r);
      }),
    );
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 0 });
    expect(await snapshot(f)).toMatchObject({ state: "aborted", reservation_state: "reserved" });
  } finally {
    release();
  }
  await expect(pending).rejects.toThrow();
  expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
});
