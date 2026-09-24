import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { commitMutationAdmission } from "../../src/db/mutationAdmission";
import { atomicBatch } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation } from "../fixtures/mutationAdmission";

it("upgrades a populated D1 database with retained receipts and FIFO sequence intact", async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => !m.name.startsWith("0032_")),
  );
  const f = foundationFixture();
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
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='mutation_admissions'").run();
  const before = (await env.DB.prepare("SELECT * FROM mutation_admissions ORDER BY seq").all())
    .results;
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(
    (await env.DB.prepare("SELECT * FROM mutation_admissions ORDER BY seq").all()).results,
  ).toEqual(before);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(32);
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
  ).toBe(101);
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
});
