import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleAppPasswordHttp } from "../../src/api/appPasswords";
import { handleDavHttp } from "../../src/api/dav";
import {
  appPasswordPepperRing,
  authenticateAppPassword,
  hashAppPassword,
} from "../../src/auth/appPassword";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import * as kdf from "../../src/auth/kdf";
import { KDF_QUEUE_LIMIT, KdfUnavailableError, runKdf } from "../../src/auth/kdf";
import type { AccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { createAppPassword } from "../../src/services/appPasswords";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());
const key = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const session: AccessSession = {
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    session_id: f.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600_000,
  };
  const ring = await appPasswordPepperRing("v1", { v1: key() });
  const credential = await createAppPassword(
    env.DB,
    session,
    { name: "KDF test", scopes: ["node:read"] },
    ring,
  );
  const app = {
    ...env,
    APP_ORIGIN: "https://app.invalid",
    EDGE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
  };
  const request = (signal?: AbortSignal) =>
    new Request("https://app.invalid/dav", {
      method: "OPTIONS",
      headers: { Authorization: `Basic ${btoa(`${credential.id}:${credential.secret}`)}` },
      ...(signal ? { signal } : {}),
    });
  return { f, session, ring, credential, app, request };
}
async function hold() {
  const entered = deferred(),
    released = deferred();
  const running = runKdf(async () => {
    entered.resolve();
    await released.promise;
  });
  await entered.promise;
  return { release: released.resolve, running };
}

it("runs concurrent real PBKDF2 calls one at a time and retains valid records", async () => {
  const f = await fixture();
  const native = crypto.subtle.deriveBits.bind(crypto.subtle);
  let active = 0,
    peak = 0;
  const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active);
    try {
      return await native(...args);
    } finally {
      active--;
    }
  });
  try {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? authenticateAppPassword(env.DB, f.request(), f.app.APP_ORIGIN, 1, f.ring)
        : hashAppPassword(key(), f.ring),
    );
    expect(await Promise.all(jobs)).toHaveLength(8);
    expect(spy).toHaveBeenCalledTimes(8);
    expect(peak).toBe(1);
    expect(active).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it("returns retryable DAV overload without challenging or invalidating a valid credential", async () => {
  const f = await fixture(),
    held = await hold(),
    abort = new AbortController();
  const waiting = Promise.allSettled(
    Array.from({ length: KDF_QUEUE_LIMIT }, () => runKdf(async () => undefined, abort.signal)),
  );
  try {
    const response = await handleDavHttp(f.request(), f.app, 1, f.ring);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  } finally {
    abort.abort();
    held.release();
    await held.running;
    await waiting;
  }
  expect((await handleDavHttp(f.request(), f.app, 1, f.ring)).status).toBe(200);
});

it("bounds private credential creation before any record is written and recovers after overload", async () => {
  const f = await fixture();
  const csrfRing = await csrfKeyRing("test", { test: key() });
  const csrf = new CsrfTokens(csrfRing, csrfRing, f.app.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request(`${f.app.APP_ORIGIN}/api/v1/csrf`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: f.session.credential_id, epoch: 1 },
  );
  const request = () =>
    new Request(`${f.app.APP_ORIGIN}/api/v1/app-passwords`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: f.app.APP_ORIGIN,
        "X-CSRF-Token": issued.token,
      },
      body: JSON.stringify({ name: "After capacity", scopes: ["node:read"] }),
    });
  const held = await hold(),
    abort = new AbortController();
  const waiting = Promise.allSettled(
    Array.from({ length: KDF_QUEUE_LIMIT }, () => runKdf(async () => undefined, abort.signal)),
  );
  try {
    const response = await handleAppPasswordHttp(request(), f.app, f.session, csrf, f.ring);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM app_passwords WHERE user_id=?")
        .bind(f.f.ids.user)
        .first("n"),
    ).toBe(1);
  } finally {
    abort.abort();
    held.release();
    await held.running;
    await waiting;
  }
  expect((await handleAppPasswordHttp(request(), f.app, f.session, csrf, f.ring)).status).toBe(201);
});

it("skips aborted crypto work and does not retain a cancelled caller's place", async () => {
  const f = await fixture(),
    held = await hold(),
    abort = new AbortController();
  const spy = vi.spyOn(crypto.subtle, "deriveBits");
  const attempt = authenticateAppPassword(
    env.DB,
    f.request(abort.signal),
    f.app.APP_ORIGIN,
    1,
    f.ring,
  );
  const rejected = expect(attempt).rejects.toBeInstanceOf(KdfUnavailableError);
  abort.abort();
  try {
    await rejected;
    expect(spy).not.toHaveBeenCalled();
  } finally {
    held.release();
    await held.running;
    spy.mockRestore();
  }
  expect(
    await authenticateAppPassword(env.DB, f.request(), f.app.APP_ORIGIN, 1, f.ring),
  ).toMatchObject({ credential_id: f.credential.credentialId });
});

it("checks current access and root authorization before spending KDF capacity on creation", async () => {
  const f = await fixture(),
    held = await hold();
  try {
    await expect(
      createAppPassword(
        env.DB,
        f.session,
        { name: "Bad root", scopes: ["node:read"], spaceId: f.f.ids.space, rootNodeId: "missing" },
        f.ring,
      ),
    ).rejects.toThrow("invalid_app_password_root");
    await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
      .bind(Date.now(), f.f.ids.session)
      .run();
    await expect(
      createAppPassword(env.DB, f.session, { name: "Revoked", scopes: ["node:read"] }, f.ring),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM app_passwords WHERE user_id=?")
        .bind(f.f.ids.user)
        .first("n"),
    ).toBe(1);
  } finally {
    held.release();
    await held.running;
  }
});

it.each(["revoked", "maintenance"])(
  "rechecks current authority after authentication waits for capacity (%s)",
  async (reason) => {
    const f = await fixture(),
      held = await hold(),
      queued = deferred();
    const original = kdf.runKdf;
    const spy = vi.spyOn(kdf, "runKdf").mockImplementation((action, signal) => {
      const result = original(action, signal);
      queued.resolve();
      return result;
    });
    const attempt = authenticateAppPassword(env.DB, f.request(), f.app.APP_ORIGIN, 1, f.ring);
    const rejection = expect(attempt).rejects.toThrow("app_password_denied");
    try {
      await queued.promise;
      if (reason === "revoked")
        await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?")
          .bind(Date.now(), f.credential.id)
          .run();
      else await env.DB.prepare("UPDATE control SET maintenance=1").run();
    } finally {
      spy.mockRestore();
      held.release();
      await held.running;
    }
    await rejection;
  },
);

it("does not write a credential when creation is cancelled in the queue", async () => {
  const f = await fixture(),
    held = await hold(),
    queued = deferred(),
    abort = new AbortController();
  const original = kdf.runKdf;
  const spy = vi.spyOn(kdf, "runKdf").mockImplementation((action, signal) => {
    const result = original(action, signal);
    queued.resolve();
    return result;
  });
  const attempt = createAppPassword(
    env.DB,
    f.session,
    { name: "Cancelled", scopes: ["node:read"] },
    f.ring,
    abort.signal,
  );
  const rejection = expect(attempt).rejects.toBeInstanceOf(KdfUnavailableError);
  try {
    await queued.promise;
    abort.abort();
    await rejection;
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM app_passwords WHERE user_id=?")
        .bind(f.f.ids.user)
        .first("n"),
    ).toBe(1);
  } finally {
    spy.mockRestore();
    abort.abort();
    held.release();
    await held.running;
  }
});

it("shares capacity across pepper verification, rotation and re-verification", async () => {
  const f = await fixture();
  const fresh = await appPasswordPepperRing("v2", { v2: key() });
  const ring = { activeKid: "v2", keys: new Map([...f.ring.keys, ...fresh.keys]) };
  const native = crypto.subtle.deriveBits.bind(crypto.subtle);
  let active = 0,
    peak = 0;
  const spy = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active);
    try {
      return await native(...args);
    } finally {
      active--;
    }
  });
  try {
    const [principal] = await Promise.all([
      authenticateAppPassword(env.DB, f.request(), f.app.APP_ORIGIN, 1, ring),
      hashAppPassword(key(), ring),
      hashAppPassword(key(), ring),
    ]);
    expect(principal).toMatchObject({ credential_id: f.credential.credentialId });
    expect(spy).toHaveBeenCalledTimes(5);
    expect(peak).toBe(1);
    expect(
      await env.DB.prepare("SELECT kid FROM app_passwords WHERE id=?")
        .bind(f.credential.id)
        .first("kid"),
    ).toBe("v2");
  } finally {
    spy.mockRestore();
  }
});
