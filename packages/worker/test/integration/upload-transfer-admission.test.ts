import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { handleUploadHttp } from "../../src/api/uploads";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { acquireMutation } from "../fixtures/mutationAdmission";

import {
  type Action,
  actions,
  cleanupTransferObjects,
  transferFixture as fixture,
} from "../fixtures/uploadTransfer";

const dispatches = actions.filter((action) => action !== "single-verify");
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
afterEach(cleanupTransferObjects);
const targets = (request: MutationRequest, action: Action) =>
  request.permitId.startsWith("upload." + action + ":");
const writes = (sql: string, action: Action) =>
  sql.includes(
    {
      "single-start": "SET state='receiving',write_attempt_id=",
      "single-recover": "SET control_calls=control_calls+1 WHERE id=? AND control_calls<32",
      "single-verify": "UPDATE blobs SET sha256_verified=",
      "multipart-start": "SET write_attempt_id=?,write_lease_expires_at=",
      "multipart-complete": "SET multipart_complete_attempt=",
    }[action],
  );

function faultDatabase(
  action: Action,
  options: { lostAck?: boolean; rollback?: boolean; loseReceipt?: boolean },
) {
  const queries = new WeakMap<object, string>();
  let batches = 0,
    reads = 0;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, field) {
            if (field === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (field === "first" && sql.includes("committed_at IS NOT NULL"))
              return async (...args: unknown[]) => {
                reads++;
                if (options.loseReceipt) throw new Error("receipt_read_lost");
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
      if (matches) batches++;
      const result = await env.DB.batch(
        matches && options.rollback
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (matches && options.lostAck) throw new Error("lost_claim_ack");
      return result;
    },
  } as unknown as D1Database;
  return { db, batches: () => batches, reads: () => reads };
}

async function undispatched(f: Awaited<ReturnType<typeof fixture>>) {
  if (f.action === "single-start") {
    expect(await f.row()).toMatchObject({
      state: "created",
      write_attempt_id: null,
      data_calls: 0,
      sha256_verified: null,
    });
    expect(f.calls.put).toBe(0);
  } else if (f.action === "single-recover") {
    expect(await f.row()).toMatchObject({
      state: "receiving",
      control_calls: 0,
      sha256_verified: null,
    });
    expect(f.calls.get).toBe(0);
    expect(f.calls.put).toBe(0);
  } else if (f.action === "single-verify") {
    expect(await f.row()).toMatchObject({ state: "receiving", sha256_verified: null });
    expect(await f.counters()).toMatchObject({ reserved_bytes: 3, physical_bytes: 3 });
    expect(f.calls.put).toBe(1);
  } else if (f.action === "multipart-start") {
    expect(await f.row()).toMatchObject({
      state: "created",
      write_attempt_id: null,
      r2_upload_id: null,
    });
    expect(f.calls.create).toBe(0);
  } else {
    expect(await f.row()).toMatchObject({
      state: "completing",
      multipart_complete_attempt: null,
      sha256_verified: null,
    });
    expect(f.calls.complete).toBe(0);
  }
}
it.each(actions)(
  "admits %s, records the exact commit and returns its shared slot",
  async (action) => {
    const f = await fixture(action);
    const result = await f.run();
    if (action === "multipart-complete")
      expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    else
      expect(result).toMatchObject({
        state: action === "multipart-start" ? "created" : "completing",
      });
    expect(await f.receipt()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    const records = JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM mutation_admissions WHERE space_id=?")
          .bind(f.f.ids.space)
          .all()
      ).results,
    );
    expect(records).not.toContain(f.created.capability);
  },
);
it.each(actions)(
  "rejects overloaded %s without performing the denied transition",
  async (action) => {
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
    await undispatched(f);
  },
);
it.each(
  actions.flatMap((action) =>
    ["credential", "maintenance", "revision"].map((boundary) => ({ action, boundary })),
  ),
)("rechecks $boundary after $action waits", async ({ action, boundary }) => {
  const f = await fixture(action);
  await expect(
    f.run(
      f.configure(async (r) => {
        const admission = await acquireMutation(r);
        if (targets(r, action)) {
          if (boundary === "credential")
            await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
              .bind(f.f.ids.session)
              .run();
          if (boundary === "maintenance")
            await env.DB.prepare("UPDATE control SET maintenance=1").run();
          if (boundary === "revision")
            await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
              .bind(f.f.ids.folder)
              .run();
        }
        return admission;
      }),
    ),
  ).rejects.toThrow();
  expect((await f.receipt())[0]!.committed_at).toBeNull();
  await undispatched(f);
});
it.each(dispatches)(
  "losing the %s batch ACK never authorizes external dispatch even with a committed receipt",
  async (action) => {
    const f = await fixture(action),
      fault = faultDatabase(action, { lostAck: true });
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
    expect(fault.batches()).toBe(1);
    expect(fault.reads()).toBe(0);
    expect(await f.receipt()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    expect(f.calls.put).toBe(0);
    expect(f.calls.create).toBe(0);
    expect(f.calls.complete).toBe(0);
    if (action === "single-recover") {
      expect(f.calls.get).toBe(0);
      expect(await f.row()).toMatchObject({ state: "receiving", control_calls: 1 });
    } else {
      await expect(f.run()).rejects.toThrow();
      expect(f.calls.put + f.calls.create + f.calls.complete).toBe(0);
    }
  },
);
it.each(actions)(
  "rolls back %s and its receipt together without releasing uncertain capacity",
  async (action) => {
    const f = await fixture(action),
      fault = faultDatabase(action, { rollback: true });
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
    expect(fault.batches()).toBe(1);
    expect(await f.receipt()).toEqual([{ state: "active", committed_at: null }]);
    await undispatched(f);
  },
);
it("recovers verified single-upload metadata from its exact receipt without another PUT", async () => {
  const f = await fixture("single-verify"),
    fault = faultDatabase("single-verify", { lostAck: true });
  expect(await f.run(f.configure(undefined, fault.db))).toMatchObject({ state: "completing" });
  expect(fault.reads()).toBe(1);
  expect(fault.batches()).toBe(1);
  expect(f.calls.put).toBe(1);
  expect(await f.run()).toMatchObject({ state: "completing" });
  expect(f.calls.put).toBe(1);
});
it("keeps physical and reserved bytes when verification capacity is full and recovers without re-PUT", async () => {
  const f = await fixture("single-verify");
  await expect(
    f.run(
      f.configure(async (r) => {
        if (targets(r, "single-verify")) throw new Error("full");
        return acquireMutation(r);
      }),
    ),
  ).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.counters()).toEqual({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect(await f.run()).toMatchObject({ state: "completing" });
  expect(f.calls.put).toBe(1);
  expect(f.calls.get).toBe(1);
});
it("does not release or re-PUT when verified metadata committed but its receipt read was lost", async () => {
  const f = await fixture("single-verify"),
    fault = faultDatabase("single-verify", { lostAck: true, loseReceipt: true });
  await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow("receipt_read_lost");
  expect(await f.counters()).toEqual({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 3 });
  expect(await f.run()).toMatchObject({ state: "completing" });
  expect(f.calls.put).toBe(1);
});
it.each(["single-start", "multipart-complete"] as const)(
  "checks actual credential expiry after %s waits",
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
    await undispatched(f);
  },
);
it("returns HTTP 503 with Retry-After and cancels the body before an overloaded single PUT", async () => {
  const f = await fixture("single-start");
  const app = f.configure(async (r) => {
    if (targets(r, "single-start")) throw new Error("full");
    return acquireMutation(r);
  });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const response = await handleUploadHttp(
    new Request("https://app.invalid/api/v1/uploads/" + f.created.id + "/content", {
      method: "PUT",
      headers: {
        Origin: app.APP_ORIGIN,
        "Content-Length": "3",
        "Upload-Capability": f.created.capability,
      },
      body,
    }),
    app,
    f.input.principal,
    { verify: async () => {} },
    f.capabilities,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(cancelled).toBe(true);
  expect(f.calls.put).toBe(0);
  await undispatched(f);
});
