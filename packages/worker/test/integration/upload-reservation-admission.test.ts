import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleUploadHttp } from "../../src/api/uploads";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { createSingleUpload, reserveMultipartUpload } from "../../src/services/uploads/create";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation } from "../fixtures/mutationAdmission";
import { admitted } from "../fixtures/uploadEnv";

const modes = ["single", "multipart"] as const;
type Mode = (typeof modes)[number];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture(mode: Mode, overwrite = false) {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const capabilities = new UploadCapabilities(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const input = {
    principal: {
      kind: "user" as const,
      user_id: f.ids.user,
      credential_id: f.ids.credential,
      epoch: 1,
    },
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: overwrite ? "File" : "new.txt",
    declaredSize: 3,
    ...(overwrite ? { targetId: f.ids.file, targetRevision: 1 } : {}),
  };
  const configure = (acquire = (r: MutationRequest) => acquireMutation(r), db = env.DB): Env => ({
    ...admitted(db),
    APP_ORIGIN: "https://app.invalid",
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: acquire,
        status: async () => ({ epoch: 1, maintenance: false }),
      }),
    } as unknown as Env["CONTROL"],
  });
  const run = (app = configure(), request = input) =>
    (mode === "single" ? createSingleUpload : reserveMultipartUpload)(app, request, capabilities);
  const snapshot = () =>
    Promise.all([
      env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first(),
      env.DB.prepare("SELECT * FROM uploads WHERE owner_id=? ORDER BY id")
        .bind(f.ids.user)
        .all()
        .then((r) => r.results),
      env.DB.prepare("SELECT * FROM reservations WHERE owner_id=? ORDER BY id")
        .bind(f.ids.user)
        .all()
        .then((r) => r.results),
      env.DB.prepare("SELECT * FROM blobs WHERE owner_id=? ORDER BY id")
        .bind(f.ids.user)
        .all()
        .then((r) => r.results),
    ]);
  const receipts = () =>
    env.DB.prepare(
      "SELECT state,committed_at,space_id FROM mutation_admissions WHERE space_id=? AND permit_id LIKE 'upload.reserve:%' ORDER BY seq",
    )
      .bind(f.ids.space)
      .all()
      .then((r) => r.results);
  return { f, input, capabilities, configure, run, snapshot, receipts };
}

function faultDatabase(options: {
  before?: (s: D1PreparedStatement[]) => Promise<void>;
  after?: () => Promise<void>;
  rollback?: boolean;
  loseReceipt?: boolean;
  loseUploadRead?: boolean;
}) {
  const queries = new WeakMap<object, string>();
  let calls = 0;
  let committed = false;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, {
          get(target, key) {
            if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
            if (
              key === "first" &&
              committed &&
              options.loseUploadRead &&
              sql.includes("SELECT * FROM uploads")
            )
              return async () => {
                throw new Error("upload_read_lost");
              };
            if (key === "first" && options.loseReceipt && sql.includes("committed_at IS NOT NULL"))
              return async () => {
                throw new Error("receipt_read_lost");
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        queries.set(proxy, sql);
        return proxy;
      };
      return wrap(env.DB.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const writes = statements.some((s) => queries.get(s)?.includes("INSERT INTO uploads"));
      if (writes) {
        calls++;
        await options.before?.(statements);
      }
      const result = await env.DB.batch(
        writes && options.rollback
          ? [...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (writes) {
        committed = true;
        await options.after?.();
      }
      return result;
    },
  } as unknown as D1Database;
  return { db, calls: () => calls };
}

it.each(modes)("commits one %s reservation and exact receipt without starting R2", async (mode) => {
  const f = await fixture(mode);
  const result = await f.run();
  expect(result).toMatchObject({ mode, state: "created", declaredSize: 3 });
  expect((await f.snapshot())[0]).toEqual({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 0 });
  expect(await f.receipts()).toEqual([
    { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
  ]);
  expect(
    await env.DB.prepare("SELECT r2_upload_id,write_attempt_id FROM uploads WHERE id=?")
      .bind(result.id)
      .first(),
  ).toEqual({ r2_upload_id: null, write_attempt_id: null });
  expect(await env.BLOBS.head("u/" + f.f.ids.user + "/b/" + result.id + "_blob")).toBeNull();
  expect(
    JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM mutation_admissions WHERE space_id=?")
          .bind(f.f.ids.space)
          .all()
      ).results,
    ),
  ).not.toContain(result.capability);
});
it.each(modes)("reserves %s overwrite without changing the current file", async (mode) => {
  const f = await fixture(mode, true);
  await f.run();
  expect(
    await env.DB.prepare("SELECT revision,current_blob_id FROM nodes WHERE id=?")
      .bind(f.f.ids.file)
      .first(),
  ).toEqual({ revision: 1, current_blob_id: f.f.ids.blob });
  expect((await f.snapshot())[0]).toEqual({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 0 });
});
it.each(modes)("rejects overloaded %s reservation without charging quota", async (mode) => {
  const f = await fixture(mode),
    before = await f.snapshot();
  await expect(
    f.run(
      f.configure(async () => {
        throw new Error("full");
      }),
    ),
  ).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.snapshot()).toEqual(before);
  expect(await f.receipts()).toEqual([]);
});

const boundaries = [
  "credential",
  "owner",
  "ancestor",
  "revision",
  "quota",
  "maintenance",
  "epoch",
] as const;
it.each(modes.flatMap((mode) => boundaries.map((boundary) => ({ mode, boundary }))))(
  "rechecks $boundary after $mode reservation waits",
  async ({ mode, boundary }) => {
    const f = await fixture(mode, boundary === "revision"),
      before = await f.snapshot();
    await expect(
      f.run(
        f.configure(async (r) => {
          const grant = await acquireMutation(r);
          const statement = {
            credential: env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(
              f.f.ids.session,
            ),
            owner: env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.f.ids.user),
            ancestor: env.DB.prepare("UPDATE nodes SET deleted_at=1 WHERE id=?").bind(
              f.f.ids.folder,
            ),
            revision: env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?").bind(
              f.f.ids.file,
            ),
            quota: env.DB.prepare("UPDATE users SET quota_bytes=3 WHERE id=?").bind(f.f.ids.user),
            maintenance: env.DB.prepare("UPDATE control SET maintenance=1"),
            epoch: env.DB.prepare("UPDATE control SET epoch=2"),
          }[boundary];
          await statement.run();
          return grant;
        }),
      ),
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect((await f.receipts())[0]!.committed_at).toBeNull();
  },
);
it.each(modes)("rejects another owner's grant for %s reservation", async (mode) => {
  const f = await fixture(mode),
    other = await fixture(mode),
    before = await f.snapshot();
  await expect(
    f.run(f.configure((r) => acquireMutation({ ...r, spaceId: other.f.ids.space }))),
  ).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.snapshot()).toEqual(before);
});
it.each(modes)("rolls back %s upload, quota, blob and admission receipt together", async (mode) => {
  const f = await fixture(mode),
    before = await f.snapshot(),
    fault = faultDatabase({ rollback: true });
  await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
  expect(fault.calls()).toBe(1);
  expect(await f.receipts()).toEqual([
    { state: "active", committed_at: null, space_id: f.f.ids.space },
  ]);
});
it.each(modes.flatMap((mode) => [false, true].map((loseReceipt) => ({ mode, loseReceipt }))))(
  "recovers the stable $mode request after lost ACK (receipt read lost=$loseReceipt)",
  async ({ mode, loseReceipt }) => {
    const f = await fixture(mode),
      fault = faultDatabase({
        loseReceipt,
        after: async () => {
          throw new Error("ack_lost");
        },
      });
    const result = await f.run(f.configure(undefined, fault.db));
    expect(fault.calls()).toBe(1);
    expect(await f.run()).toEqual(result);
    expect((await f.snapshot())[0]).toEqual({
      used_bytes: 3,
      reserved_bytes: 3,
      physical_bytes: 0,
    });
    expect(await f.receipts()).toEqual([
      { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
    ]);
  },
);
it.each(modes)(
  "converges a concurrent %s request without treating its receipt as this attempt's commit",
  async (mode) => {
    const f = await fixture(mode);
    let winner: Awaited<ReturnType<typeof f.run>> | undefined;
    const fault = faultDatabase({
      before: async () => {
        winner = await f.run();
        throw new Error("own_dispatch_lost");
      },
    });
    expect(await f.run(f.configure(undefined, fault.db))).toEqual(winner);
    expect(fault.calls()).toBe(1);
    expect((await f.snapshot())[0]).toEqual({
      used_bytes: 3,
      reserved_bytes: 3,
      physical_bytes: 0,
    });
    expect(await f.receipts()).toEqual([
      { state: "active", committed_at: null, space_id: f.f.ids.space },
      { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
    ]);
  },
);
it.each(modes)("rejects a delayed %s reservation after its admission closes", async (mode) => {
  const f = await fixture(mode),
    before = await f.snapshot();
  let delayed: D1PreparedStatement[] | undefined;
  const fault = faultDatabase({
    before: async (statements) => {
      delayed = statements;
      throw new Error("dispatch_unknown");
    },
  });
  await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow("dispatch_unknown");
  expect(await f.receipts()).toEqual([
    { state: "active", committed_at: null, space_id: f.f.ids.space },
  ]);
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE space_id=?")
    .bind(f.f.ids.space)
    .run();
  expect(delayed).toBeDefined();
  await expect(env.DB.batch(delayed!)).rejects.toThrow();
  expect(await f.snapshot()).toEqual(before);
});
it.each(modes)(
  "reads the same stale %s overwrite receipt while all slots are full",
  async (mode) => {
    const f = await fixture(mode, true),
      result = await f.run();
    await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
      .bind(f.f.ids.file)
      .run();
    for (let i = 0; i < 32; i++)
      await acquireMutation({
        permitId: crypto.randomUUID(),
        spaceId: f.f.ids.space,
        epoch: 1,
        deadline: Date.now() + 5000,
      });
    let calls = 0;
    const app = f.configure(async () => {
      calls++;
      throw new Error("full");
    });
    expect(await f.run(app)).toEqual(result);
    expect(calls).toBe(0);
    await expect(f.run(app, { ...f.input, declaredSize: 4 })).rejects.toThrow(
      "idempotency_conflict",
    );
    await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.f.ids.session).run();
    await expect(f.run(app)).rejects.toThrow("authorization_denied");
    expect(calls).toBe(0);
  },
);
it.each(modes)(
  "returns HTTP 503 with Retry-After and no R2 initialization for overloaded %s creation",
  async (mode) => {
    const f = await fixture(mode),
      before = await f.snapshot();
    let calls = 0;
    const app = f.configure(async () => {
      throw new Error("full");
    });
    app.BLOBS = new Proxy(env.BLOBS, {
      get(target, key) {
        if (key === "createMultipartUpload" || key === "put")
          return () => {
            calls++;
            throw new Error("unexpected_r2");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await handleUploadHttp(
      new Request("https://app.invalid/api/v1/uploads", {
        method: "POST",
        headers: {
          Origin: app.APP_ORIGIN,
          "Content-Type": "application/json",
          "Idempotency-Key": f.input.requestId,
        },
        body: JSON.stringify({
          mode,
          spaceId: f.input.spaceId,
          parentId: f.input.parentId,
          name: f.input.name,
          declared_size: f.input.declaredSize,
        }),
      }),
      app,
      f.input.principal,
      { verify: async () => {} },
      f.capabilities,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await f.snapshot()).toEqual(before);
    expect(calls).toBe(0);
  },
);
it.each(modes)(
  "retains the %s reservation when both the commit ACK and all recovery reads are lost",
  async (mode) => {
    const f = await fixture(mode);
    const fault = faultDatabase({
      loseReceipt: true,
      loseUploadRead: true,
      after: async () => {
        throw new Error("ack_lost");
      },
    });
    await expect(f.run(f.configure(undefined, fault.db))).rejects.toThrow("upload_read_lost");
    expect(fault.calls()).toBe(1);
    const stored = await f.snapshot();
    expect(stored[0]).toEqual({ used_bytes: 3, reserved_bytes: 3, physical_bytes: 0 });
    expect(await f.receipts()).toEqual([
      { state: "closed", committed_at: expect.any(Number), space_id: f.f.ids.space },
    ]);
    expect((await f.run()).state).toBe("created");
    expect(await f.snapshot()).toEqual(stored);
  },
);
it.each(modes)(
  "uses current SQL time when a %s credential expires during the wait",
  async (mode) => {
    const f = await fixture(mode),
      before = await f.snapshot();
    const expiry = Math.ceil(Date.now() / 1000) * 1000 + 2000;
    await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE id=?")
      .bind(expiry, f.f.ids.session)
      .run();
    let waited = false;
    await expect(
      f.run(
        f.configure(async (r) => {
          const grant = await acquireMutation(r);
          expect(Date.now()).toBeLessThan(expiry);
          waited = true;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, expiry - Date.now() + 30)),
          );
          return grant;
        }),
      ),
    ).rejects.toThrow();
    expect(waited).toBe(true);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.receipts())[0]!.committed_at).toBeNull();
  },
);
