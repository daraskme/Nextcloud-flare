import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";

// Historical SQL deliberately avoids helpers requiring newer schema columns.
async function acquireMutation(request: {
  permitId: string;
  spaceId: string | null;
  epoch: number;
}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
  )
    .bind(id, request.permitId, request.spaceId, request.epoch)
    .run();
  await env.DB.prepare(
    "UPDATE mutation_admissions SET state='active',granted_at=strftime('%s','now')*1000,expires_at=strftime('%s','now')*1000+30000 WHERE id=?",
  )
    .bind(id)
    .run();
  return (await env.DB.prepare("SELECT id,permit_id,expires_at FROM mutation_admissions WHERE id=?")
    .bind(id)
    .first<{ id: string; permit_id: string; expires_at: number }>())!;
}
const commitMutationAdmission = (a: { id: string }) => [
  {
    sql: "UPDATE mutation_admissions SET state='closed',committed_at=strftime('%s','now')*1000 WHERE id=?",
    values: [a.id],
  },
];
it.each([32, 33, 34])(
  "upgrade %s preserves populated D1 receipts and FIFO sequence",
  async (version) => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) < version),
    );
    const f = foundationFixture(crypto.randomUUID());
    await atomicBatch(env.DB, f.statements);
    await env.DB.prepare("UPDATE control SET maintenance=0").run();
    const request = () => ({
      permitId: crypto.randomUUID(),
      spaceId: f.ids.space,
      epoch: 1,
      deadline: Date.now() + 5000,
    });
    const committed = await acquireMutation(request());
    await atomicBatch(env.DB, commitMutationAdmission(committed));
    await acquireMutation(request());
    if (version === 34) {
      const bootstrap = await acquireMutation({
        ...request(),
        spaceId: null,
        permitId: "bootstrap:" + crypto.randomUUID(),
      });
      await atomicBatch(env.DB, commitMutationAdmission(bootstrap));
      for (const maintenance of [0, 1]) {
        await env.DB.prepare("UPDATE control SET maintenance=?").bind(maintenance).run();
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until) VALUES(?,?,?,1,1,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
        )
          .bind(id, "system:upload.observe:" + crypto.randomUUID(), f.ids.space, maintenance)
          .run();
        await env.DB.prepare(
          "UPDATE mutation_admissions SET state='active',granted_at=strftime('%s','now')*1000,expires_at=strftime('%s','now')*1000+30000 WHERE id=?",
        )
          .bind(id)
          .run();
        await atomicBatch(env.DB, commitMutationAdmission({ id }));
      }
    }
    await env.DB.prepare("UPDATE control SET maintenance=1").run();
    const highWater =
      100 +
      (await env.DB.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name='mutation_admissions'",
      ).first<number>("seq"))!;
    await env.DB.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='mutation_admissions'")
      .bind(highWater)
      .run();
    const before = (await env.DB.prepare("SELECT * FROM mutation_admissions ORDER BY seq").all())
      .results;
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= version),
    );
    expect(
      (await env.DB.prepare("SELECT * FROM mutation_admissions ORDER BY seq").all()).results,
    ).toEqual(
      version === 33 ? before.map((row) => ({ ...row, system: 0, maintenance: 0 })) : before,
    );
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(
      version,
    );
    await expect(
      env.DB.prepare("DELETE FROM mutation_admissions WHERE id=?").bind(committed.id).run(),
    ).rejects.toThrow("mutation_receipt_required");
    await env.DB.prepare("UPDATE control SET maintenance=0").run();
    const bootstrap = await acquireMutation({
      ...request(),
      spaceId: null,
      permitId: "bootstrap:" + crypto.randomUUID(),
    });
    expect(
      await env.DB.prepare("SELECT seq FROM mutation_admissions WHERE id=?")
        .bind(bootstrap.id)
        .first("seq"),
    ).toBe(highWater + 1);
    await expect(
      env.DB.prepare("INSERT INTO permits VALUES(?,?,1,?,'open')")
        .bind(bootstrap.permit_id, f.ids.space, bootstrap.expires_at)
        .run(),
    ).rejects.toThrow("mutation_admission_required");
    await atomicBatch(env.DB, commitMutationAdmission(bootstrap));
    expect(
      await env.DB.prepare("SELECT committed_at FROM mutation_admissions WHERE id=?")
        .bind(bootstrap.id)
        .first("committed_at"),
    ).not.toBeNull();
  },
);
