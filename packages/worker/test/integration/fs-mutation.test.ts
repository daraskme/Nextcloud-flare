import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleNodeMutationHttp } from "../../src/api/nodeMutations";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { lockTokenHashes } from "../../src/auth/locks";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { claimOperation, operationIntent, operationRow } from "../../src/jobs/operations";
import {
  CREATE_FOLDER_STEPS,
  type CreateFolderRequest,
  createFolder,
  folderMutationPlan,
} from "../../src/services/createFolder";
import { fsMutation, type MutationPlan } from "../../src/services/fsMutation";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation, grantPermit } from "../fixtures/mutationAdmission";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});

it("creates a folder through the private HTTP bridge and replays its operation", async () => {
  const f = await fixture();
  const appEnv = { ...env, ...admitted(), APP_ORIGIN: "https://app.invalid" };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, appEnv.APP_ORIGIN);
  const csrfIssued = await csrf.issue(
    env.DB,
    new Request("https://app.invalid/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: f.principal.credential_id, epoch: 1 },
  );
  const headers = {
    Origin: appEnv.APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfIssued.token,
    "Idempotency-Key": f.request.idempotencyKey,
  };
  const body = JSON.stringify({
    kind: "folder",
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: f.request.name,
  });
  const send = (requestHeaders = headers, requestBody = body) =>
    handleNodeMutationHttp(
      new Request("https://app.invalid/api/v1/nodes", {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
      }),
      appEnv,
      f.principal,
      csrf,
    );
  const noCsrf = await send({ ...headers, "X-CSRF-Token": "" });
  expect(noCsrf.status).toBe(403);
  const created = await send();
  expect(created.status).toBe(201);
  const operation = await created.json<{ id: string; result: { nodeId: string } }>();
  expect(operation.result.nodeId).toBeTruthy();
  expect(
    await env.DB.prepare("SELECT name FROM nodes WHERE id=?")
      .bind(operation.result.nodeId)
      .first("name"),
  ).toBe(f.request.name);
  const replay = await send();
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ id: operation.id, result: operation.result });
  const lookup = await handleNodeMutationHttp(
    new Request(`https://app.invalid/api/v1/operations/${operation.id}`),
    appEnv,
    f.principal,
    csrf,
  );
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toMatchObject({ id: operation.id, state: "committed" });
  expect((await send(headers, body.replace(f.request.name, "別名"))).status).toBe(409);
});

async function fixture() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const request: CreateFolderRequest = {
    principal,
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    parentId: f.ids.folder,
    name: "新しいフォルダー",
    lockTokens: [],
  };
  return { ...f, principal, request };
}

async function planned() {
  const f = await fixture();
  const intent = await operationIntent(
    f.principal,
    f.request.idempotencyKey,
    f.ids.space,
    "node.create",
    { kind: "folder", parentId: f.ids.folder, name: f.request.name },
    { parentId: f.ids.folder },
  );
  const permit = await grantPermit(env.DB, `p:${intent.id}`, f.ids.space, 1);
  const authorized = await authorizeNode(env.DB, f.principal, {
    operation: "node.create",
    parentId: f.ids.folder,
    spaceId: f.ids.space,
  });
  if (authorized.operation !== "node.create") throw new Error("missing_create_proof");
  const claimed = await claimOperation(env.DB, intent, permit, authorized, CREATE_FOLDER_STEPS);
  if (claimed.kind !== "claimed") throw new Error("missing_claim");
  const plan = folderMutationPlan(claimed.claim, authorized, f.request.name, []);
  return { ...f, plan };
}

// Real LockDO/SQLite/D1 with test-only admission. Production admission remains closed.
function admitted(): Pick<Env, "DB" | "LOCKS"> {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    DB: env.DB,
    LOCKS: {
      idFromName: env.LOCKS.idFromName.bind(env.LOCKS),
      get(id: DurableObjectId) {
        const stub = env.LOCKS.get(id);
        const invoke = async <T>(callback: (instance: LockDO) => Promise<T>): Promise<T> => {
          const result = await runInDurableObject(stub, async (_, state) => {
            try {
              return { ok: true as const, value: await callback(new LockDO(state, doEnv)) };
            } catch (error) {
              return {
                ok: false as const,
                message: error instanceof Error ? error.message : "lock_error",
              };
            }
          });
          if (!result.ok) throw new Error(result.message);
          return result.value;
        };
        return {
          acquireCreate: (request: Parameters<LockDO["acquireCreate"]>[0]) =>
            invoke((lock) => lock.acquireCreate(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

async function effects(plan: MutationPlan) {
  const [node, parent, tree, steps, activity, outbox, search, quota] = await Promise.all([
    env.DB.prepare("SELECT id,name,name_ci,hidden FROM nodes WHERE id=?")
      .bind(plan.result.nodeId)
      .first(),
    env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(plan.authorized.parent.id)
      .first("revision"),
    env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(plan.authorized.spaceId)
      .first("tree_generation"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM operation_steps WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("n"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("n"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("n"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM search_index WHERE node_id=?")
      .bind(plan.result.nodeId)
      .first("n"),
    env.DB.prepare("SELECT used_bytes,reserved_bytes,physical_bytes FROM users WHERE id=?")
      .bind(plan.authorized.parent.owner_id)
      .first(),
  ]);
  return { node, parent, tree, steps, activity, outbox, search, quota };
}

it("commits node, collection revision, tree, FTS, activity, outbox and terminal state together", async () => {
  const f = await planned();
  const result = await fsMutation(env.DB, f.plan);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: {
      state: "committed",
      result: { status: 201, nodeId: f.plan.result.nodeId, revision: 1 },
    },
  });
  expect(await effects(f.plan)).toEqual({
    node: { id: f.plan.result.nodeId, name: f.request.name, name_ci: f.request.name, hidden: 0 },
    parent: 2,
    tree: 2,
    steps: 7,
    activity: 1,
    outbox: 1,
    search: 1,
    quota: { used_bytes: 3, reserved_bytes: 0, physical_bytes: 0 },
  });
  expect(
    await env.DB.prepare(
      "SELECT si.node_id FROM search_fts JOIN search_index si ON si.rowid=search_fts.rowid WHERE search_fts MATCH ? AND si.node_id=?",
    )
      .bind('tokens:"新し"', f.plan.result.nodeId)
      .first("node_id"),
  ).toBe(f.plan.result.nodeId);
  expect(
    await env.DB.prepare("SELECT state FROM outbox WHERE op_id=?")
      .bind(f.plan.claim.intent.id)
      .first("state"),
  ).toBe("pending");
});

it.each(["node", "parent", "tree", "search_index", "search_fts", "activity", "outbox"])(
  "rolls back every effect when mandatory %s write affects zero rows",
  async (kind) => {
    const f = await planned();
    const before = await effects(f.plan);
    const broken = {
      ...f.plan,
      steps: f.plan.steps.map((step) =>
        step.kind === kind
          ? { ...step, statement: { sql: "UPDATE nodes SET revision=revision WHERE id='missing'" } }
          : step,
      ),
    };
    expect(await fsMutation(env.DB, broken)).toMatchObject({
      kind: "terminal",
      operation: { state: "failed", errorCode: "mutation_rejected" },
    });
    expect(await effects(f.plan)).toEqual(before);
  },
);

it("rolls back namespace and outbox when the final terminal CAS affects zero rows", async () => {
  const f = await planned();
  const before = await effects(f.plan);
  const failing = {
    prepare: (sql: string) =>
      env.DB.prepare(
        sql.startsWith("UPDATE operations SET state='committed'")
          ? sql.replace("WHERE op_id=?", "WHERE 0 AND op_id=?")
          : sql,
      ),
    batch: env.DB.batch.bind(env.DB),
  } as unknown as D1Database;
  expect(await fsMutation(failing, f.plan)).toMatchObject({
    kind: "terminal",
    operation: { state: "failed" },
  });
  expect(await effects(f.plan)).toEqual(before);
});

it("reconciles a lost commit response and never duplicates side effects on a retry", async () => {
  const f = await planned();
  let writes = 0;
  const lossy = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      writes++;
      await env.DB.batch(statements);
      throw new Error("response_lost");
    },
  } as unknown as D1Database;
  expect(await fsMutation(lossy, f.plan)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(writes).toBe(1);
  const committed = await effects(f.plan);
  expect(await fsMutation(env.DB, f.plan)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(await effects(f.plan)).toEqual(committed);
});

it("does not mark an uncertain transport outcome failed and can resume under the same permit", async () => {
  const f = await planned();
  const before = await effects(f.plan);
  const unknown = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async () => {
      throw new Error("network_timeout");
    },
  } as unknown as D1Database;
  expect(await fsMutation(unknown, f.plan)).toEqual({
    kind: "commit_unknown",
    operationId: f.plan.claim.intent.id,
  });
  expect((await operationRow(env.DB, f.plan.claim.intent.id))?.state).toBe("claimed");
  expect(await effects(f.plan)).toEqual(before);
  expect(await fsMutation(env.DB, f.plan)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
});

it.each(["session", "parent", "tree", "epoch", "maintenance", "permit", "lock"])(
  "blocks a stale %s at commit before any namespace writes",
  async (condition) => {
    const f = await planned();
    if (condition === "session")
      await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
        .bind(Date.now(), f.ids.session)
        .run();
    if (condition === "parent")
      await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
        .bind(f.ids.folder)
        .run();
    if (condition === "tree")
      await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
        .bind(f.ids.space)
        .run();
    if (condition === "epoch") await env.DB.prepare("UPDATE control SET epoch=2").run();
    if (condition === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
    if (condition === "permit")
      await env.DB.prepare("UPDATE permits SET state='revoked' WHERE permit_id=?")
        .bind(f.plan.claim.permit.permit_id)
        .run();
    if (condition === "lock") {
      const [hash] = await lockTokenHashes(["new-lock"]);
      await env.DB.prepare(
        "INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at) VALUES(?,?,?,?,?,'/dav/Folder/','0','owner',1,?)",
      )
        .bind(
          crypto.randomUUID(),
          f.ids.folder,
          f.ids.space,
          f.ids.credential,
          hash ?? "",
          Date.now() + 60000,
        )
        .run();
    }
    const before = await effects(f.plan);
    const result = await fsMutation(env.DB, f.plan);
    expect(result.kind === "terminal" && result.operation.state === "committed").toBe(false);
    expect(await effects(f.plan)).toEqual(before);
  },
);

it("connects the create service to LockDO and replays a normalized intent after release", async () => {
  const f = await fixture();
  const runtime = admitted();
  const first = await createFolder(runtime, { ...f.request, name: "e\u0301" });
  expect(first).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await createFolder(runtime, { ...f.request, name: "é" })).toEqual(first);
  await expect(createFolder(runtime, { ...f.request, name: "different" })).rejects.toThrow(
    "idempotency_conflict",
  );
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM permits WHERE space_id=? AND state='released'")
      .bind(f.ids.space)
      .first("n"),
  ).toBe(1);
});

it("rejects casefold collisions without publishing a partial folder or double-incrementing its parent", async () => {
  const f = await fixture();
  const runtime = admitted();
  expect(await createFolder(runtime, { ...f.request, name: "Straße" })).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  const request = { ...f.request, idempotencyKey: crypto.randomUUID(), name: "STRASSE" };
  const conflict = await createFolder(runtime, request);
  expect(conflict).toMatchObject({
    kind: "terminal",
    operation: { state: "failed", errorCode: "name_conflict" },
  });
  expect(await createFolder(runtime, request)).toEqual(conflict);
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(f.ids.folder)
      .first("revision"),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE op_id IN (SELECT op_id FROM operations WHERE space_id=?)",
    )
      .bind(f.ids.space)
      .first("n"),
  ).toBe(1);
});

it("publishes one folder and one outbox record when two workers execute the same claim", async () => {
  const f = await planned();
  const results = await Promise.all([fsMutation(env.DB, f.plan), fsMutation(env.DB, f.plan)]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await effects(f.plan)).toMatchObject({
    parent: 2,
    tree: 2,
    steps: 7,
    activity: 1,
    outbox: 1,
  });
});
