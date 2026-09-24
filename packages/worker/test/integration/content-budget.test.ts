import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { authorizeNode } from "../../src/auth/authorize";
import { atomicBatch } from "../../src/db/primary";
import { ensureContentBudget } from "../../src/services/contentBudget";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  const now = Date.now();
  const f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  return { f, now };
}

it("reuses a private identity budget and rejects maintenance, revocation and expired credentials", async () => {
  const { f, now } = await fixture();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const authorize = () =>
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.ids.file,
      spaceId: f.ids.space,
    });
  const first = await ensureContentBudget(mutationEnv(), await authorize(), now + 300_000);
  const second = await ensureContentBudget(mutationEnv(), await authorize(), now + 400_000);
  expect(first.id).toBe(`u:${f.ids.user}`);
  expect(second.id).toBe(first.id);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM budgets WHERE owner_id=?")
      .bind(f.ids.user)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT expires_at FROM budgets WHERE id=?")
      .bind(first.id)
      .first("expires_at"),
  ).toBe(now + 400_000);
  const appId = crypto.randomUUID();
  const appCredential = `ap:${appId}`;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
        VALUES(?,?,?,'test','digest','salt','PBKDF2-SHA256','{"iterations":100000}','k1',?,?)`,
      values: [appId, f.ids.user, f.ids.folder, now - 1000, now + 500_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [appCredential, appId],
    },
    { sql: "INSERT INTO credential_scopes VALUES(?,'node:read')", values: [appCredential] },
  ]);
  const appAuthorized = await authorizeNode(
    env.DB,
    { kind: "app_password", user_id: f.ids.user, credential_id: appCredential, epoch: 1 },
    { operation: "node.read", nodeId: f.ids.file, spaceId: f.ids.space },
  );
  expect((await ensureContentBudget(mutationEnv(), appAuthorized, now + 300_000)).id).toBe(
    first.id,
  );
  await env.DB.prepare("UPDATE app_passwords SET revoked_at=? WHERE id=?").bind(now, appId).run();
  await expect(ensureContentBudget(mutationEnv(), appAuthorized, now + 300_000)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1 WHERE singleton=1").run();
  await expect(
    ensureContentBudget(mutationEnv(), await authorize(), now + 300_000),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  await env.DB.prepare("UPDATE budgets SET state='revoked' WHERE id=?").bind(first.id).run();
  await expect(
    ensureContentBudget(mutationEnv(), await authorize(), now + 300_000),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
    .bind(now, f.ids.session)
    .run();
  await expect(authorize()).rejects.toThrow(/authorization_denied/);
});

it("binds an internal-share budget to the selected share root", async () => {
  const { f, now } = await fixture();
  const shareId = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [shareId, f.ids.user, f.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [shareId, f.ids.user],
    },
  ]);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const authorize = () =>
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.ids.file,
      spaceId: f.ids.space,
    });
  const budget = await ensureContentBudget(mutationEnv(), await authorize(), now + 300_000, {
    id: shareId,
    version: 1,
  });
  expect(budget.id).toBe(`u:${f.ids.user}:s:${shareId}`);
  await env.DB.prepare("UPDATE nodes SET parent_id=?,revision=revision+1 WHERE id=?")
    .bind(f.ids.root, f.ids.file)
    .run();
  await expect(
    ensureContentBudget(mutationEnv(), await authorize(), now + 300_000, {
      id: shareId,
      version: 1,
    }),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT expires_at FROM budgets WHERE id=?")
      .bind(budget.id)
      .first("expires_at"),
  ).toBe(now + 300_000);
});

it("uses the anonymous unlock session as the budget identity and expiry fence", async () => {
  const { f, now } = await fixture();
  const shareId = crypto.randomUUID();
  const unlockId = crypto.randomUUID();
  const credentialId = `ss:${unlockId}`;
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at,expires_at) VALUES(?,?,?,'link',?,?)",
      values: [shareId, f.ids.user, f.ids.folder, now, now + 310_000],
    },
    { sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')", values: [shareId] },
    {
      sql: `INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at)
        VALUES(?,?,1,?,1,?,?)`,
      values: [unlockId, shareId, `digest-${unlockId}`, now, now + 320_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [credentialId, unlockId],
    },
  ]);
  const principal = {
    kind: "link_share" as const,
    share_id: shareId,
    share_version: 1,
    credential_id: credentialId,
    epoch: 1,
  };
  const authorize = () =>
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.ids.file,
      spaceId: f.ids.space,
    });
  const budget = await ensureContentBudget(mutationEnv(), await authorize(), now + 300_000);
  expect(budget.id).toBe(`s:${shareId}:c:${unlockId}`);
  expect(
    await env.DB.prepare("SELECT unlock_session_id FROM budgets WHERE id=?")
      .bind(budget.id)
      .first("unlock_session_id"),
  ).toBe(unlockId);
  await expect(
    ensureContentBudget(mutationEnv(), await authorize(), now + 315_000),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE share_sessions SET revoked_at=? WHERE id=?")
    .bind(now, unlockId)
    .run();
  await expect(authorize()).rejects.toThrow(/authorization_denied/);
});
