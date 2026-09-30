import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GlobalMutationAdmission, MutationRequest } from "../../src/db/mutationAdmission";
import { withVerifiedR2Inventory } from "../../src/jobs/r2BindingVerification";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { R2S3Inventory } from "../../src/r2/s3Inventory";
import type { GlobalMutationSource } from "../../src/services/globalMutation";
import { acquireGlobalMutation } from "../fixtures/mutationAdmission";
import { inventoryEnv } from "../fixtures/s3Inventory";
import { systemMutationFault } from "../fixtures/systemMutationFault";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=1,gc_paused=1").run();
  await env.DB.prepare(
    "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
  ).run();
});
afterEach(() => vi.restoreAllMocks());
const stages = [
  { name: "claim", kind: "claim", nth: 1, calls: 0, direct: true },
  { name: "GET", kind: "call", nth: 1, calls: 0, direct: true },
  { name: "prepared", kind: "phase", nth: 1, calls: 1, direct: false },
  { name: "PUT", kind: "call", nth: 2, calls: 1, direct: true },
  { name: "written", kind: "phase", nth: 2, calls: 2, direct: false },
  { name: "S3", kind: "call", nth: 3, calls: 2, direct: true },
  { name: "verified", kind: "phase", nth: 3, calls: 3, direct: false },
  { name: "release", kind: "release", nth: 1, calls: 3, direct: false },
  { name: "error", kind: "error", nth: 1, calls: 3, direct: false },
] as const;
type Stage = (typeof stages)[number];
type Gate = (r: Omit<MutationRequest, "spaceId">) => Promise<GlobalMutationAdmission>;
const row = () =>
  env.DB.prepare(
    "SELECT phase,nonce,lease_token,lease_expires_at,allocated_bytes,last_error FROM r2_binding_probe",
  ).first<Record<string, unknown>>();
const receipt = (permit: string) =>
  env.DB.prepare(
    "SELECT state,committed_at,space_id,system,maintenance FROM mutation_admissions WHERE permit_id=?",
  )
    .bind(permit)
    .first();
function fixture(stage: Stage) {
  let calls = 0,
    permit = "",
    hits = 0;
  const prefix = `global:r2.probe-${stage.kind}:`;
  const get = vi.fn(async (...args: Parameters<R2Bucket["get"]>) => {
    calls++;
    return env.BLOBS.get(...args);
  });
  const put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
    calls++;
    return env.BLOBS.put(...args);
  });
  const inventory = new R2S3Inventory(inventoryEnv, {
    fetch: async () => {
      calls++;
      const probe = await env.BLOBS.get(BINDING_PROBE_KEY);
      return probe ? new Response(probe.body) : new Response(null, { status: 404 });
    },
  });
  const action = vi.fn(async () => {
    if (stage.name === "error") throw new Error("r2_binding_mismatch");
    return "verified";
  });
  const configure = (gate: Gate = acquireGlobalMutation, db = env.DB): GlobalMutationSource => ({
    DB: db,
    systemControl: {
      status: async () => ({
        epoch: (await env.DB.prepare("SELECT epoch FROM control").first<number>("epoch"))!,
        maintenance: true,
        gcPaused: true,
      }),
      acquireGlobalMutation: async (r) => {
        if (r.permitId.startsWith(prefix) && ++hits === stage.nth) {
          permit = r.permitId;
          return gate(r);
        }
        return acquireGlobalMutation(r);
      },
    },
  });
  const run = (source = configure()) =>
    withVerifiedR2Inventory(source, { get, put } as unknown as R2Bucket, inventory, 1, action);
  return { run, configure, action, prefix, calls: () => calls, permit: () => permit };
}
it.each(stages)("does not bypass unavailable $name admission", async (stage) => {
  const f = fixture(stage);
  await expect(
    f.run(
      f.configure(async () => {
        throw new Error("overload");
      }),
    ),
  ).rejects.toThrow();
  expect(f.calls()).toBe(stage.calls);
  expect(await receipt(f.permit())).toBeNull();
  if (stage.name !== "claim")
    expect(await row()).toMatchObject({ allocated_bytes: 64, lease_token: expect.any(String) });
});
it.each(stages)(
  "lost $name ACK recovers only DB facts, never an external dispatch",
  async (stage) => {
    const f = fixture(stage),
      fault = systemMutationFault(f.prefix, "ack", stage.nth);
    const result = f.run(f.configure(acquireGlobalMutation, fault.db));
    if (stage.direct || stage.name === "error") await expect(result).rejects.toThrow();
    else await expect(result).resolves.toBe("verified");
    expect(fault.fired()).toBe(true);
    expect(f.calls()).toBe(stage.direct ? stage.calls : 3);
    expect(fault.reads()).toBe(stage.direct ? 0 : 1);
    expect(await receipt(f.permit())).toMatchObject({
      state: "closed",
      committed_at: expect.any(Number),
      space_id: null,
      system: 1,
      maintenance: 1,
    });
    if (!stage.direct && stage.name !== "error")
      expect(await row()).toMatchObject({ phase: "idle", allocated_bytes: 64, lease_token: null });
  },
);
it.each(stages)("rollback of $name retains the exact unknown slot", async (stage) => {
  const f = fixture(stage),
    fault = systemMutationFault(f.prefix, "rollback", stage.nth);
  await expect(f.run(f.configure(acquireGlobalMutation, fault.db))).rejects.toThrow();
  expect(fault.fired()).toBe(true);
  expect(f.calls()).toBe(stage.calls);
  expect(await receipt(f.permit())).toMatchObject({
    state: "active",
    committed_at: null,
    space_id: null,
  });
});
it.each(stages)(
  "unreadable $name receipt cannot infer success from resource state",
  async (stage) => {
    const f = fixture(stage),
      fault = systemMutationFault(f.prefix, "reads", stage.nth);
    await expect(f.run(f.configure(acquireGlobalMutation, fault.db))).rejects.toThrow();
    expect(fault.fired()).toBe(true);
    expect(f.calls()).toBe(stage.calls);
    expect(fault.reads()).toBe(stage.direct ? 0 : stage.name === "release" ? 2 : 1);
    expect(await receipt(f.permit())).toMatchObject({
      state: "closed",
      committed_at: expect.any(Number),
    });
    if (stage.name === "release")
      expect(await row()).toMatchObject({ phase: "idle", lease_token: null, last_error: null });
  },
);
it.each(
  stages
    .filter((s) => ["GET", "prepared", "release"].includes(s.name))
    .flatMap((stage) => ["epoch", "maintenance", "gc_paused"].map((change) => ({ stage, change }))),
)("rechecks $change after waiting for $stage.name", async ({ stage, change }) => {
  const f = fixture(stage);
  const source = f.configure(async (r) => {
    const grant = await acquireGlobalMutation(r);
    await env.DB.prepare(`UPDATE control SET ${change}=${change === "epoch" ? 2 : 0}`).run();
    return grant;
  });
  await expect(f.run(source)).rejects.toThrow();
  expect(f.calls()).toBe(stage.calls);
  expect(await receipt(f.permit())).toMatchObject({ committed_at: null });
});
it.each(stages.filter((s) => ["GET", "PUT", "S3", "release"].includes(s.name)))(
  "rechecks the exact probe lease after waiting for $name",
  async (stage) => {
    const f = fixture(stage);
    await expect(
      f.run(
        f.configure(async (r) => {
          const grant = await acquireGlobalMutation(r);
          await env.DB.prepare(
            "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
          ).run();
          return grant;
        }),
      ),
    ).rejects.toThrow();
    expect(f.calls()).toBe(stage.calls);
    expect(await receipt(f.permit())).toMatchObject({ state: "active", committed_at: null });
  },
);
it.each(stages.filter((s) => s.direct))(
  "does not start $name after late admission",
  async (stage) => {
    const f = fixture(stage),
      now = Date.now();
    await expect(
      f.run(
        f.configure(async (r) => {
          const grant = await acquireGlobalMutation(r);
          vi.spyOn(Date, "now").mockReturnValue(now + 30000);
          return grant;
        }),
      ),
    ).rejects.toThrow();
    expect(f.calls()).toBe(stage.calls);
    expect(await receipt(f.permit())).toMatchObject({ state: "active", committed_at: null });
  },
);
it.each(stages.filter((s) => s.direct))(
  "does not dispatch $name after a late direct ACK",
  async (stage) => {
    const f = fixture(stage),
      now = Date.now();
    let permit = "";
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        const before = permit && (await receipt(permit));
        const result = await env.DB.batch(statements);
        if (
          before &&
          (before as { state: string }).state === "active" &&
          ((await receipt(permit)) as { state: string })?.state === "closed"
        )
          vi.spyOn(Date, "now").mockReturnValue(now + 30000);
        return result;
      },
    } as unknown as D1Database;
    await expect(
      f.run(
        f.configure(async (r) => {
          permit = r.permitId;
          return acquireGlobalMutation(r);
        }, db),
      ),
    ).rejects.toThrow();
    expect(f.calls()).toBe(stage.calls);
    expect(await receipt(f.permit())).toMatchObject({
      state: "closed",
      committed_at: expect.any(Number),
    });
  },
);
it("a replacement generation cannot be failed or released by the old verifier", async () => {
  const stage = stages.find((s) => s.name === "release")!,
    f = fixture(stage);
  let winner: Record<string, unknown> | null = null;
  await expect(
    f.run(
      f.configure(async (r) => {
        const grant = await acquireGlobalMutation(r);
        await env.DB.prepare(
          "UPDATE r2_binding_probe SET lease_expires_at=1 WHERE lease_token IS NOT NULL",
        ).run();
        await fixture(stage).run();
        winner = await row();
        return grant;
      }),
    ),
  ).rejects.toThrow();
  expect(winner).toMatchObject({ phase: "idle", lease_token: null });
  expect(await row()).toEqual(winner);
  expect(await receipt(f.permit())).toMatchObject({ state: "active", committed_at: null });
});
