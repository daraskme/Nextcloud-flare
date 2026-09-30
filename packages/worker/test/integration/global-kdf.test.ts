import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleAppPasswordHttp } from "../../src/api/appPasswords";
import { handleDavHttp } from "../../src/api/dav";
import { appPasswordPepperRing, authenticateAppPassword } from "../../src/auth/appPassword";
import { globalKdf, type KdfRequest } from "../../src/auth/globalKdf";
import { KdfUnavailableError } from "../../src/auth/kdf";
import { atomicBatch, type SqlStatement } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { ControlKdf } from "../../src/do/controlKdf";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { KdfSettlements } from "../../src/do/kdfSettlements";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import type { Env } from "../../src/env";
import { createAppPassword } from "../../src/services/appPasswords";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
let baseline = 0;
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  baseline = (await env.DB.prepare(
    "SELECT COALESCE(MAX(rowid),0) AS n FROM kdf_attempts",
  ).first<number>("n"))!;
});
afterEach(() => vi.restoreAllMocks());
const count = (condition = "1=1") =>
  env.DB.prepare(`SELECT COUNT(*) AS n FROM kdf_attempts WHERE (${condition}) AND rowid>?`)
    .bind(baseline)
    .first<number>("n");
const request = (epoch = 1): KdfRequest => ({
  id: crypto.randomUUID(),
  epoch,
  deadline: Date.now() + 5000,
  input: new Uint8Array(32).fill(7).buffer,
  salt: new Uint8Array(16).fill(3),
});
const receipt = (id: string) =>
  env.DB.prepare("SELECT * FROM kdf_attempts WHERE id=?").bind(id).first();
async function admit(epoch: number) {
  if (
    !(await env.DB.prepare("SELECT 1 FROM control WHERE epoch=? AND maintenance=0")
      .bind(epoch)
      .first())
  )
    throw new KdfUnavailableError();
}
const executor = (db = env.DB, current = (_epoch: number) => {}, admission = admit) => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(`kdf-fixture-${crypto.randomUUID()}`));
  let service: ControlKdf | undefined;
  return {
    async derive(r: KdfRequest) {
      const result = await runInDurableObject(stub, async (_, state) => {
        service ??= new ControlKdf(
          db,
          admission,
          current,
          new KdfSettlements(state.storage.sql, db),
        );
        try {
          return { value: await service.derive(r) };
        } catch {
          return { value: null };
        }
      });
      if (!result.value) throw new KdfUnavailableError();
      return result.value;
    },
  };
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function backend(service: Pick<ControlKdf, "derive">) {
  return globalKdf(
    {
      idFromName: () => ({}),
      get: () => ({ deriveKdf: (r: KdfRequest) => service.derive(r) }),
    } as unknown as Env["CONTROL"],
    1,
  );
}
async function seed(n: number, finish = false) {
  const ids: string[] = [];
  const statements: SqlStatement[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    statements.push(
      {
        sql: "INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at) VALUES(?,?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
        values: [id, crypto.randomUUID()],
      },
      ...(finish
        ? [
            {
              sql: "UPDATE kdf_attempts SET state='finished',finished_at=issued_at WHERE id=?",
              values: [id],
            },
          ]
        : []),
    );
  }
  for (let i = 0; i < statements.length; i += 100)
    await atomicBatch(env.DB, statements.slice(i, i + 100));
  return ids;
}

it("derives the same fixed-cost result and stores only dispatch metadata", async () => {
  const r = request(),
    expected = await localKdf(r.input, r.salt);
  expect(await executor().derive(r)).toEqual(expected);
  expect(new Uint8Array(r.input)).toEqual(new Uint8Array(32).fill(7));
  const saved = await receipt(r.id);
  expect(saved).toMatchObject({ id: r.id, epoch: 1, state: "finished" });
  expect(Object.keys(saved!).sort()).toEqual([
    "dispatch_token",
    "epoch",
    "expires_at",
    "finished_at",
    "id",
    "issued_at",
    "state",
  ]);
  expect(await count("state='claimed'")).toBe(0);
});

it("never repeats a consumed attempt, including after a new executor instance", async () => {
  const r = request();
  await executor().derive(r);
  const cryptoCall = vi.spyOn(crypto.subtle, "deriveBits");
  await expect(executor().derive(r)).rejects.toThrow("kdf_unavailable");
  expect(cryptoCall).not.toHaveBeenCalled();
  expect(await count()).toBe(1);
});

it("serializes calculations within one instance without losing their rate charges", async () => {
  const native = crypto.subtle.deriveBits.bind(crypto.subtle);
  let active = 0,
    peak = 0;
  vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active);
    try {
      return await native(...args);
    } finally {
      active--;
    }
  });
  const service = executor();
  // Verify serialization and all six durable charges without assuming the runner
  // can complete six serial DB/DO round trips inside one five-second request window.
  for (let pair = 0; pair < 3; pair++) {
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => service.derive(request())),
    );
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await count("state='finished'")).toBe((pair + 1) * 2);
  }
  expect(peak).toBe(1);
  expect(await count("state='finished'")).toBe(6);
});

it("bounds overlapping instances and unknown work at 20 until native execution settles", async () => {
  const prior = await seed(18);
  const held = deferred(),
    entered = deferred();
  let nativeCalls = 0;
  const native = crypto.subtle.deriveBits.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (...args) => {
    if (++nativeCalls === 2) entered.resolve();
    await held.promise;
    return native(...args);
  });
  const running = Promise.all([executor().derive(request()), executor().derive(request())]);
  try {
    await Promise.race([entered.promise, running.then(() => undefined)]);
    expect(await count("state='claimed'")).toBe(20);
    await expect(executor().derive(request())).rejects.toThrow("kdf_unavailable");
    expect(nativeCalls).toBe(2);
    await env.DB.prepare("UPDATE control SET maintenance=1").run();
    expect(await env.DB.prepare(RECOVERY_FINAL_QUERY).bind(1).first()).toBeNull();
  } finally {
    held.resolve();
    await running;
  }
  expect(await count("state='claimed'")).toBe(18);
  await atomicBatch(
    env.DB,
    prior.map((id) => ({
      sql: "UPDATE kdf_attempts SET state='finished',finished_at=MAX(issued_at,strftime('%s','now')*1000) WHERE id=?",
      values: [id],
    })),
  );
  expect(await env.DB.prepare(RECOVERY_FINAL_QUERY).bind(1).first()).not.toBeNull();
});

it("does not dispatch after losing the claim acknowledgement and retains the spent rate charge", async () => {
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO kdf_attempts"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const r = request(),
    native = vi.spyOn(crypto.subtle, "deriveBits");
  await expect(executor(db).derive(r)).rejects.toThrow("kdf_unavailable");
  expect(native).not.toHaveBeenCalled();
  expect(await receipt(r.id)).toMatchObject({ state: "not_started" });
  await expect(executor().derive(r)).rejects.toThrow("kdf_unavailable");
  expect(await count()).toBe(1);
});

it.each(["maintenance", "deadline", "local-fence"])(
  "rechecks %s after the confirmed claim",
  async (boundary) => {
    let claimed = false;
    const db = injectBatch(
      (sql) => sql.includes("INSERT INTO kdf_attempts"),
      async () => {
        claimed = true;
        if (boundary === "maintenance")
          await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (boundary === "deadline") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
      },
      true,
    );
    const r = request(),
      native = vi.spyOn(crypto.subtle, "deriveBits");
    await expect(
      executor(db, () => {
        if (claimed && boundary === "local-fence") throw new Error("replaced");
      }).derive(r),
    ).rejects.toThrow("kdf_unavailable");
    expect(native).not.toHaveBeenCalled();
    expect(await receipt(r.id)).toMatchObject({ state: "not_started" });
  },
);

function settlementFault(afterCommit: boolean): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === "run")
          return async () => {
            if (afterCommit) await target.run();
            throw new Error("lost_settlement");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    batch: env.DB.batch.bind(env.DB),
    prepare: (sql: string) =>
      sql.startsWith("UPDATE kdf_attempts SET state=")
        ? wrap(env.DB.prepare(sql))
        : env.DB.prepare(sql),
  } as D1Database;
}
it("recovers a committed settlement acknowledgement without repeating crypto", async () => {
  const r = request(),
    native = vi.spyOn(crypto.subtle, "deriveBits");
  expect((await executor(settlementFault(true)).derive(r)).byteLength).toBe(32);
  expect(await receipt(r.id)).toMatchObject({ state: "finished" });
  expect(native).toHaveBeenCalledTimes(1);
});
it("retains an unknown settlement across instances instead of freeing an execution slot", async () => {
  const r = request();
  await expect(executor(settlementFault(false)).derive(r)).rejects.toThrow("kdf_unavailable");
  expect(await receipt(r.id)).toMatchObject({ state: "claimed" });
  const native = vi.spyOn(crypto.subtle, "deriveBits");
  await expect(executor().derive(r)).rejects.toThrow("kdf_unavailable");
  expect(native).not.toHaveBeenCalled();
  expect(await count("state='claimed'")).toBe(1);
  // Native crypto completed; the injected settlement write alone failed.
  await env.DB.prepare(
    "UPDATE kdf_attempts SET state='finished',finished_at=MAX(issued_at,strftime('%s','now')*1000) WHERE id=?",
  )
    .bind(r.id)
    .run();
});
it("settles a rejected native calculation without refunding its rate charge", async () => {
  vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValueOnce(new Error("crypto_failure"));
  const r = request();
  await expect(executor().derive(r)).rejects.toThrow("kdf_unavailable");
  expect(await receipt(r.id)).toMatchObject({ state: "finished" });
});

it("retains running capacity after caller cancellation until the actual result arrives", async () => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(`cancel-kdf-${crypto.randomUUID()}`));
  // AbortController is request-context bound: create and cancel it in the same DO context.
  await runInDurableObject(stub, async (_, state) => {
    const held = deferred(),
      entered = deferred(),
      abort = new AbortController();
    const native = crypto.subtle.deriveBits.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "deriveBits").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await held.promise;
      return native(...args);
    });
    const derive = backend(
        new ControlKdf(env.DB, admit, () => {}, new KdfSettlements(state.storage.sql, env.DB)),
      ),
      r = request();
    const pending = derive(r.input, r.salt, abort.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(KdfUnavailableError);
    try {
      await Promise.race([entered.promise, pending.then(() => undefined)]);
      abort.abort();
      expect(await count("state='claimed'")).toBe(1);
    } finally {
      held.resolve();
      await rejected;
    }
    expect(await count("state='finished'")).toBe(1);
  });
});

it("uses real ControlDO RPC, keeps counters across eviction and cools down after full storage recovery", async () => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const { epoch } = await stub.recover();
  await stub.beginRecoveryAudit(epoch);
  let done = false;
  for (let i = 0; i < 20 && !done; i++) done = (await stub.nextRecoveryAuditPage(epoch)).completed;
  expect(done).toBe(true);
  await stub.resumeAdmission(epoch);
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.deriveKdf(request(epoch))).rejects.toThrow("kdf_unavailable");
  });
  await env.DB.prepare("UPDATE control SET kdf_not_before=0").run();
  const r = request(epoch);
  expect((await globalKdf(env.CONTROL, epoch)(r.input, r.salt)).byteLength).toBe(32);
  await evictDurableObject(stub);
  expect(await count()).toBe(1);
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.deleteAll();
  });
  await evictDurableObject(stub);
  expect((await stub.recover()).epoch).toBeGreaterThan(epoch);
  expect(await count()).toBe(1);
  expect(
    await env.DB.prepare("SELECT kdf_not_before FROM control").first<number>("kdf_not_before"),
  ).toBeGreaterThan(Date.now() + 60000);
});

it("connects issuance, authentication and pepper rotation to the same durable rate ledger", async () => {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const derive = backend(executor());
  const key = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const keys = { v1: key(), v2: key() };
  const ring = await appPasswordPepperRing("v1", keys, derive);
  const session = {
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const credential = await createAppPassword(
    mutationEnv(env.DB),
    session,
    { name: "global", scopes: ["node:read"] },
    ring,
  );
  const login = new Request("https://app.invalid/dav", {
    headers: { Authorization: `Basic ${btoa(`${credential.id}:${credential.secret}`)}` },
  });
  const rotated = await appPasswordPepperRing("v2", keys, derive);
  expect(
    await authenticateAppPassword(mutationEnv(env.DB), login, "https://app.invalid", 1, rotated),
  ).toMatchObject({ credential_id: credential.credentialId });
  expect(await count("state='finished'")).toBe(4);
});

it.each(["id", "input", "salt", "epoch", "deadline"])(
  "rejects malformed %s before admission or native crypto",
  async (field) => {
    const r = request();
    const broken = {
      ...r,
      [field]:
        field === "input"
          ? new ArrayBuffer(33)
          : field === "salt"
            ? new Uint8Array(17)
            : field === "id"
              ? "bad"
              : 0,
    };
    const admitSpy = vi.fn(async () => {});
    await expect(executor(env.DB, () => {}, admitSpy).derive(broken as KdfRequest)).rejects.toThrow(
      "kdf_unavailable",
    );
    expect(admitSpy).not.toHaveBeenCalled();
    expect(await count()).toBe(0);
  },
);

it("rejects the 601st dispatch and returns retryable global overload on both production HTTP handlers", async () => {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const keys = { v1: base64url.encode(crypto.getRandomValues(new Uint8Array(32))) };
  const fixtureRing = await appPasswordPepperRing("v1", keys, localKdf);
  const session = {
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const credential = await createAppPassword(
    mutationEnv(env.DB),
    session,
    { name: "global overload", scopes: ["node:read"] },
    fixtureRing,
  );
  const recent = (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM kdf_attempts WHERE issued_at>strftime('%s','now')*1000-65000",
  ).first<number>("n"))!;
  await seed(599 - recent, true);
  const service = executor();
  expect((await service.derive(request())).byteLength).toBe(32);
  const native = vi.spyOn(crypto.subtle, "deriveBits");
  const ring = await appPasswordPepperRing("v1", keys, backend(service));
  const app = {
    ...env,
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  };
  const dav = await handleDavHttp(
    new Request(`${app.APP_ORIGIN}/dav`, {
      method: "OPTIONS",
      headers: { Authorization: `Basic ${btoa(`${credential.id}:${credential.secret}`)}` },
    }),
    app,
    1,
    ring,
  );
  const issued = await handleAppPasswordHttp(
    new Request(`${app.APP_ORIGIN}/api/v1/app-passwords`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: app.APP_ORIGIN,
      },
      body: JSON.stringify({ name: "limited", scopes: ["node:read"] }),
    }),
    app,
    session,
    { verify: async () => {} },
    ring,
  );
  for (const response of [dav, issued]) {
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
  }
  expect(native).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM kdf_attempts WHERE issued_at>strftime('%s','now')*1000-65000",
    ).first("n"),
  ).toBe(600);
});
