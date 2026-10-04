import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { enqueueMutation } from "../../src/db/mutationAdmission";
import { atomicBatch, type SqlStatement } from "../../src/db/primary";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0,gc_paused=0").run();
});

async function users(count: number) {
  const fixtures = Array.from({ length: count }, () =>
    foundationFixture(crypto.randomUUID(), Date.now() - 1000),
  );
  await atomicBatch(
    env.DB,
    fixtures.flatMap((f) => f.statements),
  );
  return fixtures.map((f) => f.ids);
}

const sql = `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until,actor,account)
  VALUES(?,?,?,1,0,0,strftime('%s','now')*1000,strftime('%s','now')*1000+5000,?,?)`;
const row = (spaceId: string, actor: string, account: string): SqlStatement => ({
  sql,
  values: [crypto.randomUUID(), crypto.randomUUID(), spaceId, actor, account],
});
const insert = (spaceId: string, actor: string, account: string) =>
  atomicBatch(env.DB, [row(spaceId, actor, account)]);
const fill = (spaceId: string, actor: string, account: string, count: number) =>
  atomicBatch(
    env.DB,
    Array.from({ length: count }, () => row(spaceId, actor, account)),
  );

// F3: fairness is per principal, not per space. One actor holds at most 16
// waiting slots, link shares 16 per owner, and actors other than the owner
// never take the owner's last 16 of the space's 64.
it("bounds waiting admissions per actor and reserves the owner's own slots", async () => {
  const [owner, a, b, c, fresh] = await users(5);
  const space = owner!.space;
  // Account must match the actor: users bill themselves, link shares bill the space owner.
  await expect(insert(space, `u:${a!.user}`, owner!.user)).rejects.toThrow("mutation_unavailable");
  await expect(insert(space, "s:share-x", a!.user)).rejects.toThrow("mutation_unavailable");
  // An internal-share recipient: 16 per actor, in any space.
  await fill(space, `u:${a!.user}`, a!.user, 16);
  await expect(insert(space, `u:${a!.user}`, a!.user)).rejects.toThrow("mutation_unavailable");
  await expect(insert(a!.space, `u:${a!.user}`, a!.user)).rejects.toThrow("mutation_unavailable");
  // Link shares are billed to the owner: 16 in total however many shares exist.
  await fill(space, "s:share-a", owner!.user, 8);
  await fill(space, "s:share-b", owner!.user, 8);
  await expect(insert(space, "s:share-c", owner!.user)).rejects.toThrow("mutation_unavailable");
  // Non-owner actors stop at 48 in this space.
  await fill(space, `u:${b!.user}`, b!.user, 16);
  await expect(insert(space, `u:${c!.user}`, c!.user)).rejects.toThrow("mutation_unavailable");
  // The owner still gets its reserved 16, then the space is full at 64.
  await fill(space, `u:${owner!.user}`, owner!.user, 16);
  await expect(insert(space, `u:${owner!.user}`, owner!.user)).rejects.toThrow(
    "mutation_unavailable",
  );
  // Others are unaffected.
  await insert(c!.space, `u:${c!.user}`, c!.user);
  await insert(fresh!.space, `u:${fresh!.user}`, fresh!.user);
});

it("records the actor and billed account on enqueue, defaulting to the space owner", async () => {
  const [owner, guest] = await users(2);
  const read = (id: string) =>
    env.DB.prepare("SELECT actor,account FROM mutation_admissions WHERE id=?").bind(id).first();
  const request = (actor?: string) => ({
    permitId: `test:${crypto.randomUUID()}`,
    spaceId: owner!.space,
    epoch: 1,
    deadline: Date.now() + 4000,
    ...(actor === undefined ? {} : { actor }),
  });
  expect(await read((await enqueueMutation(env.DB, request())).id)).toEqual({
    actor: `u:${owner!.user}`,
    account: owner!.user,
  });
  expect(await read((await enqueueMutation(env.DB, request(`u:${guest!.user}`))).id)).toEqual({
    actor: `u:${guest!.user}`,
    account: guest!.user,
  });
  expect(await read((await enqueueMutation(env.DB, request("s:share-1"))).id)).toEqual({
    actor: "s:share-1",
    account: owner!.user,
  });
  await expect(enqueueMutation(env.DB, request("x:bad"))).rejects.toThrow("mutation_unavailable");
});

it("counts legacy owner-implicit rows (NULL actor) toward the owner's actor and account limits", async () => {
  const [owner, other] = await users(2);
  const legacy = (spaceId: string): SqlStatement => ({
    sql: `INSERT INTO mutation_admissions(id,permit_id,space_id,epoch,system,maintenance,requested_at,wait_until)
      VALUES(?,?,?,1,0,0,strftime('%s','now')*1000,strftime('%s','now')*1000+5000)`,
    values: [crypto.randomUUID(), crypto.randomUUID(), spaceId],
  });
  await atomicBatch(
    env.DB,
    Array.from({ length: 16 }, () => legacy(owner!.space)),
  );
  await expect(insert(owner!.space, `u:${owner!.user}`, owner!.user)).rejects.toThrow(
    "mutation_unavailable",
  );
  // Link shares bill the owner's account: 16 legacy + 16 share rows reach 32.
  await fill(owner!.space, "s:share-legacy", owner!.user, 16);
  await expect(insert(owner!.space, "s:share-other", owner!.user)).rejects.toThrow(
    "mutation_unavailable",
  );
  // Legacy rows in the owner's space do not count against other users.
  await insert(owner!.space, `u:${other!.user}`, other!.user);
});
