import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleAppPasswordHttp } from "../../src/api/appPasswords";
import { handleDavHttp } from "../../src/api/dav";
import { appPasswordPepperRing, authenticateAppPassword } from "../../src/auth/appPassword";
import type { AccessSession } from "../../src/auth/sessions";
import type { MutationAdmission, MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { createAppPassword, revokeAppPassword } from "../../src/services/appPasswords";
import { foundationFixture } from "../fixtures/foundation";
import { localKdf } from "../fixtures/kdf";
import { acquireMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const actions = ["create", "revoke", "rotate"] as const;
type Action = (typeof actions)[number];
const key = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const session: AccessSession = {
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const keys = { v1: key(), v2: key() };
  let derivations = 0;
  const derive: typeof localKdf = async (...args) => {
    derivations++;
    return localKdf(...args);
  };
  const ring = await appPasswordPepperRing("v1", keys, derive);
  const next = await appPasswordPepperRing("v2", keys, derive);
  const input = {
    name: "new",
    scopes: ["node:read"],
    spaceId: f.ids.space,
    rootNodeId: f.ids.folder,
  };
  const credential = await createAppPassword(
    mutationEnv(),
    session,
    { ...input, name: "existing" },
    ring,
  );
  derivations = 0;
  const baseline = (await env.DB.prepare(
    "SELECT MAX(seq) AS n FROM mutation_admissions",
  ).first<number>("n"))!;
  const request = () =>
    new Request("https://app.invalid/dav", {
      method: "OPTIONS",
      headers: { Authorization: `Basic ${btoa(`${credential.id}:${credential.secret}`)}` },
    });
  const app = (
    options: { db?: D1Database; acquire?: (r: MutationRequest) => Promise<MutationAdmission> } = {},
  ): Env => ({
    ...mutationEnv(options.db),
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({ acquireMutation: options.acquire ?? acquireMutation }),
    } as unknown as Env["CONTROL"],
  });
  const run = (action: Action, configured = app()) =>
    action === "create"
      ? createAppPassword(configured, session, input, ring)
      : action === "revoke"
        ? revokeAppPassword(configured, session, credential.credentialId)
        : authenticateAppPassword(configured, request(), configured.APP_ORIGIN, 1, next);
  const rows = async () =>
    (
      await env.DB.prepare(
        "SELECT id,secret_digest,salt,kid,revoked_at FROM app_passwords WHERE user_id=? ORDER BY id",
      )
        .bind(f.ids.user)
        .all()
    ).results;
  const receipts = async () =>
    (
      await env.DB.prepare(
        "SELECT state,committed_at FROM mutation_admissions WHERE seq>? AND space_id=? ORDER BY seq",
      )
        .bind(baseline, f.ids.space)
        .all()
    ).results;
  return {
    f,
    session,
    ring,
    next,
    input,
    credential,
    request,
    app,
    run,
    rows,
    receipts,
    derivations: () => derivations,
  };
}

it.each(actions)(
  "commits %s with a receipt after KDF work and immediately returns its shared slot",
  async (action) => {
    const f = await fixture();
    const result = await f.run(
      action,
      f.app({
        acquire: async (r) => {
          expect(f.derivations()).toBe(action === "create" ? 1 : action === "rotate" ? 2 : 0);
          expect(r.spaceId).toBe(f.f.ids.space);
          return acquireMutation(r);
        },
      }),
    );
    expect(await f.receipts()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    const rows = await f.rows();
    expect(rows).toHaveLength(action === "create" ? 2 : 1);
    if (action === "revoke") expect(rows[0]!.revoked_at).not.toBeNull();
    if (action === "rotate") expect(rows[0]!.kid).toBe("v2");
    const raw = JSON.stringify(
      (
        await env.DB.prepare("SELECT * FROM mutation_admissions WHERE space_id=?")
          .bind(f.f.ids.space)
          .all()
      ).results,
    );
    expect(raw).not.toContain(f.credential.secret);
    if (result && "secret" in result) expect(raw).not.toContain(result.secret);
  },
);

it.each(actions)(
  "returns HTTP 503 for overloaded %s without changing credentials",
  async (action) => {
    const f = await fixture();
    const before = await f.rows();
    const app = f.app({
      acquire: async () => {
        throw new Error("queue_full");
      },
    });
    const response =
      action === "rotate"
        ? await handleDavHttp(f.request(), app, 1, f.next)
        : await handleAppPasswordHttp(
            new Request(
              `https://app.invalid/api/v1/app-passwords${action === "revoke" ? `/${encodeURIComponent(f.credential.credentialId)}` : ""}`,
              {
                method: action === "create" ? "POST" : "DELETE",
                headers: { "Content-Type": "application/json" },
                ...(action === "create" ? { body: JSON.stringify(f.input) } : {}),
              },
            ),
            app,
            f.session,
            { verify: async () => {} },
            f.ring,
          );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toEqual([]);
  },
);

it.each(actions)(
  "reconciles the exact committed %s batch once after acknowledgement loss",
  async (action) => {
    const f = await fixture();
    let calls = 0;
    const db = injectBatch(
      (sql) => sql.includes("committed_at="),
      async () => {
        calls++;
        throw new Error("lost_ack");
      },
      true,
    );
    await f.run(action, f.app({ db }));
    expect(calls).toBe(1);
    expect(await f.receipts()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    expect(await f.rows()).toHaveLength(action === "create" ? 2 : 1);
  },
);

it.each(actions)("rechecks current authority after %s waited for capacity", async (action) => {
  const f = await fixture();
  await expect(
    f.run(
      action,
      f.app({
        acquire: async (r) => {
          const ticket = await acquireMutation(r);
          if (action === "rotate")
            await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
              .bind(Date.now(), f.credential.id)
              .run();
          else
            await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
              .bind(Date.now(), f.f.ids.session)
              .run();
          return ticket;
        },
      }),
    ),
  ).rejects.toThrow();
  expect(await f.receipts()).toEqual([{ state: "active", committed_at: null }]);
  expect(await f.rows()).toHaveLength(1);
  if (action === "revoke") expect((await f.rows())[0]!.revoked_at).toBeNull();
  if (action === "rotate") expect((await f.rows())[0]!.kid).toBe("v1");
});

for (const change of ["stop", "epoch"] as const)
  it.each(actions)(`does not commit %s after ${change}`, async (action) => {
    const f = await fixture();
    const before = await f.rows();
    await expect(
      f.run(
        action,
        f.app({
          acquire: async (r) => {
            const ticket = await acquireMutation(r);
            await env.DB.prepare(
              change === "stop" ? "UPDATE control SET maintenance=1" : "UPDATE control SET epoch=2",
            ).run();
            return ticket;
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toEqual([{ state: "closed", committed_at: null }]);
  });

it.each(actions)(
  "rolls back %s completely if its commit receipt cannot be written",
  async (action) => {
    const f = await fixture();
    const before = await f.rows();
    await env.DB.prepare(
      "CREATE TRIGGER fixture_reject_commit BEFORE UPDATE OF committed_at ON mutation_admissions WHEN NEW.committed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt_failed'); END",
    ).run();
    try {
      await expect(f.run(action)).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(await f.receipts()).toEqual([{ state: "active", committed_at: null }]);
      expect(
        (
          await env.DB.prepare("SELECT scope FROM credential_scopes WHERE credential_id=?")
            .bind(f.credential.credentialId)
            .all()
        ).results,
      ).toEqual([{ scope: "node:read" }]);
    } finally {
      await env.DB.prepare("DROP TRIGGER fixture_reject_commit").run();
    }
  },
);

it("rechecks a scoped root after waiting", async () => {
  const f = await fixture();
  await expect(
    f.run(
      "create",
      f.app({
        acquire: async (r) => {
          const ticket = await acquireMutation(r);
          await env.DB.prepare("UPDATE nodes SET deleted_at=? WHERE id=?")
            .bind(Date.now(), f.f.ids.folder)
            .run();
          return ticket;
        },
      }),
    ),
  ).rejects.toThrow();
  expect(await f.rows()).toHaveLength(1);
  expect((await f.receipts())[0]!.committed_at).toBeNull();
});

it("rechecks the 20-password limit after waiting", async () => {
  const f = await fixture();
  await expect(
    f.run(
      "create",
      f.app({
        acquire: async (r) => {
          const ticket = await acquireMutation(r);
          await atomicBatch(
            env.DB,
            Array.from({ length: 19 }, (_, i) => ({
              sql: "INSERT INTO app_passwords(id,user_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at) VALUES(?,?,'concurrent','digest','salt','PBKDF2-SHA256','{\"iterations\":100000}','v1',?,?)",
              values: [
                `concurrent_${crypto.randomUUID()}_${i}`,
                f.f.ids.user,
                Date.now(),
                Date.now() + 60000,
              ],
            })),
          );
          return ticket;
        },
      }),
    ),
  ).rejects.toThrow();
  expect(await f.rows()).toHaveLength(20);
  expect((await f.receipts())[0]!.committed_at).toBeNull();
});

it("rejects another owner's credential before requesting a shared grant", async () => {
  const f = await fixture(),
    other = await fixture();
  let calls = 0;
  await expect(
    revokeAppPassword(
      f.app({
        acquire: async () => {
          calls++;
          throw new Error("must_not_admit");
        },
      }),
      f.session,
      other.credential.credentialId,
    ),
  ).rejects.toThrow("app_password_not_found");
  expect(calls).toBe(0);
  expect((await other.rows())[0]!.revoked_at).toBeNull();
});

it("does not treat a concurrent rotation as this invocation's commit or release its unknown slot", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("committed_at="),
    async () => {
      await f.run("rotate");
      throw new Error("not_dispatched");
    },
    false,
  );
  // Authentication is still valid after independently verifying the current record and secret.
  expect(await f.run("rotate", f.app({ db }))).toMatchObject({
    credential_id: f.credential.credentialId,
  });
  expect(await f.receipts()).toEqual([
    { state: "active", committed_at: null },
    { state: "closed", committed_at: expect.any(Number) },
  ]);
});

it.each(["create", "revoke"] as const)(
  "does not replay %s after losing both acknowledgement and receipt readback",
  async (action) => {
    const f = await fixture();
    let calls = 0;
    const injected = injectBatch(
      (sql) => sql.includes("committed_at="),
      async () => {
        calls++;
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
    await expect(f.run(action, f.app({ db }))).rejects.toThrow("readback_lost");
    expect(calls).toBe(1);
    expect(await f.receipts()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
    expect(await f.rows()).toHaveLength(action === "create" ? 2 : 1);
  },
);

it("fails closed if the mandatory ControlDO mutation RPC is missing", async () => {
  const f = await fixture();
  const app = f.app();
  app.CONTROL = {
    idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
    get: () => ({}),
  } as unknown as Env["CONTROL"];
  await expect(f.run("create", app)).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.rows()).toHaveLength(1);
});

it("rejects a live ticket for another owner's space in the commit batch", async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    f.run(
      "create",
      f.app({ acquire: (request) => acquireMutation({ ...request, spaceId: other.f.ids.space }) }),
    ),
  ).rejects.toThrow();
  expect(await f.rows()).toHaveLength(1);
  expect(await f.receipts()).toEqual([]);
  expect(await other.receipts()).toEqual([{ state: "active", committed_at: null }]);
});
