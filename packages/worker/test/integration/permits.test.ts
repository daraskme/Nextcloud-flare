import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  assertOpenPermit,
  type Permit,
  releasePermit,
  revokeSpacePermits,
} from "../../src/db/permits";
import { assertExists, atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";
import { grantPermit } from "../fixtures/mutationAdmission";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  return f;
}
async function operation(
  f: Awaited<ReturnType<typeof fixture>>,
  permit: Permit,
  state = "claimed",
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,
    permit_id,permit_expires_at,claimed_expires_at,expected_steps,created_at,updated_at)
    VALUES(?,'user',?,?,?,'node.create',?,'digest',?,?,?,?,0,?,?)`)
    .bind(
      id,
      f.ids.user,
      f.ids.credential,
      f.ids.space,
      state,
      permit.epoch,
      permit.permit_id,
      permit.expires_at,
      permit.expires_at,
      Date.now(),
      Date.now(),
    )
    .run();
  return id;
}

it("admits at most one permit per space under a race and never extends a retried lease", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    ["a", "b"].map((id) => grantPermit(env.DB, `${f.ids.user}-${id}`, f.ids.space, 1)),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = results.find((result) => result.status === "fulfilled");
  if (winner?.status !== "fulfilled") throw new Error("missing_grant");
  expect(await grantPermit(env.DB, winner.value.permit_id, f.ids.space, 1)).toEqual(winner.value);
  await atomicBatch(env.DB, [assertOpenPermit(winner.value)]);
  await releasePermit(env.DB, winner.value);
  await releasePermit(env.DB, winner.value);
  await expect(grantPermit(env.DB, winner.value.permit_id, f.ids.space, 1)).rejects.toThrow();
  await expect(grantPermit(env.DB, `${f.ids.user}-next`, f.ids.space, 1)).resolves.toBeDefined();
});

it("reconciles a grant response lost after D1 commit using the same durable request id", async () => {
  const f = await fixture();
  const lossy = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.batch(statements);
      throw new Error("response_lost");
    },
  } as unknown as D1Database;
  const permit = await grantPermit(lossy, f.ids.user, f.ids.space, 1);
  expect(permit.permit_id).toBe(f.ids.user);
  expect(await grantPermit(env.DB, f.ids.user, f.ids.space, 1)).toEqual(permit);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM permits WHERE space_id=? AND state='open'")
      .bind(f.ids.space)
      .first("n"),
  ).toBe(1);
});

it("revokes an expired-open permit and fails only its claimed operations before issuing the successor", async () => {
  const f = await fixture();
  const old: Permit = {
    permit_id: `old-${f.ids.user}`,
    space_id: f.ids.space,
    epoch: 1,
    expires_at: Date.now() - 5000,
  };
  await env.DB.prepare("INSERT INTO permits VALUES(?,?,?,?,'open')")
    .bind(old.permit_id, old.space_id, old.epoch, old.expires_at)
    .run();
  const claimed = await operation(f, old);
  const terminal = await operation(f, old, "committed");
  const next = await grantPermit(env.DB, `new-${f.ids.user}`, f.ids.space, 1);
  expect(next.permit_id).not.toBe(old.permit_id);
  expect(
    await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
      .bind(old.permit_id)
      .first("state"),
  ).toBe("revoked");
  expect(
    await env.DB.prepare("SELECT state FROM operations WHERE op_id=?").bind(claimed).first("state"),
  ).toBe("failed");
  expect(
    await env.DB.prepare("SELECT state FROM operations WHERE op_id=?")
      .bind(terminal)
      .first("state"),
  ).toBe("committed");
  await expect(
    atomicBatch(env.DB, [
      { sql: "UPDATE nodes SET name='late' WHERE id=?", values: [f.ids.file] },
      assertOpenPermit(old),
    ]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(f.ids.file).first("name"),
  ).toBe("File");
});

it("refuses normal release with unfinished claims; maintenance revoke closes both atomically", async () => {
  const f = await fixture();
  const permit = await grantPermit(env.DB, f.ids.user, f.ids.space, 1);
  const claimed = await operation(f, permit);
  await expect(releasePermit(env.DB, permit)).rejects.toThrow();
  await expect(revokeSpacePermits(env.DB, f.ids.space, 1)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await revokeSpacePermits(env.DB, f.ids.space, 1);
  await revokeSpacePermits(env.DB, f.ids.space, 1);
  expect(
    await env.DB.prepare("SELECT state FROM operations WHERE op_id=?").bind(claimed).first("state"),
  ).toBe("failed");
  await releasePermit(env.DB, permit);
  await expect(atomicBatch(env.DB, [assertOpenPermit(permit)])).rejects.toThrow();
});

it.each(["maintenance", "old-epoch", "wrong-space", "wrong-expiry", "released"])(
  "rejects the %s commit fence",
  async (condition) => {
    const f = await fixture();
    const permit = await grantPermit(env.DB, f.ids.user, f.ids.space, 1);
    if (condition === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (condition === "old-epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    if (condition === "released") await releasePermit(env.DB, permit);
    const candidate =
      condition === "wrong-space"
        ? { ...permit, space_id: "elsewhere" }
        : condition === "wrong-expiry"
          ? { ...permit, expires_at: permit.expires_at + 1 }
          : permit;
    await expect(atomicBatch(env.DB, [assertOpenPermit(candidate)])).rejects.toThrow();
  },
);

it("protects permit identity and requires closed admission before recovery", async () => {
  const f = await fixture();
  const permit = await grantPermit(env.DB, f.ids.user, f.ids.space, 1);
  await expect(
    grantPermit(env.DB, f.ids.user, f.ids.space, 1, undefined, [assertExists("SELECT 1 WHERE 0")]),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE permits SET expires_at=expires_at+1 WHERE permit_id=?")
      .bind(permit.permit_id)
      .run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE permits SET epoch=2 WHERE permit_id=?").bind(permit.permit_id).run(),
  ).rejects.toThrow();
  await expect(grantPermit(env.DB, "oversized", f.ids.space, 1, 30_001)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(grantPermit(env.DB, "closed", f.ids.space, 1)).rejects.toThrow();
});
