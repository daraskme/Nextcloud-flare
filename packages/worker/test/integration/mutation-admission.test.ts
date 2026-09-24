import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import {
  advanceMutations,
  enqueueMutation,
  type MutationAdmission,
  type MutationRequest,
} from "../../src/db/mutationAdmission";
import { assertOpenPermit, grantPermit, releasePermit } from "../../src/db/permits";
import { assertExists, atomicBatch, type SqlStatement } from "../../src/db/primary";
import { ControlMutations } from "../../src/do/controlMutations";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
let f: ReturnType<typeof foundationFixture>;
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
});
const request = (permitId = crypto.randomUUID()): MutationRequest => ({
  permitId,
  spaceId: f.ids.space,
  epoch: 1,
  deadline: Date.now() + 5000,
});
const count = (state: string) =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM mutation_admissions WHERE state=?")
    .bind(state)
    .first<number>("n");
const saved = (id: string) =>
  env.DB.prepare("SELECT * FROM mutation_admissions WHERE id=?").bind(id).first();
async function admit(epoch: number) {
  if (
    !(await env.DB.prepare("SELECT 1 FROM control WHERE maintenance=0 AND epoch=?")
      .bind(epoch)
      .first())
  )
    throw new Error("mutation_unavailable");
}
const service = (db = env.DB, current = (_epoch: number) => {}) =>
  new ControlMutations(db, admit, current);
async function ticket(r = request()): Promise<MutationAdmission> {
  const row = await enqueueMutation(env.DB, r);
  if (row.state !== "active" || row.expires_at === null) throw new Error("missing_ticket");
  return { ...row, expires_at: row.expires_at };
}
async function seed(n: number, active = false) {
  const ids = Array.from({ length: n }, () => crypto.randomUUID());
  const statements: SqlStatement[] = ids.map((id) => ({
    sql: `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,requested_at,wait_until)
      VALUES(?,?,?,1,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`,
    values: [id, id, f.ids.space],
  }));
  await atomicBatch(env.DB, statements);
  if (active) await advanceMutations(env.DB);
  return ids;
}

it("caps active grants at 32 globally and persists a FIFO of at most 256 waiting attempts", async () => {
  const active = await seed(32, true);
  const waiting = await seed(256);
  expect(await count("active")).toBe(32);
  expect(await count("waiting")).toBe(256);
  await expect(enqueueMutation(env.DB, request())).rejects.toThrow("mutation_unavailable");
  await expect(
    env.DB.prepare(
      "UPDATE mutation_admissions SET state='active',granted_at=strftime('%s','now')*1000,expires_at=strftime('%s','now')*1000+30000 WHERE id=?",
    )
      .bind(waiting[0])
      .run(),
  ).rejects.toThrow("mutation_unavailable");
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id IN (?,?)")
    .bind(active[0], active[1])
    .run();
  const rows = await advanceMutations(env.DB);
  expect(
    rows.filter((row) => waiting.includes(row.id) && row.state === "active").map((row) => row.id),
  ).toEqual(waiting.slice(0, 2));
  expect(await count("active")).toBe(32);
  expect(await count("waiting")).toBe(254);
});

it("concurrent same-intent retries share an immutable grant without extending its expiry", async () => {
  const r = request();
  const [a, b] = await Promise.all([ticket(r), ticket(r)]);
  expect(a).toEqual(b);
  expect(await count("active")).toBe(1);
  await expect(
    enqueueMutation(env.DB, { ...request(r.permitId), spaceId: "wrong" }),
  ).rejects.toThrow();
  for (const sql of [
    "expires_at=expires_at+1",
    "epoch=2",
    "permit_id='other'",
    "state='waiting'",
    "id='00000000-0000-0000-0000-000000000000'",
  ])
    await expect(
      env.DB.prepare(`UPDATE mutation_admissions SET ${sql} WHERE id=?`).bind(a.id).run(),
    ).rejects.toThrow();
  await expect(
    env.DB.prepare("DELETE FROM mutation_admissions WHERE id=?").bind(a.id).run(),
  ).rejects.toThrow();
});

it("retains an unknown enqueue acknowledgement and lets a retry recover the same grant", async () => {
  const r = request();
  const lossy = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      await env.DB.batch(statements);
      throw new Error("lost_ack");
    },
  } as unknown as D1Database;
  await expect(service(lossy).acquire(r)).rejects.toThrow("mutation_unavailable");
  expect(await count("active")).toBe(1);
  const first = await env.DB.prepare("SELECT id FROM mutation_admissions WHERE permit_id=?")
    .bind(r.permitId)
    .first("id");
  expect((await service().acquire(request(r.permitId))).id).toBe(first);
  expect(await count("active")).toBe(1);
});

it("holds a shared grant when one caller's local current-instance fence fails", async () => {
  const r = request();
  let calls = 0;
  await expect(
    service(env.DB, () => {
      if (++calls === 2) throw new Error("replaced");
    }).acquire(r),
  ).rejects.toThrow();
  expect(await count("active")).toBe(1);
  expect((await service().acquire(request(r.permitId))).permit_id).toBe(r.permitId);
});

it("requires an exact live ticket and rechecks authorization in the atomic permit transaction", async () => {
  const r = request(),
    a = await ticket(r);
  await expect(
    grantPermit(env.DB, r.permitId, r.spaceId, 1, { ...a, id: crypto.randomUUID() }),
  ).rejects.toThrow();
  await expect(
    grantPermit(env.DB, r.permitId, r.spaceId, 1, a, undefined, [assertExists("SELECT 1 WHERE 0")]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT 1 FROM permits WHERE permit_id=?").bind(r.permitId).first(),
  ).toBeNull();
  const permit = await grantPermit(env.DB, r.permitId, r.spaceId, 1, a);
  await expect(
    grantPermit(env.DB, r.permitId, r.spaceId, 1, { ...a, expires_at: a.expires_at + 1 }),
  ).rejects.toThrow();
  expect(permit.expires_at).toBeLessThanOrEqual(a.expires_at);
  await atomicBatch(env.DB, [assertOpenPermit(permit)]);
  await releasePermit(env.DB, permit);
  expect((await saved(a.id))?.state).toBe("closed");
  await expect(enqueueMutation(env.DB, request(r.permitId))).rejects.toThrow();
  await expect(atomicBatch(env.DB, [assertOpenPermit(permit)])).rejects.toThrow();
});

it("rejects direct current permit inserts that bypass global admission", async () => {
  await expect(
    env.DB.prepare("INSERT INTO permits VALUES(?,?,1,strftime('%s','now')*1000+30000,'open')")
      .bind(crypto.randomUUID(), f.ids.space)
      .run(),
  ).rejects.toThrow("mutation_admission_required");
});

it.each(["stop", "epoch"])(
  "%s closes tickets and rolls back a late namespace commit",
  async (mode) => {
    const r = request(),
      a = await ticket(r),
      permit = await grantPermit(env.DB, r.permitId, r.spaceId, 1, a);
    await env.DB.prepare(
      mode === "stop" ? "UPDATE control SET maintenance=1" : "UPDATE control SET epoch=2",
    ).run();
    expect((await saved(a.id))?.state).toBe("closed");
    expect(
      await env.DB.prepare("SELECT state FROM permits WHERE permit_id=?")
        .bind(r.permitId)
        .first("state"),
    ).toBe("revoked");
    await expect(
      atomicBatch(env.DB, [
        { sql: "UPDATE nodes SET name='late' WHERE id=?", values: [f.ids.file] },
        assertOpenPermit(permit),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(f.ids.file).first("name"),
    ).toBe("File");
    await expect(grantPermit(env.DB, r.permitId, r.spaceId, 1, a)).rejects.toThrow();
  },
);

it("wakes a queued caller after a slot closes, sharing the durable FIFO with a replacement", async () => {
  const ids = await seed(32, true),
    r = request();
  const waiting = await enqueueMutation(env.DB, r);
  expect(waiting.state).toBe("waiting");
  const pending = service().acquire(request(r.permitId));
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
    .bind(ids[0])
    .run();
  expect((await pending).id).toBe(waiting.id);
  expect(await count("active")).toBe(32);
});

it("times out a waiter without freeing active capacity or poisoning its operation ID", async () => {
  const ids = await seed(32, true),
    r = { ...request(), deadline: Date.now() + 300 };
  await expect(service().acquire(r)).rejects.toThrow("mutation_unavailable");
  expect(await count("active")).toBe(32);
  // D1 uses a whole-second SQL clock; advance past the original deadline before retrying.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await env.DB.prepare("UPDATE mutation_admissions SET state='closed' WHERE id=?")
    .bind(ids[0])
    .run();
  expect((await service().acquire(request(r.permitId))).permit_id).toBe(r.permitId);
});

it("bounds duplicate pending RPCs before D1 and retains that bound until unknown I/O settles", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const s = new ControlMutations(
    env.DB,
    async () => {
      entered++;
      await barrier;
      throw new Error("stop");
    },
    () => {},
  );
  const pending = Array.from({ length: 256 }, () => s.acquire(request()).catch(() => null));
  expect(entered).toBe(256);
  await expect(s.acquire(request())).rejects.toThrow("mutation_unavailable");
  release();
  await Promise.all(pending);
  expect(await count("active")).toBe(0);
  expect(await count("waiting")).toBe(0);
});

it("does not grant a delayed enqueue after its original SQL deadline", async () => {
  const r = { ...request(), deadline: Date.now() + 100 };
  const delayed = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return env.DB.batch(statements);
    },
  } as D1Database;
  await expect(enqueueMutation(delayed, r)).rejects.toThrow();
  expect(await count("active")).toBe(0);
  expect(await count("waiting")).toBe(0);
});
