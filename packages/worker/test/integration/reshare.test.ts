import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleShareHttp } from "../../src/api/shares";
import { accessPrincipal, authorizeNode } from "../../src/auth/authorize";
import { readAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { ensureContentBudget } from "../../src/services/contentBudget";
import { createShareGroup, updateShareGroup } from "../../src/services/groups";
import {
  createInternalShare,
  disableShare,
  listSharedWithMe,
  readShare,
  updateInternalShare,
} from "../../src/services/shares";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

async function fixture() {
  const now = Date.now() - 1000;
  const actors = Array.from({ length: 5 }, () => foundationFixture(crypto.randomUUID(), now));
  const [owner, alice, bob, carol, dave] = actors;
  if (!owner || !alice || !bob || !carol || !dave) throw new Error("fixture_actor_missing");
  const emails = actors.map(
    (actor, index) => `reshare-${actor.ids.user.slice(0, 8)}-${index}@test.invalid`,
  );
  await atomicBatch(env.DB, [
    ...actors.flatMap((actor) => actor.statements),
    ...actors.map((actor, index) => ({
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [emails[index]!, actor.ids.user],
    })),
  ]);
  const sessions = await Promise.all(
    actors.map((actor) => readAccessSession(env.DB, actor.ids.credential, 1)),
  );
  if (sessions.some((session) => !session)) throw new Error("fixture_session_missing");
  return {
    owner,
    alice,
    bob,
    carol,
    dave,
    ownerSession: sessions[0]!,
    aliceSession: sessions[1]!,
    bobSession: sessions[2]!,
    carolSession: sessions[3]!,
    daveSession: sessions[4]!,
    ownerEmail: emails[0]!,
    aliceEmail: emails[1]!,
    bobEmail: emails[2]!,
    carolEmail: emails[3]!,
    daveEmail: emails[4]!,
  };
}

async function directSource(
  f: Awaited<ReturnType<typeof fixture>>,
  policy: { actions: string[]; maxDepth: number; maxFanout: number } = {
    actions: ["read", "download"],
    maxDepth: 3,
    maxFanout: 3,
  },
) {
  return createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.aliceEmail,
    actions: ["read", "download"],
    ttlDays: 30,
    resharePolicy: {
      enabled: true,
      actions: policy.actions,
      maxDepth: policy.maxDepth,
      maxFanout: policy.maxFanout,
      ttlDays: 20,
    },
  });
}

it("serves owner policy and exact downstream idempotency through the API", async () => {
  const f = await fixture();
  const source = await directSource(f);
  expect(source.resharePolicy).toMatchObject({
    enabled: true,
    actions: ["read", "download"],
    maxDepth: 3,
    maxFanout: 3,
    version: 1,
  });
  await expect(listSharedWithMe(env.DB, f.aliceSession)).resolves.toEqual([
    expect.objectContaining({
      shareId: source.id,
      expiresAt: source.expiresAt,
      delegationDepth: 0,
      reshareAuthority: {
        policyVersion: 1,
        actions: ["read", "download"],
        maxDepth: 3,
        maxFanout: 3,
        currentFanout: 0,
        expiresAt: source.resharePolicy?.expiresAt,
      },
    }),
  ]);
  const csrf = { verify: vi.fn(async () => undefined) };
  const serviceEnv = { ...mutationEnv(), APP_ORIGIN: "https://app.invalid" };
  const body = {
    kind: "internal",
    sourceShareId: source.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.bobEmail,
    actions: ["read", "download"],
    ttlDays: 10,
  };
  const missingKey = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    serviceEnv,
    f.aliceSession,
    csrf,
  );
  expect(missingKey.status).toBe(400);
  const create = () =>
    handleShareHttp(
      new Request("https://app.invalid/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "api-reshare-1" },
        body: JSON.stringify(body),
      }),
      serviceEnv,
      f.aliceSession,
      csrf,
    );
  const first = await create();
  expect(first.status).toBe(201);
  const created = (await first.json()) as { id: string; mountName: string };
  await expect(listSharedWithMe(env.DB, f.aliceSession)).resolves.toEqual([
    expect.objectContaining({
      shareId: source.id,
      reshareAuthority: expect.objectContaining({ currentFanout: 1 }),
    }),
  ]);
  const replay = await create();
  expect(replay.status).toBe(201);
  await expect(replay.json()).resolves.toEqual(expect.objectContaining({ id: created.id }));
  const canonicalReplay = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-reshare-1" },
      body: JSON.stringify({ ...body, recipientEmail: ` ${f.bobEmail.toUpperCase()} ` }),
    }),
    serviceEnv,
    f.aliceSession,
    csrf,
  );
  expect(canonicalReplay.status).toBe(201);
  await expect(canonicalReplay.json()).resolves.toEqual(
    expect.objectContaining({ id: created.id }),
  );
  const conflict = await handleShareHttp(
    new Request("https://app.invalid/api/v1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-reshare-1" },
      body: JSON.stringify({ ...body, recipientEmail: f.carolEmail }),
    }),
    serviceEnv,
    f.aliceSession,
    csrf,
  );
  expect(conflict.status).toBe(409);
  expect(await listSharedWithMe(env.DB, f.bobSession)).toEqual([
    expect.objectContaining({
      shareId: created.id,
      mountName: created.mountName,
      delegationDepth: 1,
      reshareAuthority: expect.objectContaining({
        policyVersion: 1,
        actions: ["read", "download"],
        maxDepth: 3,
        maxFanout: 3,
        currentFanout: 0,
      }),
    }),
  ]);
  const narrowed = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions: ["read"] }),
    }),
    serviceEnv,
    f.aliceSession,
    csrf,
  );
  expect(narrowed.status).toBe(200);
  await expect(narrowed.json()).resolves.toEqual(
    expect.objectContaining({ id: created.id, actions: ["read"], version: 2 }),
  );
  const escalation = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actions: ["read", "download"] }),
    }),
    serviceEnv,
    f.aliceSession,
    csrf,
  );
  expect(escalation.status).toBe(403);
  const revoked = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${created.id}`, { method: "DELETE" }),
    serviceEnv,
    f.aliceSession,
    csrf,
  );
  expect(revoked.status).toBe(204);
  expect(await listSharedWithMe(env.DB, f.bobSession)).toEqual([]);
  const policyUpdate = await handleShareHttp(
    new Request(`https://app.invalid/api/v1/shares/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resharePolicy: {
          enabled: false,
          actions: ["read"],
          maxDepth: 1,
          maxFanout: 1,
        },
      }),
    }),
    serviceEnv,
    f.ownerSession,
    csrf,
  );
  expect(policyUpdate.status).toBe(200);
  await expect(policyUpdate.json()).resolves.toEqual(
    expect.objectContaining({
      resharePolicy: expect.objectContaining({ enabled: false, version: 2 }),
    }),
  );
});

it("converges after response loss and enforces action, depth and fan-out bounds", async () => {
  const f = await fixture();
  const source = await directSource(f, { actions: ["read"], maxDepth: 1, maxFanout: 1 });
  const request = {
    sourceShareId: source.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.bobEmail,
    actions: ["read"],
    ttlDays: 10,
    idempotencyKey: "lost-response-1",
  };
  await expect(
    createInternalShare(mutationEnv(), f.aliceSession, {
      ...request,
      recipientEmail: f.carolEmail,
      ttlDays: 21,
      idempotencyKey: "expiry-escalation",
    }),
  ).rejects.toThrow("share_authority_exceeded");
  const db = injectBatch(
    (sql) => sql.includes("INSERT INTO share_reshare_requests"),
    async () => {
      throw new Error("response_lost");
    },
    true,
  );
  const created = await createInternalShare(mutationEnv(db, env.DB), f.aliceSession, request);
  const replay = await createInternalShare(mutationEnv(), f.aliceSession, request);
  expect(replay.id).toBe(created.id);
  await expect(
    createInternalShare(mutationEnv(), f.aliceSession, {
      ...request,
      recipientEmail: f.carolEmail,
      idempotencyKey: "fanout-2",
    }),
  ).rejects.toThrow("share_authority_exceeded");
  await expect(
    createInternalShare(mutationEnv(), f.aliceSession, {
      ...request,
      recipientEmail: f.carolEmail,
      actions: ["read", "download"],
      idempotencyKey: "action-escalation",
    }),
  ).rejects.toThrow("share_authority_exceeded");
  await expect(
    createInternalShare(mutationEnv(), f.bobSession, {
      sourceShareId: created.id,
      rootNodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
      recipientEmail: f.carolEmail,
      actions: ["read"],
      idempotencyKey: "depth-2",
    }),
  ).rejects.toThrow("share_authority_exceeded");
});

it("does not infer delegation authority from ordinary internal-share access", async () => {
  const f = await fixture();
  const source = await createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.aliceEmail,
    actions: ["read", "download"],
  });
  await expect(listSharedWithMe(env.DB, f.aliceSession)).resolves.toEqual([
    expect.objectContaining({
      shareId: source.id,
      delegationDepth: 0,
      reshareAuthority: null,
    }),
  ]);
  await expect(
    createInternalShare(mutationEnv(), f.aliceSession, {
      sourceShareId: source.id,
      rootNodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
      recipientEmail: f.bobEmail,
      actions: ["read"],
      idempotencyKey: "no-policy",
    }),
  ).rejects.toThrow("share_source_not_found");
});

it("creates a bounded downstream group share owned by the source owner", async () => {
  const f = await fixture();
  const source = await directSource(f, { actions: ["read"], maxDepth: 2, maxFanout: 2 });
  const target = await createShareGroup(mutationEnv(), f.ownerSession, {
    name: "Downstream recipients",
    memberEmails: [f.bobEmail, f.carolEmail],
  });
  const request = {
    sourceShareId: source.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientGroupId: target.id,
    actions: ["read"],
    ttlDays: 5,
    idempotencyKey: "downstream-group",
  };
  await expect(createInternalShare(mutationEnv(), f.aliceSession, request)).rejects.toThrow(
    "share_recipient_not_found",
  );
  await updateShareGroup(mutationEnv(), f.ownerSession, target.id, {
    memberEmails: [f.aliceEmail, f.bobEmail, f.carolEmail],
  });
  await createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientGroupId: target.id,
    actions: ["read"],
  });
  const nested = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO nodes(
    id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
  ) VALUES(?,?,?,?,'Nested','nested','folder',?,?)`)
    .bind(nested, f.owner.ids.space, f.owner.ids.user, f.owner.ids.folder, Date.now(), Date.now())
    .run();
  const child = await createInternalShare(mutationEnv(), f.aliceSession, {
    ...request,
    rootNodeId: nested,
  });
  expect(await listSharedWithMe(env.DB, f.bobSession)).toContainEqual(
    expect.objectContaining({
      shareId: child.id,
      actions: ["read"],
      delegationDepth: 1,
      provenance: {
        kind: "group",
        groupId: target.id,
        groupName: target.name,
        groupVersion: target.version + 1,
        membershipVersion: 1,
      },
    }),
  );
  expect(await listSharedWithMe(env.DB, f.carolSession)).toContainEqual(
    expect.objectContaining({ shareId: child.id }),
  );
  const racingRoot = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO nodes(
    id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
  ) VALUES(?,?,?,?,'Racing','racing','folder',?,?)`)
    .bind(
      racingRoot,
      f.owner.ids.space,
      f.owner.ids.user,
      f.owner.ids.folder,
      Date.now(),
      Date.now(),
    )
    .run();
  const racingDb = injectBatch(
    (sql) => sql.includes("INSERT INTO shares("),
    async () => {
      await env.DB.prepare(
        "UPDATE share_group_members SET disabled_at=? WHERE group_id=? AND user_id=?",
      )
        .bind(Date.now(), target.id, f.alice.ids.user)
        .run();
    },
    false,
  );
  await expect(
    createInternalShare(mutationEnv(racingDb), f.aliceSession, {
      ...request,
      rootNodeId: racingRoot,
      idempotencyKey: "racing-group-provenance",
    }),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM shares WHERE root_node_id=?")
      .bind(racingRoot)
      .first<number>("count"),
  ).toBe(0);
});

it("invalidates group descendants and stale budgets across removal and re-addition", async () => {
  const f = await fixture();
  const group = await createShareGroup(mutationEnv(), f.ownerSession, {
    name: "Reshare group",
    memberEmails: [f.aliceEmail],
  });
  const source = await createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientGroupId: group.id,
    actions: ["read"],
    resharePolicy: {
      enabled: true,
      actions: ["read"],
      maxDepth: 2,
      maxFanout: 2,
    },
  });
  const child = await createInternalShare(mutationEnv(), f.aliceSession, {
    sourceShareId: source.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.bobEmail,
    actions: ["read"],
    idempotencyKey: "group-child",
  });
  const grandchild = await createInternalShare(mutationEnv(), f.bobSession, {
    sourceShareId: child.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.carolEmail,
    actions: ["read"],
    idempotencyKey: "group-grandchild",
  });
  const authorized = await authorizeNode(env.DB, accessPrincipal(f.bobSession), {
    operation: "node.read",
    nodeId: f.owner.ids.file,
    spaceId: f.owner.ids.space,
  });
  const budget = await ensureContentBudget(mutationEnv(), authorized, Date.now() + 300_000, {
    id: child.id,
    version: child.version,
  });
  const grandchildAuthorized = await authorizeNode(env.DB, accessPrincipal(f.carolSession), {
    operation: "node.read",
    nodeId: f.owner.ids.file,
    spaceId: f.owner.ids.space,
  });
  const grandchildBudget = await ensureContentBudget(
    mutationEnv(),
    grandchildAuthorized,
    Date.now() + 300_000,
    { id: grandchild.id, version: grandchild.version },
  );
  await updateShareGroup(mutationEnv(), f.ownerSession, group.id, { memberEmails: [] });
  expect(await listSharedWithMe(env.DB, f.bobSession)).toEqual([]);
  expect(await listSharedWithMe(env.DB, f.carolSession)).toEqual([]);
  expect(
    await env.DB.prepare("SELECT state FROM budgets WHERE id=?")
      .bind(budget.id)
      .first<string>("state"),
  ).toBe("revoked");
  expect(
    await env.DB.prepare("SELECT state FROM budgets WHERE id=?")
      .bind(grandchildBudget.id)
      .first<string>("state"),
  ).toBe("revoked");
  await expect(
    env.DB.prepare("UPDATE share_delegation_status SET valid=1 WHERE share_id=?")
      .bind(child.id)
      .run(),
  ).rejects.toThrow("invalid_share_delegation_reactivation");
  await updateShareGroup(mutationEnv(), f.ownerSession, group.id, {
    memberEmails: [f.aliceEmail],
  });
  expect(await listSharedWithMe(env.DB, f.aliceSession)).toHaveLength(1);
  expect(await listSharedWithMe(env.DB, f.bobSession)).toEqual([]);
  await expect(
    authorizeNode(env.DB, accessPrincipal(f.bobSession), {
      operation: "node.read",
      nodeId: f.owner.ids.file,
      spaceId: f.owner.ids.space,
    }),
  ).rejects.toThrow("authorization_denied");
  const replacement = await createInternalShare(mutationEnv(), f.aliceSession, {
    sourceShareId: source.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.bobEmail,
    actions: ["read"],
    idempotencyKey: "group-child-replacement",
  });
  expect(replacement.id).not.toBe(child.id);
  expect(await listSharedWithMe(env.DB, f.bobSession)).toEqual([
    expect.objectContaining({ shareId: replacement.id }),
  ]);
});

it("preserves mount names on rename and invalidates descendants on root moves and source lifecycle", async () => {
  const f = await fixture();
  const nested = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO nodes(
      id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
    ) VALUES(?,?,?,?,'Nested','nested','folder',?,?)`,
  )
    .bind(nested, f.owner.ids.space, f.owner.ids.user, f.owner.ids.folder, Date.now(), Date.now())
    .run();
  const source = await directSource(f);
  const child = await createInternalShare(mutationEnv(), f.aliceSession, {
    sourceShareId: source.id,
    rootNodeId: nested,
    spaceId: f.owner.ids.space,
    recipientEmail: f.bobEmail,
    actions: ["read"],
    idempotencyKey: "root-child",
  });
  const mountName = (await listSharedWithMe(env.DB, f.bobSession))[0]?.mountName;
  await env.DB.prepare("UPDATE nodes SET name='Renamed',name_ci='renamed' WHERE id=?")
    .bind(nested)
    .run();
  expect((await listSharedWithMe(env.DB, f.bobSession))[0]?.mountName).toBe(mountName);
  await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
    .bind(f.owner.ids.root, nested)
    .run();
  expect(await listSharedWithMe(env.DB, f.bobSession)).toEqual([]);

  const source2 = await createInternalShare(mutationEnv(), f.ownerSession, {
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.carolEmail,
    actions: ["read", "download", "create", "edit"],
    resharePolicy: {
      enabled: true,
      actions: ["read", "download", "create", "edit"],
      maxDepth: 2,
      maxFanout: 2,
    },
  });
  const child2 = await createInternalShare(mutationEnv(), f.carolSession, {
    sourceShareId: source2.id,
    rootNodeId: f.owner.ids.folder,
    spaceId: f.owner.ids.space,
    recipientEmail: f.daveEmail,
    actions: ["read"],
    idempotencyKey: "lifecycle-child",
  });
  await updateInternalShare(mutationEnv(), f.ownerSession, source2.id, {
    actions: ["read", "create"],
  });
  expect(await readShare(env.DB, f.ownerSession, source2.id)).toMatchObject({
    actions: ["read", "create"],
    resharePolicy: {
      actions: ["read", "create"],
      version: 2,
    },
  });
  expect(await listSharedWithMe(env.DB, f.daveSession)).toEqual([]);
  await expect(disableShare(mutationEnv(), f.carolSession, child2.id)).rejects.toThrow(
    "share_not_found",
  );
  expect(
    await env.DB.prepare("SELECT valid FROM share_delegation_status WHERE share_id=?")
      .bind(child2.id)
      .first<number>("valid"),
  ).toBe(0);
  expect(child.id).not.toBe(child2.id);
});
