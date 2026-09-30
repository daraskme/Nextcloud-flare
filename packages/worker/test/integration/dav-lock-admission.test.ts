import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Principal } from "../../src/auth/authorize";
import { type MutationAdmission, type MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch, type SqlStatement } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
type Action = "create" | "refresh" | "unlock";
const actions: Action[] = ["create", "refresh", "unlock"];

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const appPasswordId = crypto.randomUUID();
  const credentialId = `ap:${appPasswordId}`;
  // Authorization fixture only: the HTTP suite verifies Basic/KDF before constructing this principal.
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
      VALUES(?,?,?,'DAV','fixture','fixture','PBKDF2-SHA256','{"iterations":100000}','fixture',?,?)`,
      values: [appPasswordId, f.ids.user, f.ids.root, Date.now() - 1000, Date.now() + 600000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [credentialId, appPasswordId],
    },
    {
      sql: "INSERT INTO credential_scopes(credential_id,scope) VALUES(?,'node:write')",
      values: [credentialId],
    },
  ]);
  const principal: Principal = {
    kind: "app_password",
    credential_id: credentialId,
    user_id: f.ids.user,
    epoch: 1,
  };
  const create = {
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.file,
    principal,
    displayHref: "/dav/Folder/File",
    depth: "0" as const,
    ownerText: "owner",
    timeoutSeconds: 60,
  };
  const stub = env.LOCKS.get(env.LOCKS.idFromName(f.ids.space));
  async function invoke<T>(
    callback: (lock: LockDO) => Promise<T>,
    options: {
      db?: D1Database;
      acquire?: (request: MutationRequest) => Promise<MutationAdmission>;
    } = {},
  ) {
    return runInDurableObject(stub, async (_, state) => {
      const configured = {
        ...env,
        DB: options.db ?? env.DB,
        CONTROL: {
          idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
          get: () => ({
            status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
            acquireMutation: options.acquire ?? acquireMutation,
          }),
        } as unknown as Env["CONTROL"],
      };
      return callback(new LockDO(state, configured));
    });
  }
  let token = "";
  async function prepare(action: Action) {
    if (action !== "create") token = (await invoke((lock) => lock.createDavLock(create))).token;
  }
  const run = (action: Action, options: Parameters<typeof invoke>[1] = {}) =>
    invoke(async (lock) => {
      if (action === "create") return lock.createDavLock(create);
      const change = {
        spaceId: f.ids.space,
        nodeId: f.ids.file,
        principal,
        token,
        timeoutSeconds: 120,
      };
      return action === "refresh" ? lock.refreshDavLock(change) : lock.unlockDavLock(change);
    }, options);
  const locks = () =>
    env.DB.prepare("SELECT id,token_hash,expires_at FROM locks WHERE space_id=?")
      .bind(f.ids.space)
      .all();
  const receipts = () =>
    env.DB.prepare(
      "SELECT state,committed_at FROM mutation_admissions WHERE space_id=? ORDER BY seq",
    )
      .bind(f.ids.space)
      .all<{ state: string; committed_at: number | null }>();
  return { f, credentialId, create, invoke, prepare, run, locks, receipts };
}

it.each(actions)(
  "commits %s and its receipt atomically, returning the shared slot immediately",
  async (action) => {
    const f = await fixture();
    await f.prepare(action);
    await f.run(action);
    const rows = (await f.receipts()).results;
    expect(rows.length).toBe(action === "create" ? 1 : 2);
    expect(rows.every((row) => row.state === "closed" && row.committed_at !== null)).toBe(true);
    expect((await f.locks()).results).toHaveLength(action === "unlock" ? 0 : 1);
  },
);

it.each(actions)("rejects overloaded %s without changing a lock", async (action) => {
  const f = await fixture();
  await f.prepare(action);
  const before = await f.locks();
  await expect(
    f.run(action, {
      acquire: async () => {
        throw new Error("queue_full");
      },
    }),
  ).rejects.toThrow("mutation_unavailable");
  expect((await f.locks()).results).toEqual(before.results);
});

it.each(actions)(
  "reconciles a committed %s reply without executing the mutation again",
  async (action) => {
    const f = await fixture();
    await f.prepare(action);
    let dispatches = 0;
    const db = injectBatch(
      (sql) => sql.includes("committed_at="),
      async () => {
        dispatches++;
        throw new Error("lost_ack");
      },
      true,
    );
    await f.run(action, { db });
    expect(dispatches).toBe(1);
    expect((await f.receipts()).results.every((row) => row.committed_at !== null)).toBe(true);
    expect((await f.locks()).results).toHaveLength(action === "unlock" ? 0 : 1);
  },
);

it.each(actions)("rechecks revoked authority after %s waited for capacity", async (action) => {
  const f = await fixture();
  await f.prepare(action);
  const before = await f.locks();
  await expect(
    f.run(action, {
      acquire: async (request) => {
        const ticket = await acquireMutation(request);
        await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.credentialId.slice(3))
          .run();
        return ticket;
      },
    }),
  ).rejects.toThrow();
  expect((await f.locks()).results).toEqual(before.results);
  const last = (await f.receipts()).results.at(-1)!;
  expect(last).toEqual({ state: "active", committed_at: null });
});

it.each(["refresh", "unlock"] as const)(
  "does not revive or successfully %s a lock that expired during the wait",
  async (action) => {
    const f = await fixture();
    await f.prepare(action);
    await expect(
      f.run(action, {
        acquire: async (request) => {
          const ticket = await acquireMutation(request);
          await env.DB.prepare("UPDATE locks SET expires_at=0 WHERE space_id=?")
            .bind(f.f.ids.space)
            .run();
          return ticket;
        },
      }),
    ).rejects.toThrow();
    expect((await f.locks()).results).toMatchObject([{ expires_at: 0 }]);
    expect((await f.receipts()).results.at(-1)!.committed_at).toBeNull();
  },
);

it.each(["maintenance", "epoch"] as const)(
  "rejects a lock mutation after %s closes its grant",
  async (change) => {
    const f = await fixture();
    await expect(
      f.run("create", {
        acquire: async (request) => {
          const ticket = await acquireMutation(request);
          await env.DB.prepare(
            change === "maintenance"
              ? "UPDATE control SET maintenance=1"
              : "UPDATE control SET epoch=2",
          ).run();
          return ticket;
        },
      }),
    ).rejects.toThrow();
    expect((await f.locks()).results).toEqual([]);
    expect((await f.receipts()).results).toEqual([{ state: "closed", committed_at: null }]);
  },
);

it("does not mistake another unlock for this invocation committing", async () => {
  const f = await fixture();
  await f.prepare("unlock");
  const db = injectBatch(
    (sql) => sql.includes("DELETE FROM locks"),
    async () => {
      await env.DB.prepare("DELETE FROM locks WHERE space_id=?").bind(f.f.ids.space).run();
      throw new Error("dispatch_failed");
    },
    false,
  );
  await expect(f.run("unlock", { db })).rejects.toThrow("dispatch_failed");
  expect((await f.receipts()).results.at(-1)).toEqual({ state: "active", committed_at: null });
});

it("keeps a committed receipt when both the batch reply and its readback are lost", async () => {
  const f = await fixture();
  let dispatches = 0;
  const injected = injectBatch(
    (sql) => sql.includes("committed_at="),
    async () => {
      dispatches++;
      throw new Error("lost_ack");
    },
    true,
  );
  const db = {
    prepare(sql: string) {
      if (sql.includes("committed_at IS NOT NULL")) throw new Error("readback_lost");
      return injected.prepare(sql);
    },
    batch: injected.batch.bind(injected),
  } as D1Database;
  await expect(f.run("create", { db })).rejects.toThrow("readback_lost");
  expect(dispatches).toBe(1);
  expect((await f.locks()).results).toHaveLength(1);
  expect((await f.receipts()).results).toMatchObject([
    { state: "closed", committed_at: expect.any(Number) },
  ]);
});

it("rolls back the lock itself if the final receipt fence loses its grant", async () => {
  const f = await fixture();
  let ticket: MutationAdmission | undefined;
  const db = injectBatch(
    (sql) => sql.includes("committed_at="),
    async () => {
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(ticket!.id)
        .run();
    },
    false,
  );
  await expect(
    f.run("create", {
      db,
      acquire: async (request) => {
        ticket = await acquireMutation(request);
        return ticket;
      },
    }),
  ).rejects.toThrow();
  expect((await f.locks()).results).toEqual([]);
  expect((await f.receipts()).results).toEqual([{ state: "closed", committed_at: null }]);
});

it("rolls back every lock side effect when the receipt statement itself fails", async () => {
  const f = await fixture();
  const statements: SqlStatement[] = [
    {
      sql: "CREATE TRIGGER fixture_reject_commit BEFORE UPDATE OF committed_at ON mutation_admissions WHEN NEW.committed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt_failed'); END",
    },
  ];
  await atomicBatch(env.DB, statements);
  try {
    await expect(f.run("create")).rejects.toThrow("receipt_failed");
    expect((await f.locks()).results).toEqual([]);
    expect((await f.receipts()).results).toEqual([{ state: "active", committed_at: null }]);
  } finally {
    await env.DB.prepare("DROP TRIGGER fixture_reject_commit").run();
  }
});
