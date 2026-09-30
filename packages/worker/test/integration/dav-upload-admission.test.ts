import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { SystemMutationAdmission } from "../../src/db/mutationAdmission";
import { recordStoredDavUpload, settleFailedDavUpload } from "../../src/services/davUpload";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { davUploadHistory as history } from "../fixtures/davUploadHistory";
import { acquireSystemMutation, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
type Kind = "stored" | "failed";
async function fixture(kind: Kind) {
  const f = await history({
    state: kind === "stored" ? "receiving" : "completing",
    present: true,
    expired: false,
    operationState: "failed",
  });
  const run = (source: SystemMutationSource = mutationEnv()) =>
    kind === "stored"
      ? recordStoredDavUpload(source, f.row, { object: f.object!, sha256: "a".repeat(64) })
      : settleFailedDavUpload(source, f.row);
  const configure = (
    effect?: (a: SystemMutationAdmission) => Promise<void>,
    unavailable = false,
  ): SystemMutationSource => ({
    DB: env.DB,
    systemControl: {
      status: () => mutationEnv().CONTROL.get(env.CONTROL.idFromName("fixture")).status(),
      acquireSystemMutation: async (request) => {
        if (unavailable) throw new Error("full");
        const a = await acquireSystemMutation(request);
        await effect?.(a);
        return a;
      },
    },
  });
  return { ...f, run, configure };
}
it.each(["stored", "failed"] as const)(
  "does not bypass unavailable DAV %s admission",
  async (kind) => {
    const f = await fixture(kind);
    await expect(f.run(f.configure(undefined, true))).rejects.toThrow("mutation_unavailable");
    expect(await f.counters()).toEqual({
      reserved_bytes: 3,
      physical_bytes: kind === "stored" ? 0 : 3,
    });
  },
);
it.each(
  (["stored", "failed"] as const).flatMap((kind) =>
    (["epoch", "mode", "receipt", "reservation-operation", "operation-step"] as const).map(
      (change) => ({ kind, change }),
    ),
  ),
)("rechecks $change when DAV $kind admission waits", async ({ kind, change }) => {
  const f = await fixture(kind);
  let changed = false;
  await expect(
    f.run(
      f.configure(async (a) => {
        if (change === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
        if (change === "mode") await env.DB.prepare("UPDATE control SET maintenance=1").run();
        if (change === "receipt")
          await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
            .bind(a.id)
            .run();
        if (change === "reservation-operation")
          await env.DB.prepare("UPDATE reservations SET op_id=NULL WHERE id=?")
            .bind(f.reservation)
            .run();
        if (change === "operation-step")
          await env.DB.prepare(
            "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,1,'node',?)",
          )
            .bind(f.operationId, f.ids.file)
            .run();
        changed = true;
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.counters()).toEqual({
    reserved_bytes: 3,
    physical_bytes: kind === "stored" ? 0 : 3,
  });
});
it.each(["stored", "failed"] as const)(
  "can record DAV %s storage facts after the owner is disabled",
  async (kind) => {
    const f = await fixture(kind);
    await env.DB.prepare("UPDATE users SET disabled_at=1 WHERE id=?").bind(f.ids.user).run();
    await f.run();
    expect(await f.counters()).toEqual({
      reserved_bytes: kind === "stored" ? 3 : 0,
      physical_bytes: 3,
    });
  },
);
it("refuses a failed DAV reservation refund without recorded physical bytes", async () => {
  const f = await history({ state: "completing", expired: false });
  await expect(settleFailedDavUpload(mutationEnv(), f.row)).rejects.toThrow();
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
});
it("does not use a failed operation to refund a DAV body that may still be writing", async () => {
  const f = await history({ state: "receiving", operationState: "failed", expired: false });
  await settleFailedDavUpload(mutationEnv(), f.row);
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 0 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=?")
      .bind(f.ids.space)
      .first("n"),
  ).toBe(0);
});

it("does not create a GC handoff underneath another live DAV cleanup claim", async () => {
  const f = await fixture("failed");
  await expect(
    f.run(
      f.configure(async () => {
        await env.DB.prepare(
          "UPDATE uploads SET state='failed',cleanup_pending=1,cleanup_token=?,cleanup_lease_expires_at=? WHERE id=?",
        )
          .bind(crypto.randomUUID(), Date.now() + 60000, f.id)
          .run();
        await env.DB.prepare("UPDATE blobs SET state='orphan' WHERE id=?").bind(f.blob).run();
      }),
    ),
  ).rejects.toThrow();
  expect(await f.counters()).toEqual({ reserved_bytes: 3, physical_bytes: 3 });
  expect(
    await env.DB.prepare("SELECT blob_id FROM gc_candidates WHERE blob_id=?").bind(f.blob).first(),
  ).toBeNull();
});
