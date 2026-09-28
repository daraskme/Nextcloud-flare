import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { assertExists, atomicBatch } from "../../src/db/primary";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

it("migrates populated D1 trash without breaking inbound references or freeze guards", async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0065_"),
  );
  const f = foundationFixture();
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare(
    "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES('legacy','f-u','f-s','f-f','trashed',1,1)",
  ).run();
  await env.DB.prepare(
    "UPDATE nodes SET deleted_at=1,deleted_op_id='legacy',orig_parent_id=parent_id WHERE id='f-f'",
  ).run();
  await env.DB.prepare("INSERT INTO trash_members VALUES('legacy','f-f')").run();
  const before = await env.DB.prepare("SELECT * FROM trash_ops").all();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect((await env.DB.prepare("SELECT * FROM trash_ops").all()).results).toEqual(before.results);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(
    await env.DB.prepare("SELECT deleted_op_id FROM nodes WHERE id='f-f'").first("deleted_op_id"),
  ).toBe("legacy");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trash_members WHERE trash_op_id='legacy'",
    ).first("n"),
  ).toBe(1);
  // Native D1 must also compile the final audit when the write barrier wraps it.
  const token = crypto.randomUUID();
  await env.DB.prepare(`UPDATE control SET maintenance=1,gc_paused=1,
    bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub='f-u',
    admission_revision=1,admission_token=?`)
    .bind(token)
    .run();
  await atomicBatch(env.DB, [
    assertExists(
      `${RECOVERY_FINAL_QUERY}
    AND c.admission_revision=? AND c.admission_token=? AND c.backup_frozen=0
    AND c.backup_token IS NULL AND c.restore_freeze_token IS NULL
    AND strftime('%s','now')*1000+1000<?`,
      [1, 1, token, Date.now() + 20000],
    ),
  ]);
  await env.DB.prepare(
    "UPDATE control SET restore_freeze_token='00000000-0000-4000-8000-000000000000'",
  ).run();
  await expect(
    env.DB.prepare("UPDATE trash_ops SET state='restoring' WHERE op_id='legacy'").run(),
  ).rejects.toThrow("database_restore_frozen");
});
