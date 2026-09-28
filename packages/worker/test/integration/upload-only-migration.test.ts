import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { assertExists, atomicBatch } from "../../src/db/primary";
import { RECOVERY_FINAL_QUERY } from "../../src/do/recoveryAudit";
import { foundationFixture } from "../fixtures/foundation";

it("keeps existing upload identities through migration and compiles the full atomic recovery fence", async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0066_"),
  );
  const f = foundationFixture();
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare(
    "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) VALUES('legacy-r','f-u',3,'reserved',100000,1)",
  ).run();
  await env.DB.prepare(`INSERT INTO uploads(id,owner_id,space_id,parent_id,blob_id,credential_id,reservation_id,mode,state,declared_size,
    request_digest,capability_hash,epoch,created_at,expires_at,last_progress_at)
    VALUES('legacy-u','f-u','f-s','f-d','f-b','as:f-session','legacy-r','single','created',3,'digest','capability',1,1,100000,1)`).run();
  const before = await env.DB.prepare("SELECT * FROM uploads WHERE id='legacy-u'").first<
    Record<string, unknown>
  >();
  await env.DB.prepare("UPDATE control SET maintenance=0").run();
  await expect(applyD1Migrations(env.DB, env.TEST_MIGRATIONS)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await env.DB.prepare("SELECT * FROM uploads WHERE id='legacy-u'").first()).toEqual({
    ...before,
    upload_only: 0,
  });
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  await expect(
    env.DB.prepare("UPDATE uploads SET upload_only=1 WHERE id='legacy-u'").run(),
  ).rejects.toThrow("immutable_upload_policy");
  // Remove the deliberately unfinished legacy fixture before asking for the terminal fence.
  await env.DB.prepare("DELETE FROM uploads WHERE id='legacy-u'").run();
  await env.DB.prepare("UPDATE reservations SET state='released' WHERE id='legacy-r'").run();
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
    env.DB.prepare("UPDATE nodes SET name='Changed' WHERE id='f-f'").run(),
  ).rejects.toThrow("database_restore_frozen");
});
