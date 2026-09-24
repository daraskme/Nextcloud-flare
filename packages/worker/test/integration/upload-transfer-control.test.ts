import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { repairMultipartUploads } from "../../src/jobs/multipartCleanup";
import { repairSingleUploads } from "../../src/jobs/uploadCleanup";
import { foundationFixture } from "../fixtures/foundation";
import { multipartCleanupFixture, singleCleanupFixture } from "../fixtures/uploadCleanup";
import { journalFixture, journalStages } from "../fixtures/uploadJournal";
import {
  actions,
  cleanupTransferObjects,
  settlementActions,
  transferFixture,
} from "../fixtures/uploadTransfer";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
let epoch = 2;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    EPOCH_PREFIX + "1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  epoch = (await control().recover()).epoch;
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, owner.statements);
  const key = "u/" + owner.ids.user + "/b/" + owner.ids.blob;
  const object = (await env.BLOBS.put(key, "abc"))!;
  await atomicBatch(env.DB, [
    {
      sql: "UPDATE control SET bootstrap_done_at=1,bootstrap_iss='https://access.invalid',bootstrap_sub=?",
      values: [owner.ids.user],
    },
    {
      sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,?,1)",
      values: [owner.ids.blob, object.etag],
    },
  ]);
  await control().beginRecoveryAudit(epoch);
  let complete = false;
  for (let i = 0; i < 20; i++) {
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      complete = true;
      break;
    }
  }
  expect(complete).toBe(true);
  await control().resumeAdmission(epoch);
});
afterEach(cleanupTransferObjects);
afterAll(async () => {
  await control().quiesce(epoch);
});

it.each([...actions, ...settlementActions])(
  "queues %s in the real shared pool and returns capacity after commit",
  async (action) => {
    const f = await transferFixture(action, epoch, true);
    const seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
    const prefix = "upload." + action + ":";
    const app = f.configure(async (request) => {
      if (request.permitId.startsWith(prefix)) {
        await atomicBatch(
          env.DB,
          seeds.map((id) => ({
            sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
            values: [id, id, f.f.ids.space, epoch],
          })),
        );
        expect(
          (await advanceMutations(env.DB)).filter((row) => row.state === "active"),
        ).toHaveLength(32);
      }
      return control().acquireMutation(request);
    });
    const outcome = f.run(app).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='waiting' AND space_id=? AND permit_id LIKE ?",
            )
              .bind(f.f.ids.space, prefix + "%")
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(f.calls.get + f.calls.create).toBe(0);
      expect(f.calls.complete).toBe(action === "multipart-verify" ? 1 : 0);
      expect(f.calls.put).toBe(action === "single-verify" ? 1 : 0);
      expect((await f.receipt())[0]).toEqual({ state: "waiting", committed_at: null });
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(seeds[0])
        .run();
      const result = await outcome;
      if ("error" in result) throw result.error;
      expect(result.value).toMatchObject(
        action === "multipart-complete" || action === "multipart-verify"
          ? { kind: "terminal", operation: { state: "committed" } }
          : {
              state:
                action === "single-abort"
                  ? "aborted"
                  : action === "multipart-abort"
                    ? "aborting"
                    : action === "multipart-start"
                      ? "created"
                      : "completing",
            },
      );
      expect(await f.receipt()).toEqual([{ state: "closed", committed_at: expect.any(Number) }]);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='active'",
        ).first("n"),
      ).toBe(31);
      const grant = await control().acquireMutation({
        permitId: crypto.randomUUID(),
        spaceId: f.f.ids.space,
        epoch,
        deadline: Date.now() + 5000,
      });
      expect(await grantPermit(env.DB, grant.permit_id, f.f.ids.space, epoch, grant)).toMatchObject(
        { permit_id: grant.permit_id },
      );
    } finally {
      // Explicit fixture cleanup, after any live request settles; no production release shortcut.
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE space_id=? AND state<>'closed'",
      )
        .bind(f.f.ids.space)
        .run();
      await outcome;
      await env.DB.prepare("UPDATE permits SET state='revoked' WHERE space_id=? AND state='open'")
        .bind(f.f.ids.space)
        .run();
    }
  },
);

it.each(journalStages)(
  "queues journal %s behind real shared capacity and returns its slot",
  async (stage) => {
    const f = await journalFixture(stage, epoch, control),
      target = f.atGate();
    const seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
    const before = async (request: { permitId: string }) => {
      if (!target({ ...request, spaceId: f.f.ids.space, epoch, deadline: Date.now() + 5000 }))
        return;
      await atomicBatch(
        env.DB,
        seeds.map((id) => ({
          sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
          values: [id, id, f.f.ids.space, epoch],
        })),
      );
      expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
    };
    const outcome = f.run(
      f.configure({
        acquire: async (r) => {
          await before(r);
          return control().acquireMutation(r);
        },
        systemAcquire: async (r) => {
          await before(r);
          return control().acquireSystemMutation(r);
        },
      }),
    );
    try {
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='waiting' AND space_id=? AND permit_id LIKE ?",
            )
              .bind(f.f.ids.space, f.prefix + "%")
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(f.parts()).toBe(0);
      expect(await f.counters()).toMatchObject({ reserved_bytes: 3 });
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(seeds[0])
        .run();
      const result = await outcome;
      if (stage === "lost")
        expect(result).toMatchObject({ error: { message: "upload_ledger_recovery_required" } });
      else if ("error" in result) throw result.error;
      expect(
        (await f.receipt()).every((r) => r.state === "closed" && r.committed_at !== null),
      ).toBe(true);
      expect(f.parts()).toBe(stage === "part" ? 1 : 0);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='active'",
        ).first("n"),
      ).toBe(31);
      const grant = await control().acquireMutation({
        permitId: crypto.randomUUID(),
        spaceId: f.f.ids.space,
        epoch,
        deadline: Date.now() + 5000,
      });
      expect(await grantPermit(env.DB, grant.permit_id, f.f.ids.space, epoch, grant)).toMatchObject(
        { permit_id: grant.permit_id },
      );
    } finally {
      await env.DB.prepare(
        "UPDATE mutation_admissions SET state='closed' WHERE space_id=? AND state<>'closed'",
      )
        .bind(f.f.ids.space)
        .run();
      await outcome;
      await env.DB.prepare("UPDATE permits SET state='revoked' WHERE space_id=? AND state='open'")
        .bind(f.f.ids.space)
        .run();
    }
  },
);

it.each([
  { mode: "single", stage: "claim" },
  { mode: "single", stage: "call" },
  { mode: "single", stage: "settle" },
  { mode: "multipart", stage: "claim" },
  { mode: "multipart", stage: "call" },
  { mode: "multipart", stage: "settle" },
])("queues automatic $mode cleanup $stage in the actual shared pool", async ({ mode, stage }) => {
  await env.DB.prepare("UPDATE uploads SET cleanup_next_at=9999999999999").run();
  const f = mode === "single" ? await singleCleanupFixture() : await multipartCleanupFixture();
  const seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
  const prefix = "system:upload.cleanup-" + stage + ":";
  let filled = false,
    calls = 0;
  const source = {
    DB: env.DB,
    systemControl: {
      status: () => control().status(),
      acquireSystemMutation: async (
        request: Parameters<ReturnType<typeof control>["acquireSystemMutation"]>[0],
      ) => {
        if (!filled && request.permitId.startsWith(prefix)) {
          filled = true;
          await atomicBatch(
            env.DB,
            seeds.map((id) => ({
              sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
              values: [id, id, f.ids.space, epoch],
            })),
          );
          expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(
            32,
          );
        }
        return control().acquireSystemMutation(request);
      },
    },
  };
  const bucket = {
    head: (key: string) => {
      calls++;
      return env.BLOBS.head(key);
    },
    resumeMultipartUpload: (key: string, uploadId: string) => ({
      abort: () => {
        calls++;
        return env.BLOBS.resumeMultipartUpload(key, uploadId).abort();
      },
    }),
  } as R2Bucket;
  const outcome = (mode === "single" ? repairSingleUploads : repairMultipartUploads)(
    source,
    bucket,
    epoch,
  );
  try {
    await expect
      .poll(
        () =>
          env.DB.prepare(
            "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='waiting' AND space_id=? AND permit_id LIKE ?",
          )
            .bind(f.ids.space, prefix + "%")
            .first("n"),
        { timeout: 4000, interval: 25 },
      )
      .toBe(1);
    expect(calls).toBe(stage === "settle" ? (mode === "single" ? 1 : 2) : 0);
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
        .bind(f.ids.user)
        .first("reserved_bytes"),
    ).toBe(3);
    await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
      .bind(seeds[0])
      .run();
    expect(await outcome).toMatchObject({ absent: 1, retried: 0 });
    const receipts = await env.DB.prepare(
      "SELECT state,committed_at FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ?",
    )
      .bind(f.ids.space, prefix + "%")
      .all();
    for (const r of receipts.results)
      expect(r).toEqual({ state: "closed", committed_at: expect.any(Number) });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM mutation_admissions WHERE state='active'",
      ).first("n"),
    ).toBe(31);
    const grant = await control().acquireMutation({
      permitId: crypto.randomUUID(),
      spaceId: f.ids.space,
      epoch,
      deadline: Date.now() + 5000,
    });
    expect(await grantPermit(env.DB, grant.permit_id, f.ids.space, epoch, grant)).toMatchObject({
      permit_id: grant.permit_id,
    });
  } finally {
    await env.DB.prepare(
      "UPDATE mutation_admissions SET state='closed' WHERE space_id=? AND state<>'closed'",
    )
      .bind(f.ids.space)
      .run();
    await outcome;
    await env.DB.prepare("UPDATE permits SET state='revoked' WHERE space_id=? AND state='open'")
      .bind(f.ids.space)
      .run();
  }
});
