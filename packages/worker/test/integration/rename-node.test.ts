import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleNodeMutationHttp, nodeMutationRoute } from "../../src/api/nodeMutations";
import { authorizeNode, type Principal } from "../../src/auth/authorize";
import { CsrfTokens, csrfKeyRing } from "../../src/auth/csrf";
import { lockTokenHashes } from "../../src/auth/locks";
import { atomicBatch } from "../../src/db/primary";
import { LockDO } from "../../src/do/LockDO";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { claimOperation, operationIntent } from "../../src/jobs/operations";
import { copyNode } from "../../src/services/copyNode";
import { createFolder } from "../../src/services/createFolder";
import { commitMutationStatements } from "../../src/services/fsMutation";
import { moveNode } from "../../src/services/moveNode";
import { purgeTrash } from "../../src/services/purgeTrash";
import {
  RENAME_NODE_STEPS,
  renameMutationPlan,
  renameMutationStatements,
  renameNode,
} from "../../src/services/renameNode";
import { restoreTrash } from "../../src/services/restoreTrash";
import { trashNode } from "../../src/services/trashNode";
import { foundationFixture } from "../fixtures/foundation";
import { acquireMutation, grantPermit, mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run());

async function seeded() {
  const f = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, f.statements);
  const old = searchName("元の名前");
  await env.DB.prepare("UPDATE nodes SET name='元の名前',name_ci='元の名前' WHERE id=?")
    .bind(f.ids.folder)
    .run();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [f.ids.folder, f.ids.space, old.textNorm, old.tokens, old.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.folder],
    },
  ]);
  const principal: Principal = {
    kind: "user",
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  return { f, principal };
}

async function planned() {
  const { f, principal } = await seeded();
  const name = "新しい名前";
  const authorized = await authorizeNode(env.DB, principal, {
    operation: "node.rename",
    nodeId: f.ids.folder,
    spaceId: f.ids.space,
  });
  if (authorized.operation !== "node.rename") throw new Error("missing_rename_proof");
  const intent = await operationIntent(
    principal,
    crypto.randomUUID(),
    f.ids.space,
    "node.rename",
    { nodeId: f.ids.folder, name },
    { nodeId: f.ids.folder, parentId: authorized.parentId },
  );
  const permit = await grantPermit(env.DB, `p:${intent.id}`, f.ids.space, 1);
  const claimed = await claimOperation(env.DB, intent, permit, authorized, RENAME_NODE_STEPS);
  if (claimed.kind !== "claimed") throw new Error("missing_claim");
  const parentRevision = await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
    .bind(authorized.parentId)
    .first<number>("revision");
  if (parentRevision === null) throw new Error("missing_parent");
  return { f, plan: renameMutationPlan(claimed.claim, authorized, parentRevision, name, []) };
}

function admitted(overloaded = false): Pick<Env, "DB" | "LOCKS" | "CONTROL"> {
  const doEnv = {
    ...env,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        acquireMutation: overloaded
          ? async () => {
              throw new Error("mutation_unavailable");
            }
          : acquireMutation,
        status: async () => ({ epoch: 1, maintenance: false, gcPaused: true }),
        // Namespace-only fixture. Real pause/dispatch/alarm races are tested separately.
        acquireRestorePause: async (epoch: number, operationId: string) => {
          const token = crypto.randomUUID(),
            expiresAt = Date.now() + 300_000;
          const ready =
            (await env.DB.prepare(
              "SELECT 1 FROM gc_candidates WHERE state='deleting' LIMIT 1",
            ).first()) === null;
          if (ready)
            await env.DB.prepare(
              "UPDATE control SET gc_paused=1,gc_hold_token=?,gc_hold_operation=?,gc_hold_expires_at=? WHERE epoch=?",
            )
              .bind(token, operationId, expiresAt, epoch)
              .run();
          return { epoch, operationId, token, expiresAt, ready };
        },
        releaseRestorePause: async (epoch: number, token: string) => {
          await env.DB.prepare(
            "UPDATE control SET gc_hold_token=NULL,gc_hold_operation=NULL,gc_hold_expires_at=NULL WHERE epoch=? AND gc_hold_token=?",
          )
            .bind(epoch, token)
            .run();
        },
      }),
    } as unknown as Env["CONTROL"],
  };
  return {
    DB: env.DB,
    CONTROL: doEnv.CONTROL,
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
          acquireRename: (request: Parameters<LockDO["acquireRename"]>[0]) =>
            invoke((lock) => lock.acquireRename(request)),
          acquireMove: (request: Parameters<LockDO["acquireMove"]>[0]) =>
            invoke((lock) => lock.acquireMove(request)),
          acquireCopy: (request: Parameters<LockDO["acquireCopy"]>[0]) =>
            invoke((lock) => lock.acquireCopy(request)),
          acquireTrash: (request: Parameters<LockDO["acquireTrash"]>[0]) =>
            invoke((lock) => lock.acquireTrash(request)),
          acquireRestore: (request: Parameters<LockDO["acquireRestore"]>[0]) =>
            invoke((lock) => lock.acquireRestore(request)),
          acquirePurge: (request: Parameters<LockDO["acquirePurge"]>[0]) =>
            invoke((lock) => lock.acquirePurge(request)),
          release: (requestId: string, permit: Parameters<LockDO["release"]>[1]) =>
            invoke((lock) => lock.release(requestId, permit)),
        };
      },
    } as unknown as Env["LOCKS"],
  };
}

it("returns a retryable HTTP 503 without modifying the node when mutation admission is full", async () => {
  const { f, principal } = await seeded();
  const appEnv = { ...env, ...admitted(true), APP_ORIGIN: "https://app.invalid" };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, appEnv.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request("https://app.invalid/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: principal.credential_id, epoch: 1 },
  );
  const response = await handleNodeMutationHttp(
    new Request(`https://app.invalid/api/v1/nodes/${f.ids.folder}`, {
      method: "PATCH",
      headers: {
        Origin: appEnv.APP_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "X-CSRF-Token": issued.token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ spaceId: f.ids.space, name: "overloaded", lockTokens: [] }),
    }),
    appEnv,
    principal,
    csrf,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(
    await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(f.ids.folder).first("name"),
  ).toBe("元の名前");
});

it("renames through the private HTTP bridge and replays its operation", async () => {
  const { f, principal } = await seeded();
  const appEnv = { ...env, ...admitted(), APP_ORIGIN: "https://app.invalid" };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, appEnv.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request("https://app.invalid/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: principal.credential_id, epoch: 1 },
  );
  const url = `https://app.invalid/api/v1/nodes/${f.ids.folder}`;
  const headers = {
    Origin: appEnv.APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    "X-CSRF-Token": issued.token,
    "Idempotency-Key": crypto.randomUUID(),
  };
  const body = JSON.stringify({ spaceId: f.ids.space, name: "HTTP 経由の名前" });
  const send = (requestHeaders = headers, requestBody = body) =>
    handleNodeMutationHttp(
      new Request(url, { method: "PATCH", headers: requestHeaders, body: requestBody }),
      appEnv,
      principal,
      csrf,
    );
  expect(nodeMutationRoute(new Request(url, { method: "PATCH" }))).toBe(true);
  expect((await send({ ...headers, "X-CSRF-Token": "" })).status).toBe(403);
  const renamed = await send();
  expect(renamed.status).toBe(200);
  const operation = await renamed.json<{ id: string; result: { nodeId: string } }>();
  expect(operation.result.nodeId).toBe(f.ids.folder);
  expect(
    await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(f.ids.folder).first("name"),
  ).toBe("HTTP 経由の名前");
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ id: operation.id, result: operation.result });
  const lookup = await handleNodeMutationHttp(
    new Request(`https://app.invalid/api/v1/operations/${operation.id}`),
    appEnv,
    principal,
    csrf,
  );
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toMatchObject({ id: operation.id, state: "committed" });
  expect((await send(headers, body.replace("HTTP 経由の名前", "別名"))).status).toBe(409);
});

it("copies, moves, and trashes through the private REST bridge", async () => {
  const { f, principal } = await seeded();
  const fileSearch = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        VALUES(?,?,?,?,?,1)`,
      values: [f.ids.file, f.ids.space, fileSearch.textNorm, fileSearch.tokens, fileSearch.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const appEnv = { ...env, ...admitted(), APP_ORIGIN: "https://app.invalid" };
  const secret = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const ring = await csrfKeyRing("test", { test: secret });
  const csrf = new CsrfTokens(ring, ring, appEnv.APP_ORIGIN);
  const issued = await csrf.issue(
    env.DB,
    new Request("https://app.invalid/api/v1/csrf", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    }),
    { kind: "access", credentialId: principal.credential_id, epoch: 1 },
  );
  const send = (path: string, method: string, body: Record<string, unknown>, key: string) =>
    handleNodeMutationHttp(
      new Request(`https://app.invalid${path}`, {
        method,
        headers: {
          Origin: appEnv.APP_ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": issued.token,
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      }),
      appEnv,
      principal,
      csrf,
    );
  const base = { spaceId: f.ids.space, lockTokens: [] };
  const copyKey = crypto.randomUUID();
  const copyPath = `/api/v1/nodes/${f.ids.file}/copy`;
  expect(nodeMutationRoute(new Request(`https://app.invalid${copyPath}`, { method: "POST" }))).toBe(
    true,
  );
  const copyBody = {
    ...base,
    destinationParentId: f.ids.root,
    name: "REST copy",
    depth: "0",
  };
  const copied = await send(copyPath, "POST", copyBody, copyKey);
  expect(copied.status).toBe(201);
  const copyOperation = await copied.json<{
    id: string;
    result: { nodeId: string };
  }>();
  expect(
    await env.DB.prepare("SELECT kind,name FROM nodes WHERE id=?")
      .bind(copyOperation.result.nodeId)
      .first(),
  ).toEqual({ kind: "file", name: "REST copy" });
  const copyRow = await env.DB.prepare("SELECT kind FROM operations WHERE op_id=?")
    .bind(copyOperation.id)
    .first("kind");
  expect(copyRow).toBe("node.copy");
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(copyOperation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${copyOperation.id}_event`)).toBe("completed");
  expect(await (await send(copyPath, "POST", copyBody, copyKey)).json()).toMatchObject({
    id: copyOperation.id,
  });
  expect((await send(copyPath, "POST", { ...base }, copyKey)).status).toBe(400);

  const moveKey = crypto.randomUUID();
  const movePath = `/api/v1/nodes/${copyOperation.result.nodeId}/move`;
  const moveBody = { ...base, destinationParentId: f.ids.folder, name: "REST moved" };
  const moved = await send(movePath, "POST", moveBody, moveKey);
  expect(moved.status).toBe(200);
  const moveOperation = await moved.json<{ id: string }>();
  expect(
    await env.DB.prepare("SELECT parent_id,name FROM nodes WHERE id=?")
      .bind(copyOperation.result.nodeId)
      .first(),
  ).toEqual({ parent_id: f.ids.folder, name: "REST moved" });
  expect(
    await env.DB.prepare("SELECT kind FROM operations WHERE op_id=?")
      .bind(moveOperation.id)
      .first("kind"),
  ).toBe("node.move");
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(moveOperation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${moveOperation.id}_event`)).toBe("completed");
  expect(await (await send(movePath, "POST", moveBody, moveKey)).json()).toMatchObject({
    id: moveOperation.id,
  });

  const trashKey = crypto.randomUUID();
  const trashPath = `/api/v1/nodes/${copyOperation.result.nodeId}`;
  expect(
    nodeMutationRoute(new Request(`https://app.invalid${trashPath}`, { method: "DELETE" })),
  ).toBe(true);
  const trashed = await send(trashPath, "DELETE", base, trashKey);
  expect(trashed.status).toBe(200);
  const trashOperation = await trashed.json<{ id: string }>();
  expect(
    await env.DB.prepare("SELECT deleted_at IS NOT NULL AS deleted FROM nodes WHERE id=?")
      .bind(copyOperation.result.nodeId)
      .first("deleted"),
  ).toBe(1);
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(trashOperation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${trashOperation.id}_event`)).toBe("completed");
  expect((await send(trashPath, "DELETE", base, trashKey)).status).toBe(200);
  await env.DB.prepare(
    `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'folder',?,?)`,
  )
    .bind(
      `${f.ids.root}-restore-conflict`,
      f.ids.space,
      f.ids.user,
      f.ids.root,
      "REST moved",
      "rest moved",
      Date.now(),
      Date.now(),
    )
    .run();

  const restoreKey = crypto.randomUUID();
  const restorePath = `/api/v1/trash/${trashOperation.id}/restore`;
  expect(
    nodeMutationRoute(new Request(`https://app.invalid${restorePath}`, { method: "POST" })),
  ).toBe(true);
  const restored = await send(
    restorePath,
    "POST",
    { ...base, destinationParentId: f.ids.root },
    restoreKey,
  );
  expect(restored.status).toBe(200);
  const restoreOperation = await restored.json<{ id: string; result: { nodeId: string } }>();
  expect(restoreOperation.result.nodeId).toBe(copyOperation.result.nodeId);
  expect(
    await env.DB.prepare("SELECT parent_id,name,deleted_at FROM nodes WHERE id=?")
      .bind(copyOperation.result.nodeId)
      .first(),
  ).toEqual({ parent_id: f.ids.root, name: "REST moved (restored 1)", deleted_at: null });
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE op_id=?")
      .bind(trashOperation.id)
      .first("state"),
  ).toBe("restored");
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(restoreOperation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${restoreOperation.id}_event`)).toBe("completed");
  expect(
    await (
      await send(restorePath, "POST", { ...base, destinationParentId: f.ids.root }, restoreKey)
    ).json(),
  ).toMatchObject({ id: restoreOperation.id, state: "committed" });
  expect((await send(restorePath, "POST", { ...base }, restoreKey)).status).toBe(400);

  const secondTrash = await send(trashPath, "DELETE", base, crypto.randomUUID());
  expect(secondTrash.status).toBe(200);
  const secondTrashOperation = await secondTrash.json<{ id: string }>();
  const purgePath = `/api/v1/trash/${secondTrashOperation.id}/purge`;
  const purgeKey = crypto.randomUUID();
  expect(
    nodeMutationRoute(new Request(`https://app.invalid${purgePath}`, { method: "POST" })),
  ).toBe(true);
  const purgeBody = { spaceId: f.ids.space };
  const purged = await send(purgePath, "POST", purgeBody, purgeKey);
  expect(purged.status).toBe(200);
  const purgeOperation = await purged.json<{ id: string; state: string }>();
  expect(purgeOperation.state).toBe("committed");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id=?")
      .bind(copyOperation.result.nodeId)
      .first("n"),
  ).toBe(0);
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(purgeOperation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${purgeOperation.id}_event`)).toBe("completed");
  expect(await (await send(purgePath, "POST", purgeBody, purgeKey)).json()).toMatchObject({
    id: purgeOperation.id,
    state: "committed",
  });
});

it("restores only the fixed trash membership after GC deletion leases drain", async () => {
  const { f, principal } = await seeded();
  const foreignOp = `${f.ids.root}-foreign-trash`;
  const foreignNode = `${f.ids.root}-foreign-node`;
  const nestedParent = `${f.ids.root}-zz-nested-parent`;
  const nestedChild = `${f.ids.root}-00-nested-child`;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch)
        VALUES(?,?,?,?,'trashed',?,1)`,
      values: [foreignOp, f.ids.user, f.ids.space, foreignNode, Date.now()],
    },
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at,
        deleted_at,deleted_op_id,orig_parent_id) VALUES(?,?,?,?,?,?,'folder',?,?,?,?,?)`,
      values: [
        foreignNode,
        f.ids.space,
        f.ids.user,
        f.ids.folder,
        "Foreign deleted",
        "foreign deleted",
        Date.now(),
        Date.now(),
        Date.now(),
        foreignOp,
        f.ids.folder,
      ],
    },
    {
      sql: "INSERT INTO trash_members(trash_op_id,node_id) VALUES(?,?)",
      values: [foreignOp, foreignNode],
    },
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',?,?)`,
      values: [
        nestedParent,
        f.ids.space,
        f.ids.user,
        f.ids.folder,
        "Nested parent",
        "nested parent",
        Date.now(),
        Date.now(),
      ],
    },
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',?,?)`,
      values: [
        nestedChild,
        f.ids.space,
        f.ids.user,
        nestedParent,
        "Nested child",
        "nested child",
        Date.now(),
        Date.now(),
      ],
    },
  ]);
  const trashKey = crypto.randomUUID();
  const trashed = await trashNode(admitted(), {
    principal,
    requestId: trashKey,
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    lockTokens: [],
  });
  if (trashed.kind !== "terminal") throw new Error("trash_commit_unknown");
  const trashId = trashed.operation.id;
  await env.DB.prepare(
    "INSERT INTO gc_candidates(blob_id,state,not_before,claim_token,claim_expires_at) VALUES(?,'deleting',0,?,?)",
  )
    .bind(f.ids.blob, crypto.randomUUID(), Date.now() + 60_000)
    .run();
  await expect(
    restoreTrash(admitted(), {
      principal,
      requestId: crypto.randomUUID(),
      spaceId: f.ids.space,
      trashOpId: trashId,
      destinationParentId: f.ids.root,
      lockTokens: [],
    }),
  ).rejects.toThrow();
  await env.DB.prepare("DELETE FROM gc_candidates WHERE blob_id=?").bind(f.ids.blob).run();
  const restored = await restoreTrash(admitted(), {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    trashOpId: trashId,
    destinationParentId: f.ids.root,
    lockTokens: [],
  });
  if (restored.kind === "terminal" && restored.operation.state !== "committed")
    throw new Error(JSON.stringify(restored.operation));
  expect(restored.kind).toBe("terminal");
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ deleted_at: null });
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?").bind(f.ids.file).first(),
  ).toEqual({ deleted_at: null });
  expect(
    await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?").bind(nestedChild).first(),
  ).toEqual({ deleted_at: null });
  expect(
    await env.DB.prepare("SELECT deleted_op_id FROM nodes WHERE id=?").bind(foreignNode).first(),
  ).toEqual({ deleted_op_id: foreignOp });

  const secondTrash = await trashNode(admitted(), {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    lockTokens: [],
  });
  if (secondTrash.kind !== "terminal" || secondTrash.operation.state !== "committed")
    throw new Error("second_trash_not_committed");
  const generationBeforePurge = await env.DB.prepare(
    "SELECT tree_generation FROM spaces WHERE id=?",
  )
    .bind(f.ids.space)
    .first<number>("tree_generation");
  const purged = await purgeTrash(admitted(), {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    trashOpId: secondTrash.operation.id,
  });
  if (purged.kind !== "terminal") throw new Error("purge_commit_unknown");
  expect(purged.operation.state).toBe("committed");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id IN (?,?,?,?)")
      .bind(f.ids.folder, f.ids.file, nestedParent, nestedChild)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT parent_id,deleted_op_id FROM nodes WHERE id=?")
      .bind(foreignNode)
      .first(),
  ).toEqual({ parent_id: null, deleted_op_id: foreignOp });
  expect(
    await env.DB.prepare(`SELECT state,trash_op_id,
      not_before>strftime('%s','now')*1000 AS delayed FROM gc_candidates WHERE blob_id=?`)
      .bind(f.ids.blob)
      .first(),
  ).toEqual({ state: "candidate", trash_op_id: secondTrash.operation.id, delayed: 1 });
  expect(
    await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(f.ids.space)
      .first("tree_generation"),
  ).toBe((generationBeforePurge ?? 0) + 1);
});

it("copies a fixed folder manifest with COW blobs and dead properties", async () => {
  const { f, principal } = await seeded();
  const fileSearch = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        VALUES(?,?,?,?,?,1)`,
      values: [f.ids.file, f.ids.space, fileSearch.textNorm, fileSearch.tokens, fileSearch.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
    {
      sql: "INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES(?,'urn:test','color','blue')",
      values: [f.ids.file],
    },
  ]);
  const request = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    sourceNodeId: f.ids.folder,
    destinationParentId: f.ids.root,
    name: "Folder copy",
    depth: "infinity" as const,
    lockTokens: [],
  };
  const copied = await copyNode(admitted(), request);
  expect(copied).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 201 } },
  });
  if (copied.kind !== "terminal" || !copied.operation.result?.nodeId)
    throw new Error("missing_copy_result");
  const copiedRoot = copied.operation.result.nodeId;
  const copiedChild = await env.DB.prepare(
    "SELECT id,current_blob_id FROM nodes WHERE parent_id=? AND name_ci='file' AND deleted_at IS NULL",
  )
    .bind(copiedRoot)
    .first<{ id: string; current_blob_id: string }>();
  expect(copiedChild?.current_blob_id).toBe(f.ids.blob);
  expect(
    await env.DB.prepare("SELECT ref_count FROM blobs WHERE id=?")
      .bind(f.ids.blob)
      .first("ref_count"),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT value_xml FROM node_props WHERE node_id=? AND namespace='urn:test' AND name='color'",
    )
      .bind(copiedChild!.id)
      .first("value_xml"),
  ).toBe("blue");
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM copy_members WHERE copy_op_id=?")
      .bind(copied.operation.id)
      .first("COUNT(*)"),
  ).toBe(2);
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(copied.operation.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${copied.operation.id}_event`)).toBe("completed");
  expect(await copyNode(admitted(), request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
});

it("atomically replaces a COPY target with a COW file", async () => {
  const { f, principal } = await seeded();
  const target = `${f.ids.file}-copy-target`;
  const fileSearch = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)`,
      values: [target, f.ids.space, f.ids.user, f.ids.root, "Existing", "existing"],
    },
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)`,
      values: [f.ids.file, f.ids.space, fileSearch.textNorm, fileSearch.tokens, fileSearch.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [f.ids.file],
    },
  ]);
  const request = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    sourceNodeId: f.ids.file,
    destinationParentId: f.ids.root,
    overwriteTargetId: target,
    name: "Existing",
    depth: "infinity",
    lockTokens: [],
  } as const;
  const copied = await copyNode(admitted(), request);
  expect(copied).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204 } },
  });
  if (copied.kind !== "terminal" || !copied.operation.result?.nodeId)
    throw new Error("missing_copy_result");
  expect(
    await env.DB.prepare("SELECT kind,current_blob_id,parent_id,name FROM nodes WHERE id=?")
      .bind(copied.operation.result.nodeId)
      .first(),
  ).toEqual({ kind: "file", current_blob_id: f.ids.blob, parent_id: f.ids.root, name: "Existing" });
  expect(
    await env.DB.prepare("SELECT deleted_at IS NOT NULL AS deleted FROM nodes WHERE id=?")
      .bind(target)
      .first("deleted"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT state FROM trash_ops WHERE root_node_id=?")
      .bind(target)
      .first("state"),
  ).toBe("trashed");
  expect(await copyNode(admitted(), request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204 } },
  });
  await expect(copyNode(admitted(), { ...request, name: "Different" })).rejects.toThrow(
    "idempotency_conflict",
  );
});

it("moves a bounded subtree between folders and publishes one atomic operation", async () => {
  const { f, principal } = await seeded();
  const destination = `${f.ids.folder}-destination`;
  await atomicBatch(env.DB, [
    {
      sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',1,1)`,
      values: [destination, f.ids.space, f.ids.user, f.ids.root, "Destination", "destination"],
    },
    {
      sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
        VALUES(?,?,?,?,?,1)`,
      values: [destination, f.ids.space, "destination", "destination", "unicode-nfkc-casefold-v1"],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [destination],
    },
  ]);
  const request = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    destinationParentId: destination,
    name: "Moved folder",
    lockTokens: [],
  };
  const result = await moveNode(admitted(), request);
  expect(result).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 201, nodeId: f.ids.folder } },
  });
  expect(
    await env.DB.prepare("SELECT parent_id,name,revision FROM nodes WHERE id=?")
      .bind(f.ids.folder)
      .first(),
  ).toEqual({ parent_id: destination, name: "Moved folder", revision: 2 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM nodes WHERE id IN (?,?) AND revision=2")
      .bind(f.ids.root, destination)
      .first("COUNT(*)"),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(f.ids.space)
      .first("tree_generation"),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM operation_steps WHERE op_id=?")
      .bind(result.kind === "terminal" ? result.operation.id : "")
      .first("COUNT(*)"),
  ).toBe(19);
  const outboxId = `${result.kind === "terminal" ? result.operation.id : ""}_event`;
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE outbox_id=?")
    .bind(outboxId)
    .run();
  expect(await consumeOutbox(mutationEnv(), outboxId)).toBe("completed");
  expect(await moveNode(admitted(), request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
});

it("atomically replaces a locked MOVE target and replays after the target is trashed", async () => {
  const { f, principal } = await seeded();
  const overwritten = `${f.ids.folder}-overwritten`;
  await env.DB.prepare(`INSERT INTO nodes(
      id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'folder',1,1)`)
    .bind(overwritten, f.ids.space, f.ids.user, f.ids.root, "Existing", "existing")
    .run();
  const runtime = admitted();
  const lock = runtime.LOCKS.get(runtime.LOCKS.idFromName(f.ids.space));
  const initializeId = crypto.randomUUID();
  const initializePermit = await lock.acquireRename({
    requestId: initializeId,
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    principal,
    lockTokens: [],
  });
  await lock.release(initializeId, initializePermit);
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const [hash] = await lockTokenHashes([token]);
  await env.DB.prepare(`INSERT INTO locks(
      id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at
    ) VALUES(?,?,?,?,?,'/dav/Existing','infinity','owner',1,?)`)
    .bind(
      `lock-${crypto.randomUUID()}`,
      overwritten,
      f.ids.space,
      f.ids.credential,
      hash,
      Date.now() + 60_000,
    )
    .run();
  const request = {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    destinationParentId: f.ids.root,
    overwriteTargetId: overwritten,
    name: "Existing",
    lockTokens: [] as string[],
  };
  await expect(moveNode(runtime, request)).rejects.toThrow("dav_locked");
  const moved = await moveNode(runtime, { ...request, lockTokens: [token] });
  expect(moved).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204, nodeId: f.ids.folder } },
  });
  expect(
    await env.DB.prepare("SELECT parent_id,name FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ parent_id: f.ids.root, name: "Existing" });
  expect(
    await env.DB.prepare("SELECT deleted_at IS NOT NULL AS deleted FROM nodes WHERE id=?")
      .bind(overwritten)
      .first("deleted"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM locks WHERE node_id=?")
      .bind(overwritten)
      .first("COUNT(*)"),
  ).toBe(0);
  expect(await moveNode(runtime, { ...request, lockTokens: [token] })).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204 } },
  });
  await expect(
    moveNode(runtime, { ...request, name: "Different", lockTokens: [token] }),
  ).rejects.toThrow("idempotency_conflict");
});

it("rejects moving a collection into its own descendant without changing the tree", async () => {
  const { f, principal } = await seeded();
  const descendant = `${f.ids.folder}-descendant`;
  await env.DB.prepare(`INSERT INTO nodes(
      id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'folder',1,1)`)
    .bind(descendant, f.ids.space, f.ids.user, f.ids.folder, "Descendant", "descendant")
    .run();
  const before = await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
    .bind(f.ids.space)
    .first("tree_generation");
  const result = await moveNode(admitted(), {
    principal,
    requestId: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    destinationParentId: descendant,
    name: "cycle",
    lockTokens: [],
  });
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
  expect(
    await env.DB.prepare("SELECT parent_id,name FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ parent_id: f.ids.root, name: "元の名前" });
  expect(
    await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(f.ids.space)
      .first("tree_generation"),
  ).toBe(before);
});

it("renames through LockDO and replays the same idempotency key", async () => {
  const { f, principal } = await seeded();
  const request = {
    principal,
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.ids.space,
    nodeId: f.ids.folder,
    name: "サービス経由の名前",
    lockTokens: [],
  };
  const runtime = admitted();
  expect(await renameNode(runtime, request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 200, nodeId: f.ids.folder } },
  });
  expect(await renameNode(runtime, request)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 200, nodeId: f.ids.folder } },
  });
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ name: request.name, revision: 2 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM outbox WHERE payload_ref=? AND kind='node.renamed'")
      .bind(f.ids.folder)
      .first("COUNT(*)"),
  ).toBe(1);
  await expect(renameNode(runtime, { ...request, name: "別名" })).rejects.toThrow(
    /idempotency_conflict/,
  );
  await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?").bind(f.ids.session).run();
  await expect(renameNode(runtime, request)).rejects.toThrow(/authorization_denied/);
});

it("atomically renames a node and replaces its search terms, with one terminal result", async () => {
  const { f, plan } = await planned();
  const statements = renameMutationStatements(plan);
  expect(await commitMutationStatements(env.DB, plan.claim, statements)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 200, nodeId: f.ids.folder } },
  });
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ name: "新しい名前", revision: 2 });
  expect(
    await env.DB.prepare("SELECT revision FROM nodes WHERE id=?")
      .bind(plan.authorized.parentId)
      .first("revision"),
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT tree_generation FROM spaces WHERE id=?")
      .bind(f.ids.space)
      .first("tree_generation"),
  ).toBe(2);
  expect(
    await env.DB.prepare(`SELECT COUNT(*) FROM search_fts WHERE rowid=(
      SELECT rowid FROM search_index WHERE node_id=?) AND search_fts MATCH ?`)
      .bind(f.ids.folder, 'tokens:"元の"')
      .first("COUNT(*)"),
  ).toBe(0);
  expect(
    await env.DB.prepare(`SELECT COUNT(*) FROM search_fts WHERE rowid=(
      SELECT rowid FROM search_index WHERE node_id=?) AND search_fts MATCH ?`)
      .bind(f.ids.folder, 'tokens:"新し"')
      .first("COUNT(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT kind FROM outbox WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("kind"),
  ).toBe("node.renamed");
  await env.DB.prepare("UPDATE outbox SET state='dispatching' WHERE op_id=?")
    .bind(plan.claim.intent.id)
    .run();
  expect(await consumeOutbox(mutationEnv(), `${plan.claim.intent.id}_event`)).toBe("completed");
  expect(await commitMutationStatements(env.DB, plan.claim, statements)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM activity WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("COUNT(*)"),
  ).toBe(1);
});

it("rolls back every effect when the new name conflicts with a sibling", async () => {
  const { f, plan } = await planned();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'folder',1,1)",
  )
    .bind(crypto.randomUUID(), f.ids.space, f.ids.user, f.ids.root, "新しい名前", "新しい名前")
    .run();
  expect(
    await commitMutationStatements(env.DB, plan.claim, renameMutationStatements(plan)),
  ).toMatchObject({ kind: "terminal", operation: { state: "failed" } });
  expect(
    await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?").bind(f.ids.folder).first(),
  ).toEqual({ name: "元の名前", revision: 1 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM outbox WHERE op_id=?")
      .bind(plan.claim.intent.id)
      .first("COUNT(*)"),
  ).toBe(0);
});

it.each(["rename", "move"] as const)(
  "%s preserves search after a child-list revision advanced",
  async (kind) => {
    const { f, principal } = await seeded();
    const bindings = admitted();
    expect(
      await createFolder(bindings, {
        principal,
        idempotencyKey: crypto.randomUUID(),
        spaceId: f.ids.space,
        parentId: f.ids.folder,
        name: "Added child",
        lockTokens: [],
      }),
    ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    expect(
      await env.DB.prepare(
        "SELECT n.revision,si.revision AS indexed FROM nodes n JOIN search_index si ON si.node_id=n.id WHERE n.id=?",
      )
        .bind(f.ids.folder)
        .first(),
    ).toEqual({ revision: 2, indexed: 1 });
    const request = {
      principal,
      spaceId: f.ids.space,
      nodeId: f.ids.folder,
      name: "検索できる新名",
      lockTokens: [],
    };
    const result =
      kind === "rename"
        ? await renameNode(bindings, { ...request, idempotencyKey: crypto.randomUUID() })
        : await moveNode(bindings, {
            ...request,
            requestId: crypto.randomUUID(),
            destinationParentId: f.ids.root,
          });
    expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    expect(
      await env.DB.prepare(
        "SELECT n.name,n.revision,si.revision AS indexed,si.text_norm FROM nodes n JOIN search_index si ON si.node_id=n.id WHERE n.id=?",
      )
        .bind(f.ids.folder)
        .first(),
    ).toEqual({
      name: request.name,
      revision: 3,
      indexed: 3,
      text_norm: searchName(request.name).textNorm,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH ? AND rowid=(SELECT rowid FROM search_index WHERE node_id=?)",
      )
        .bind('tokens:"検索"', f.ids.folder)
        .first("n"),
    ).toBe(1);
  },
);
