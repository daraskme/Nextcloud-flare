import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleAccountHttp } from "../../src/api/account";
import { handlePrivateAppHttp, type PrivateAppDependencies } from "../../src/api/privateApp";
import {
  accessFingerprint,
  registerAccessSession,
  revokeAccessSession,
} from "../../src/auth/sessions";
import type { MutationRequest } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import type { Env } from "../../src/env";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { accessFixture } from "../fixtures/access";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,bootstrap_done_at=strftime('%s','now')*1000",
  ).run();
});
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const iat = Math.floor(Date.now() / 1000) - 1;
  const claims = { iss: "https://access.invalid", sub: f.ids.user, iat, exp: iat + 3600 };
  const session = await registerAccessSession(mutationEnv(), claims, 1);
  const next = { ...claims, iat: iat - 1 };
  const baseline = await env.DB.prepare(
    "SELECT MAX(seq) AS n FROM mutation_admissions",
  ).first<number>("n");
  const app = (acquire = (r: MutationRequest) => acquireMutation(r), db = env.DB): Env => ({
    ...mutationEnv(db),
    APP_ORIGIN: "https://app.invalid",
    CONTENT_ORIGIN: "https://content.invalid",
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({ acquireMutation: acquire }),
    } as unknown as Env["CONTROL"],
  });
  const run = (action: "register" | "logout", configured = app()) =>
    action === "register"
      ? registerAccessSession(configured, next, 1)
      : revokeAccessSession(configured, session.credential_id, 1);
  const rows = () =>
    env.DB.prepare(
      "SELECT state,committed_at FROM mutation_admissions WHERE seq>? AND space_id=? ORDER BY seq",
    )
      .bind(baseline, f.ids.space)
      .all()
      .then((r) => r.results);
  const sessions = () =>
    env.DB.prepare("SELECT id,revoked_at FROM sessions WHERE user_id=? ORDER BY id")
      .bind(f.ids.user)
      .all()
      .then((r) => r.results);
  return { f, claims, next, session, app, run, rows, sessions };
}
const actions = ["register", "logout"] as const;
it.each(actions)(
  "commits %s and its exact receipt atomically and releases capacity",
  async (action) => {
    const f = await fixture();
    await f.run(action);
    expect(await f.rows()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
  },
);
it.each(actions)("rejects overloaded %s before any domain write", async (action) => {
  const f = await fixture(),
    before = await f.sessions();
  await expect(
    f.run(
      action,
      f.app(async () => {
        throw new Error("full");
      }),
    ),
  ).rejects.toBeInstanceOf(MutationUnavailableError);
  expect(await f.sessions()).toEqual(before);
  expect(await f.rows()).toEqual([]);
});
it.each(actions)(
  "reconciles %s after a lost committed batch response without redispatch",
  async (action) => {
    const f = await fixture();
    let count = 0;
    const db = injectBatch(
      (sql) => sql.includes("committed_at="),
      async () => {
        count++;
        throw new Error("lost_ack");
      },
      true,
    );
    await f.run(action, f.app(undefined, db));
    expect(count).toBe(1);
    expect(await f.rows()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
  },
);
it.each(actions)(
  "rolls back %s when receipt persistence fails and keeps the uncertain slot",
  async (action) => {
    const f = await fixture(),
      before = await f.sessions();
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.batch([...statements, env.DB.prepare("INSERT INTO _assert(v) VALUES(1)")]);
      },
    } as unknown as D1Database;
    await expect(f.run(action, f.app(undefined, db))).rejects.toThrow();
    expect(await f.sessions()).toEqual(before);
    expect(await f.rows()).toEqual([{ state: "active", committed_at: null }]);
  },
);
it.each(actions)("fences %s if maintenance starts after admission", async (action) => {
  const f = await fixture(),
    before = await f.sessions();
  await expect(
    f.run(
      action,
      f.app(async (r) => {
        const grant = await acquireMutation(r);
        await env.DB.prepare("UPDATE control SET maintenance=1").run();
        return grant;
      }),
    ),
  ).rejects.toThrow();
  expect(await f.sessions()).toEqual(before);
  expect(await f.rows()).toEqual([{ state: "closed", committed_at: null }]);
});
it.each(actions)("cannot use another owner space to commit %s", async (action) => {
  const f = await fixture(),
    other = await fixture(),
    before = await f.sessions();
  await expect(
    f.run(
      action,
      f.app((r) => acquireMutation({ ...r, spaceId: other.f.ids.space })),
    ),
  ).rejects.toThrow();
  expect(await f.sessions()).toEqual(before);
});
it("existing JWT login performs no batch or admission and checks current maintenance", async () => {
  const f = await fixture();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async () => {
      throw new Error("unexpected_write");
    },
  } as unknown as D1Database;
  const configured = f.app(async () => {
    throw new Error("unexpected_admission");
  }, db);
  expect(await registerAccessSession(configured, f.claims, 1)).toEqual(f.session);
  expect(await f.rows()).toEqual([]);
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(registerAccessSession(configured, f.claims, 1)).rejects.toThrow(
    "credential_inactive",
  );
});
it.each(["revoked", "disabled", "expired", "missing-credential", "epoch"])(
  "read-only login cannot revive a %s fingerprint",
  async (condition) => {
    const f = await fixture();
    if (condition === "revoked")
      await revokeAccessSession(mutationEnv(), f.session.credential_id, 1);
    if (condition === "disabled") {
      await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.f.ids.user).run();
      await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.f.ids.user).run();
    }
    if (condition === "expired")
      await env.DB.prepare("UPDATE sessions SET expires_at=issued_at+1 WHERE id=?")
        .bind(f.session.session_id)
        .run();
    if (condition === "missing-credential")
      await env.DB.prepare("DELETE FROM credentials WHERE id=?")
        .bind(f.session.credential_id)
        .run();
    if (condition === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    const before = await f.rows();
    await expect(
      registerAccessSession(
        f.app(async () => {
          throw new Error("unexpected_admission");
        }),
        f.claims,
        1,
      ),
    ).rejects.toThrow("credential_inactive");
    expect(await f.rows()).toEqual(before);
  },
);
it("rechecks user identity after registration waits for capacity", async () => {
  const f = await fixture();
  const configured = f.app(async (r) => {
    const a = await acquireMutation(r);
    await env.DB.prepare("UPDATE users SET access_sub=? WHERE id=?")
      .bind("changed", f.f.ids.user)
      .run();
    return a;
  });
  await expect(f.run("register", configured)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT 1 FROM sessions WHERE fingerprint=?")
      .bind(await accessFingerprint(f.next))
      .first(),
  ).toBeNull();
  expect(await f.rows()).toEqual([{ state: "active", committed_at: null }]);
});
it("preserves idempotent service logout even when the user was disabled", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE users SET role='member' WHERE id=?").bind(f.f.ids.user).run();
  await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.f.ids.user).run();
  await f.run("logout");
  await f.run("logout");
  expect(await f.rows()).toEqual(
    Array.from({ length: 2 }, () => ({ state: "closed", committed_at: expect.any(Number) })),
  );
});
it("returns retryable HTTP 503 for registration and logout overload without an authentication challenge", async () => {
  const f = await fixture();
  const access = await accessFixture();
  const app = f.app(async () => {
    throw new Error("full");
  });
  const request = await access.sign({ ...f.next });
  const login = await handlePrivateAppHttp(request, app, 1, {
    verifier: access.verifier,
    bootstrap: { ownerEmails: [], ownerIdentities: [], quotaBytes: 1 },
  } as unknown as PrivateAppDependencies);
  const logout = await handleAccountHttp(
    new Request("https://app.invalid/api/v1/auth/logout", { method: "POST" }),
    app,
    f.session,
    { verify: async () => {} },
  );
  for (const response of [login, logout]) {
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
  }
  expect(await f.rows()).toEqual([]);
});
