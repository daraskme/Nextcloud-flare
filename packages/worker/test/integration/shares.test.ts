import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { createShare, disableShare, listShares, readShare } from "../../src/services/shares";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

async function fixture() {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [...owner.statements, ...other.statements]);
  const session = await readAccessSession(env.DB, owner.ids.credential, 1);
  const otherSession = await readAccessSession(env.DB, other.ids.credential, 1);
  if (!session || !otherSession) throw new Error("fixture_session_missing");
  return { owner, other, session, otherSession };
}

it("creates a one-time capability for an owner-authorized root and lists metadata only", async () => {
  const f = await fixture();
  const created = await createShare(mutationEnv(), f.session, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    ttlDays: 7,
  });
  expect(created).toMatchObject({
    rootNodeId: f.owner.ids.folder,
    version: 1,
    disabledAt: null,
    actions: ["read", "download"],
  });
  expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const stored = await env.DB.prepare("SELECT secret_digest FROM shares WHERE id=?")
    .bind(created.id)
    .first<string>("secret_digest");
  expect(stored).toBeTruthy();
  expect(stored).not.toBe(created.secret);
  expect(await listShares(env.DB, f.session)).toEqual([
    expect.objectContaining({ id: created.id, rootNodeId: f.owner.ids.folder }),
  ]);
  expect(await readShare(env.DB, f.session, created.id)).not.toHaveProperty("secret");
  await expect(readShare(env.DB, f.otherSession, created.id)).rejects.toThrow("share_not_found");
  await expect(
    createShare(mutationEnv(), f.session, {
      rootNodeId: f.other.ids.folder,
      spaceId: f.other.ids.space,
    }),
  ).rejects.toThrow("share_root_not_found");
});

it("disables idempotently, bumps the version once, and revokes derived state", async () => {
  const f = await fixture();
  const created = await createShare(mutationEnv(), f.session, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
  });
  const shareSessionId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO share_sessions(
        id,share_id,share_version,secret_digest,epoch,issued_at,expires_at
      ) VALUES(?,?,1,?,1,?,?)`,
      values: [shareSessionId, created.id, crypto.randomUUID(), Date.now(), Date.now() + 60_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [`ss:${shareSessionId}`, shareSessionId],
    },
  ]);
  await disableShare(mutationEnv(), f.session, created.id);
  await disableShare(mutationEnv(), f.session, created.id);
  expect(await readShare(env.DB, f.session, created.id)).toMatchObject({
    version: 2,
  });
  expect(
    await env.DB.prepare("SELECT disabled_at FROM shares WHERE id=?")
      .bind(created.id)
      .first("disabled_at"),
  ).not.toBeNull();
  expect(
    await env.DB.prepare("SELECT revoked_at FROM share_sessions WHERE id=?")
      .bind(shareSessionId)
      .first("revoked_at"),
  ).not.toBeNull();
  await expect(disableShare(mutationEnv(), f.otherSession, created.id)).rejects.toThrow(
    "share_not_found",
  );
});
