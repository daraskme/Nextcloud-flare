import { applyD1Migrations, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { advanceMutations } from "../../src/db/mutationAdmission";
import { grantPermit } from "../../src/db/permits";
import { atomicBatch } from "../../src/db/primary";
import { CONTROL_NAME } from "../../src/do/ControlDO";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";
import { dispatchOutbox } from "../../src/jobs/outbox";
import { handleOutboxBatch } from "../../src/jobs/queue";
import type { SystemMutationSource } from "../../src/services/systemMutation";
import { foundationFixture } from "../fixtures/foundation";
import { outboxFixture } from "../fixtures/outbox";
import { systemMutationFault } from "../fixtures/systemMutationFault";

const control = () => env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
const metadata = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
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
  const object = (await env.BLOBS.put(`u/${owner.ids.user}/b/${owner.ids.blob}`, "abc"))!;
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
  let completed = false;
  for (let i = 0; i < 30; i++)
    if ((await control().nextRecoveryAuditPage(epoch, 20)).completed) {
      completed = true;
      break;
    }
  expect(completed).toBe(true);
  await control().resumeAdmission(epoch);
});
afterAll(() => control().quiesce(epoch));
async function fill(space: string, seeds: string[]) {
  await atomicBatch(
    env.DB,
    seeds.map((id) => ({
      sql: "INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until) VALUES(?,?,?,?,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)",
      values: [id, id, space, epoch],
    })),
  );
  expect((await advanceMutations(env.DB)).filter((r) => r.state === "active")).toHaveLength(32);
}
async function release(space: string) {
  await env.DB.prepare(
    "UPDATE mutation_admissions SET state='closed' WHERE space_id=? AND state<>'closed'",
  )
    .bind(space)
    .run();
}

it.each(["dispatch-claim", "send", "sent", "consume-claim", "complete"] as const)(
  "Queue %s shares capacity with ordinary namespace operations",
  async (stage) => {
    const f = await outboxFixture(undefined, epoch),
      seeds = Array.from({ length: 32 }, () => crypto.randomUUID());
    const receiving = stage === "consume-claim" || stage === "complete";
    const messages: unknown[] = [];
    const queue = {
      send: async (body: unknown) => {
        messages.push(body);
        return metadata;
      },
    };
    if (receiving) {
      expect(await dispatchOutbox(env, queue, f.id, epoch)).toBe("sent");
      messages.length = 0;
    }
    const prefix = `system:outbox.${stage}:`;
    let filled = false,
      acked = 0,
      retried = 0;
    const source: SystemMutationSource = {
      DB: env.DB,
      systemControl: {
        status: () => control().status(),
        acquireSystemMutation: async (r) => {
          if (!filled && r.permitId.startsWith(prefix)) {
            filled = true;
            await fill(f.ids.space, seeds);
          }
          return control().acquireSystemMutation(r);
        },
      },
    };
    const outcome = receiving
      ? handleOutboxBatch(source, {
          messages: [
            {
              body: { outboxId: f.id },
              ack: () => {
                acked++;
              },
              retry: () => {
                retried++;
              },
            },
          ],
        })
      : dispatchOutbox(source, queue, f.id, epoch);
    try {
      await expect
        .poll(
          () =>
            env.DB.prepare(
              "SELECT COUNT(*) n FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ? AND state='waiting'",
            )
              .bind(f.ids.space, prefix + "%")
              .first("n"),
          { timeout: 4000, interval: 25 },
        )
        .toBe(1);
      expect(messages).toHaveLength(stage === "sent" ? 1 : 0);
      expect(acked).toBe(0);
      expect(retried).toBe(0);
      expect(
        await env.DB.prepare("SELECT state FROM outbox WHERE outbox_id=?")
          .bind(f.id)
          .first("state"),
      ).toBe(receiving ? "sent" : stage === "dispatch-claim" ? "pending" : "dispatching");
      await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
        .bind(seeds[0]!)
        .run();
      expect(await outcome).toEqual(receiving ? { acked: 1, retried: 0 } : "sent");
      expect(
        await env.DB.prepare(
          "SELECT state,committed_at,system,maintenance FROM mutation_admissions WHERE space_id=? AND permit_id LIKE ?",
        )
          .bind(f.ids.space, prefix + "%")
          .first(),
      ).toEqual({ state: "closed", committed_at: expect.any(Number), system: 1, maintenance: 0 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM mutation_admissions WHERE state='active'",
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
      await release(f.ids.space);
      await outcome;
    }
  },
);

it("a lost send ACK survives coordinator eviction and only a new leased attempt sends", async () => {
  const f = await outboxFixture(undefined, epoch),
    fault = systemMutationFault("system:outbox.send:", "reads");
  const messages: unknown[] = [],
    queue = {
      send: async (body: unknown) => {
        messages.push(body);
        return metadata;
      },
    };
  expect(await dispatchOutbox({ ...env, DB: fault.db }, queue, f.id, epoch)).toBe("retry");
  expect(fault.reads()).toBe(0);
  expect(messages).toEqual([]);
  const token = await env.DB.prepare("SELECT dispatch_token FROM outbox WHERE outbox_id=?")
    .bind(f.id)
    .first("dispatch_token");
  await evictDurableObject(control());
  expect(await control().status()).toMatchObject({ epoch, maintenance: false });
  expect(await dispatchOutbox(env, queue, f.id, epoch)).toBe("busy");
  expect(messages).toEqual([]);
  await env.DB.prepare("UPDATE outbox SET dispatch_expires_at=0 WHERE outbox_id=?")
    .bind(f.id)
    .run();
  expect(await dispatchOutbox(env, queue, f.id, epoch)).toBe("sent");
  expect(messages).toEqual([{ outboxId: f.id }]);
  expect(
    await env.DB.prepare("SELECT dispatch_token FROM outbox WHERE outbox_id=?")
      .bind(f.id)
      .first("dispatch_token"),
  ).not.toBe(token);
  await release(f.ids.space);
});
