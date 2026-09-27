import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertExists } from "../../src/db/primary";
import type { R2WriteGrant, R2WriteRequest, R2WriteTerminal } from "../../src/db/r2Write";
import { inspectRecoveryFinalFence } from "../../src/do/recoveryAudit";
import type { Env } from "../../src/env";
import {
  type BindingVerificationScope,
  withVerifiedR2Inventory,
} from "../../src/jobs/r2BindingVerification";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { inventoryEnv } from "../fixtures/s3Inventory";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const app = mutationEnv();
  const original = app.CONTROL.get(app.CONTROL.idFromName("fixture"));
  let request!: R2WriteRequest;
  let grant!: R2WriteGrant;
  let before = async (_r: R2WriteRequest) => {};
  let after = async (_g: R2WriteGrant) => {};
  let native = (...args: Parameters<R2Bucket["put"]>) => env.BLOBS.put(...args);
  const ended = deferred();
  app.CONTROL = {
    idFromName: (name: string) => env.CONTROL.idFromName(name),
    get: () => ({
      ...original,
      beginR2Write: async (r: R2WriteRequest) => {
        request = r;
        await before(r);
        grant = await original.beginR2Write(r);
        await after(grant);
        return grant;
      },
      finishR2Write: async (g: R2WriteGrant, outcome: R2WriteTerminal) => {
        await original.finishR2Write(g, outcome);
        ended.resolve();
      },
    }),
  } as unknown as Env["CONTROL"];
  const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
    expect(await receipt()).toMatchObject({ state: "pending", owner_id: null, kind: "probe.put" });
    return native(...args);
  });
  const fetch = vi.fn(async () => {
    const object = await env.BLOBS.get(BINDING_PROBE_KEY);
    return object ? new Response(object.body) : new Response(null, { status: 404 });
  });
  const action = vi.fn(async () => "verified");
  const receipt = () =>
    env.DB.prepare("SELECT * FROM r2_write_attempts WHERE id=?").bind(request.id).first();
  return {
    app,
    put,
    fetch,
    action,
    receipt,
    ended,
    request: () => request,
    grant: () => grant,
    before: (hook: typeof before) => {
      before = hook;
    },
    after: (hook: typeof after) => {
      after = hook;
    },
    native: (hook: typeof native) => {
      native = hook;
    },
    run: (scope?: BindingVerificationScope) =>
      withVerifiedR2Inventory(
        app,
        {
          get: (...args: Parameters<R2Bucket["get"]>) => env.BLOBS.get(...args),
          put,
        } as unknown as R2Bucket,
        new R2S3Inventory(inventoryEnv, { fetch }),
        1,
        action,
        scope,
      ),
  };
}
it("records native success before S3 verification and refuses a second dispatch for the same challenge", async () => {
  const f = fixture();
  expect(await f.run()).toBe("verified");
  expect(await f.receipt()).toMatchObject({
    state: "succeeded",
    source_ref: JSON.stringify([1, f.request().probe!.token, f.request().probe!.nonce]),
  });
  expect(f.put).toHaveBeenCalledOnce();
  const control = mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture"));
  await expect(
    control.beginR2Write({ ...f.request(), id: crypto.randomUUID(), deadline: Date.now() + 5000 }),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM r2_write_attempts WHERE state='pending'").first(
      "n",
    ),
  ).toBe(0);
});
it("retains native ACK loss through expiry, a fresh successful probe, freeze and resume attempts", async () => {
  const f = fixture();
  f.native(async (...args) => {
    await env.BLOBS.put(...args);
    throw new Error("lost_native_ack");
  });
  await expect(f.run()).rejects.toThrow("r2_binding_verification_failed");
  expect(await f.receipt()).toMatchObject({ state: "pending" });
  expect(f.fetch).not.toHaveBeenCalled();
  await env.DB.prepare("UPDATE r2_binding_probe SET lease_expires_at=1").run();
  expect(await fixture().run()).toBe("verified");
  expect(await f.receipt()).toMatchObject({ state: "pending" });
  await expect(inspectRecoveryFinalFence(env.DB, 1)).rejects.toThrow(
    /recovery_final_fence_pending/,
  );
  await expect(env.DB.prepare("UPDATE control SET maintenance=0").run()).rejects.toThrow(
    /r2_write_unsettled/,
  );
  await expect(
    env.DB.prepare("UPDATE control SET restore_freeze_token=?").bind(crypto.randomUUID()).run(),
  ).rejects.toThrow(/restore_freeze_not_drained/);
});
it.each(["lease", "maintenance", "gc_paused", "phase"])(
  "rechecks %s after the original probe budget ACK",
  async (field) => {
    const f = fixture();
    f.before(async () => {
      await env.DB.prepare(
        field === "lease"
          ? "UPDATE r2_binding_probe SET lease_expires_at=1"
          : field === "phase"
            ? "UPDATE r2_binding_probe SET phase='failed'"
            : `UPDATE control SET ${field}=0`,
      ).run();
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.put).not.toHaveBeenCalled();
    expect(await f.receipt()).toMatchObject({ state: "not_started" });
  },
);
it.each(["token", "nonce", "source", "expectedEtag"] as const)(
  "requires the original %s in the grant batch",
  async (field) => {
    const f = fixture();
    f.before(async (request) => {
      request.probe![field] =
        field === "token"
          ? crypto.randomUUID()
          : field === "nonce"
            ? "e".repeat(64)
            : field === "source"
              ? "{}"
              : "wrong-etag";
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.put).not.toHaveBeenCalled();
    expect(await f.receipt()).toMatchObject({ state: "not_started" });
  },
);
it("retains a lost grant reply without dispatching or inferring never-started from the probe row", async () => {
  const f = fixture();
  f.after(async () => {
    throw new Error("lost_grant_ack");
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.put).not.toHaveBeenCalled();
  expect(await f.receipt()).toMatchObject({ state: "pending" });
});
it("records a conclusive never-dispatched grant when its synchronous scope check closes", async () => {
  const f = fixture();
  let open = true;
  f.after(async () => {
    open = false;
  });
  await env.DB.prepare(
    "UPDATE control SET admission_revision=admission_revision+1,admission_token=?",
  )
    .bind(crypto.randomUUID())
    .run();
  const c = await env.DB.prepare(
    "SELECT admission_revision revision,admission_token token FROM control",
  ).first<{ revision: number; token: string }>();
  await expect(
    f.run({
      stop: { ...c!, expiresAt: Date.now() + 25000 },
      current: () => {
        if (!open) throw new Error("database_restore_scope_closed");
      },
      fence: () => assertExists("SELECT 1"),
    }),
  ).rejects.toThrow("database_restore_scope_closed");
  expect(f.put).not.toHaveBeenCalled();
  expect(await f.receipt()).toMatchObject({ state: "not_started" });
});
it("refuses dispatch when its grant expires during the synchronous scope check", async () => {
  const f = fixture();
  await env.DB.prepare(
    "UPDATE control SET admission_revision=admission_revision+1,admission_token=?",
  )
    .bind(crypto.randomUUID())
    .run();
  const c = await env.DB.prepare(
    "SELECT admission_revision revision,admission_token token FROM control",
  ).first<{ revision: number; token: string }>();
  let shifted = false;
  await expect(
    f.run({
      stop: { ...c!, expiresAt: Date.now() + 25000 },
      current: () => {
        if (f.grant() && !shifted) {
          shifted = true;
          vi.spyOn(Date, "now").mockReturnValueOnce(f.grant().deadline);
        }
      },
      fence: () => assertExists("SELECT 1"),
    }),
  ).rejects.toThrow();
  expect(f.put).not.toHaveBeenCalled();
  expect(await f.receipt()).toMatchObject({ state: "not_started" });
});
it("rechecks the restore stop revision in the final grant batch", async () => {
  const f = fixture();
  await env.DB.prepare(
    "UPDATE control SET admission_revision=admission_revision+1,admission_token=?",
  )
    .bind(crypto.randomUUID())
    .run();
  const c = await env.DB.prepare(
    "SELECT admission_revision revision,admission_token token FROM control",
  ).first<{ revision: number; token: string }>();
  f.before(async () => {
    await env.DB.prepare("UPDATE control SET admission_revision=admission_revision+1").run();
  });
  await expect(
    f.run({
      stop: { ...c!, expiresAt: Date.now() + 25000 },
      current: () => {},
      fence: () => assertExists("SELECT 1"),
    }),
  ).rejects.toThrow();
  expect(f.put).not.toHaveBeenCalled();
  expect(await f.receipt()).toMatchObject({ state: "not_started" });
});
it.each([false, true])(
  "settles a late actual PUT after the caller's timeout without granting late verification (scoped=%s)",
  async (scoped) => {
    const f = fixture(),
      entered = deferred(),
      release = deferred();
    f.native(async (...args) => {
      entered.resolve();
      await release.promise;
      return env.BLOBS.put(...args);
    });
    const duration = scoped ? 8000 : 25000;
    let scope: BindingVerificationScope | undefined;
    if (scoped) {
      await env.DB.prepare(
        "UPDATE control SET admission_revision=admission_revision+1,admission_token=?",
      )
        .bind(crypto.randomUUID())
        .run();
      const c = await env.DB.prepare(
        "SELECT admission_revision revision,admission_token token FROM control",
      ).first<{ revision: number; token: string }>();
      scope = {
        stop: { ...c!, expiresAt: Date.now() + duration },
        current: () => {},
        fence: () => assertExists("SELECT 1"),
      };
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = expect(f.run(scope)).rejects.toThrow("r2_binding_verification_failed");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(duration);
      await result;
      expect(await f.receipt()).toMatchObject({ state: "pending" });
      release.resolve();
      await f.ended.promise;
      expect(await f.receipt()).toMatchObject({ state: "succeeded" });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.action).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT phase FROM r2_binding_probe").first("phase")).toBe(
        "failed",
      );
    } finally {
      release.resolve();
    }
  },
);
