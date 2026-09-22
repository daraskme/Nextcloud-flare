import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { lockTokenHashes } from "../../src/auth/locks";
import { registerAccessSession } from "../../src/auth/sessions";
import { atomicBatch } from "../../src/db/primary";
import { type CreatePermitRequest, LockDO, type RenamePermitRequest } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { foundationFixture } from "../fixtures/foundation";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.BACKUPS.put(
    "sys/epoch/1.json",
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  await env.CONTROL.get(env.CONTROL.idFromName("singleton")).recover();
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const request: CreatePermitRequest = {
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    principal: { kind: "user", user_id: f.ids.user, credential_id: f.ids.credential, epoch: 1 },
    lockTokens: [],
  };
  const stub = env.LOCKS.get(env.LOCKS.idFromName(f.ids.space));
  return { ...f, request, stub };
}

// Test-only admission fixture. Production ControlDO remains closed until its recovery verifier exists.
function admitted(maintenance = false, epoch = 1, db = env.DB): Env {
  return {
    ...env,
    DB: db,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({ status: async () => ({ epoch, maintenance, gcPaused: true }) }),
    } as unknown as Env["CONTROL"],
  };
}

async function initialize(f: Awaited<ReturnType<typeof fixture>>) {
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    const request = { ...f.request, requestId: crypto.randomUUID() };
    const permit = await instance.acquireCreate(request);
    await instance.release(request.requestId, permit);
  });
}

it("persists create intent through eviction and refuses changed or terminal intents", async () => {
  const f = await fixture();
  const permit = await runInDurableObject(f.stub, async (_, state) =>
    new LockDO(state, admitted()).acquireCreate(f.request),
  );
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    expect(await instance.acquireCreate(f.request)).toEqual(permit);
    await expect(instance.acquireCreate({ ...f.request, parentId: f.ids.root })).rejects.toThrow(
      "lock_intent_conflict",
    );
    await instance.release(f.request.requestId, permit);
    await expect(instance.acquireCreate(f.request)).rejects.toThrow();
  });
});

it("persists a rename permit and rejects a changed target on replay", async () => {
  const f = await fixture();
  const request: RenamePermitRequest = {
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.file,
    principal: f.request.principal,
    lockTokens: [],
  };
  const permit = await runInDurableObject(f.stub, async (_, state) =>
    new LockDO(state, admitted()).acquireRename(request),
  );
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    expect(await instance.acquireRename(request)).toEqual(permit);
    await expect(instance.acquireRename({ ...request, nodeId: f.ids.folder })).rejects.toThrow(
      "lock_intent_conflict",
    );
    await instance.release(request.requestId, permit);
  });
});

it("requires both target and parent lock tokens for rename", async () => {
  const f = await fixture();
  await initialize(f);
  const targetToken = crypto.randomUUID();
  const parentToken = crypto.randomUUID();
  const [targetHash] = await lockTokenHashes([targetToken]);
  const [parentHash] = await lockTokenHashes([parentToken]);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO locks VALUES(?,?,?,?,?,'0','owner',1,?)",
      values: [
        crypto.randomUUID(),
        f.ids.file,
        f.ids.space,
        f.ids.credential,
        targetHash ?? "",
        Date.now() + 60_000,
      ],
    },
    {
      sql: "INSERT INTO locks VALUES(?,?,?,?,?,'0','owner',1,?)",
      values: [
        crypto.randomUUID(),
        f.ids.folder,
        f.ids.space,
        f.ids.credential,
        parentHash ?? "",
        Date.now() + 60_000,
      ],
    },
  ]);
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    const request: RenamePermitRequest = {
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      nodeId: f.ids.file,
      principal: f.request.principal,
      lockTokens: [targetToken],
    };
    await expect(instance.acquireRename(request)).rejects.toThrow();
    await expect(
      instance.acquireRename({
        ...request,
        requestId: crypto.randomUUID(),
        lockTokens: [parentToken],
      }),
    ).rejects.toThrow();
    const both = {
      ...request,
      requestId: crypto.randomUUID(),
      lockTokens: [targetToken, parentToken],
    };
    const permit = await instance.acquireRename(both);
    await instance.release(both.requestId, permit);
  });
});

it("serializes simultaneous first acquisitions even when the local initialization overlaps", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    const result = await Promise.allSettled([
      instance.acquireCreate(f.request),
      instance.acquireCreate({ ...f.request, requestId: crypto.randomUUID() }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM permits WHERE space_id=? AND state='open'")
        .bind(f.ids.space)
        .first("n"),
    ).toBe(1);
  });
});

it("cannot admit through the real closed ControlDO or a wrong namespace/epoch", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (instance, state) => {
    await expect(instance.acquireCreate(f.request)).rejects.toThrow();
    const admittedInstance = new LockDO(state, admitted());
    await expect(
      admittedInstance.acquireCreate({ ...f.request, spaceId: "different" }),
    ).rejects.toThrow("lock_namespace_mismatch");
    await expect(
      admittedInstance.acquireCreate({
        ...f.request,
        principal: { ...f.request.principal, epoch: 2 },
      }),
    ).rejects.toThrow("admission_closed");
  });
});

it("requires a new ControlDO epoch after complete local storage loss", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    await instance.acquireCreate(f.request);
    await state.storage.deleteAll();
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (_, state) => {
    await expect(new LockDO(state, admitted()).acquireCreate(f.request)).rejects.toThrow(
      "lock_recovery_required",
    );
    await env.DB.prepare("UPDATE control SET epoch=2,maintenance=1").run();
    await new LockDO(state, admitted(true, 2)).recover(f.ids.space, 2);
    await env.DB.prepare("UPDATE control SET maintenance=0").run();
    const now = Math.floor(Date.now() / 1000);
    const session = await registerAccessSession(
      env.DB,
      { iss: "https://access.invalid", sub: f.ids.user, iat: now, exp: now + 3600 },
      2,
    );
    const next = await new LockDO(state, admitted(false, 2)).acquireCreate({
      ...f.request,
      requestId: crypto.randomUUID(),
      principal: {
        kind: "user",
        user_id: f.ids.user,
        credential_id: session.credential_id,
        epoch: 2,
      },
    });
    expect(next.epoch).toBe(2);
  });
});

it.each(["parent-zero", "ancestor-infinity", "ancestor-zero"])(
  "enforces %s locks using current ancestors and submitted token",
  async (kind) => {
    const f = await fixture();
    await initialize(f);
    const token = crypto.randomUUID();
    const [hash] = await lockTokenHashes([token]);
    await env.DB.prepare("INSERT INTO locks VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        kind === "parent-zero" ? f.ids.folder : f.ids.root,
        f.ids.space,
        f.ids.credential,
        hash ?? "",
        kind === "ancestor-infinity" ? "infinity" : "0",
        "owner",
        1,
        Date.now() + 60000,
      )
      .run();
    await runInDurableObject(f.stub, async (_, state) => {
      const instance = new LockDO(state, admitted());
      if (kind !== "ancestor-zero") {
        await expect(instance.acquireCreate(f.request)).rejects.toThrow();
        await expect(
          instance.acquireCreate({
            ...f.request,
            requestId: crypto.randomUUID(),
            lockTokens: ["wrong"],
          }),
        ).rejects.toThrow();
      }
      const request = { ...f.request, requestId: crypto.randomUUID(), lockTokens: [token] };
      const permit = await instance.acquireCreate(request);
      const stored = state.storage.sql.exec("SELECT digest FROM permit_intents").toArray();
      expect(JSON.stringify(stored)).not.toContain(token);
      await instance.release(request.requestId, permit);
      if (kind === "ancestor-zero")
        await expect(instance.acquireCreate(f.request)).resolves.toBeDefined();
    });
  },
);

it("does not let another granted user use the lock creator's token", async () => {
  const f = await fixture();
  await initialize(f);
  const other = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, other.statements);
  const token = crypto.randomUUID();
  const [hash] = await lockTokenHashes([token]);
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO locks VALUES(?,?,?,?,?,'0','owner',1,?)",
      values: [
        f.ids.user,
        f.ids.folder,
        f.ids.space,
        f.ids.credential,
        hash ?? "",
        Date.now() + 60000,
      ],
    },
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',?)",
      values: [f.ids.user, f.ids.user, f.ids.folder, Date.now()],
    },
    { sql: "INSERT INTO share_actions VALUES(?,'create')", values: [f.ids.user] },
    {
      sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
      values: [f.ids.user, other.ids.user],
    },
  ]);
  const principal: Principal = {
    kind: "user",
    user_id: other.ids.user,
    credential_id: other.ids.credential,
    epoch: 1,
  };
  await expect(
    authorizeNode(env.DB, principal, {
      operation: "node.create",
      parentId: f.ids.folder,
      spaceId: f.ids.space,
    }),
  ).resolves.toBeDefined();
  await runInDurableObject(f.stub, async (_, state) => {
    await expect(
      new LockDO(state, admitted()).acquireCreate({
        ...f.request,
        lockTokens: [token],
        principal,
      }),
    ).rejects.toThrow();
  });
});

it("allows the same user's scoped app password to submit a session-created lock token", async () => {
  const f = await fixture();
  await initialize(f);
  const token = crypto.randomUUID();
  const [hash] = await lockTokenHashes([token]);
  const id = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO locks VALUES(?,?,?,?,?,'0','owner',1,?)",
      values: [id, f.ids.folder, f.ids.space, f.ids.credential, hash ?? "", Date.now() + 60000],
    },
    {
      sql: `INSERT INTO app_passwords(id,user_id,root_node_id,name,secret_digest,salt,kdf,kdf_params,kid,created_at,expires_at)
      VALUES(?,?,?,'test','digest','salt','PBKDF2-SHA256','{"iterations":100000}','k1',?,?)`,
      values: [id, f.ids.user, f.ids.folder, Date.now(), Date.now() + 60000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,app_password_id) VALUES(?,'app_password',?)",
      values: [`ap:${id}`, id],
    },
    { sql: "INSERT INTO credential_scopes VALUES(?,'node:create')", values: [`ap:${id}`] },
  ]);
  await runInDurableObject(f.stub, async (_, state) => {
    const instance = new LockDO(state, admitted());
    const request = {
      ...f.request,
      lockTokens: [token],
      principal: {
        kind: "app_password" as const,
        user_id: f.ids.user,
        credential_id: `ap:${id}`,
        epoch: 1,
      },
    };
    await expect(instance.acquireCreate(request)).resolves.toBeDefined();
    await env.DB.prepare("DELETE FROM credential_scopes WHERE credential_id=?")
      .bind(`ap:${id}`)
      .run();
    await expect(instance.acquireCreate(request)).rejects.toThrow();
  });
  await expect(
    env.DB.prepare("UPDATE app_passwords SET user_id='changed' WHERE id=?").bind(id).run(),
  ).rejects.toThrow(/immutable_app_password_identity/);
});
