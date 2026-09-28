import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { authorizeNode } from "../../src/auth/authorize";
import type { TransferDestination } from "../../src/auth/transferScope";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { claimOperation, lookupOperation, operationIntent } from "../../src/jobs/operations";
import { COPY_NODE_STEPS, copyNode } from "../../src/services/copyNode";
import { createFolder } from "../../src/services/createFolder";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { moveNode } from "../../src/services/moveNode";
import { davSharedFixture } from "../fixtures/davShared";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const origin = "https://app.invalid";
async function fixture(sourceRole = "edit", destinationRole = "edit") {
  const f = await davSharedFixture(false, sourceRole);
  const ownerPrincipal = {
    kind: "user" as const,
    user_id: f.owner.ids.user,
    credential_id: f.owner.ids.credential,
    epoch: 1,
  };
  const folder = await createFolder(f.app, {
    principal: ownerPrincipal,
    idempotencyKey: crypto.randomUUID(),
    spaceId: f.owner.ids.space,
    parentId: f.owner.ids.root,
    name: "Destination",
    lockTokens: [],
  });
  if (folder.kind !== "terminal" || folder.operation.state !== "committed")
    throw new Error("fixture_folder_failed");
  const targetId = `${folder.operation.id}_node`;
  const targetShare = await createInternalShare(mutationEnv(), f.session, {
    kind: "internal",
    rootNodeId: targetId,
    recipients: [`${f.recipient.ids.user}@example.invalid`],
    role: destinationRole,
    expiresAt: null,
  });
  const mount = await env.DB.prepare("SELECT mount_name FROM shares WHERE id=?")
    .bind(targetShare.id)
    .first<string>("mount_name");
  const destination: TransferDestination = { spaceId: f.owner.ids.space, share: targetShare };
  const input = {
    principal: { ...f.principal, selected_share: f.share },
    destination,
    requestId: crypto.randomUUID(),
    spaceId: f.owner.ids.space,
    destinationParentId: targetId,
    name: "Transferred",
    lockTokens: [],
  };
  const transfer = (kind: "copy" | "move", patch: Partial<typeof input> = {}) =>
    kind === "copy"
      ? copyNode(f.app, { ...input, ...patch, sourceNodeId: f.owner.ids.file, depth: "infinity" })
      : moveNode(f.app, { ...input, ...patch, nodeId: f.owner.ids.file });
  const revoke = (which: "source" | "destination") =>
    which === "source"
      ? f.revoke()
      : updateInternalShare(mutationEnv(), f.session, targetShare.id, targetShare.version, null);
  const dispatch = async (id: string) => {
    await env.DB.prepare("UPDATE outbox SET state='sent' WHERE op_id=?").bind(id).run();
    return consumeOutbox(mutationEnv(), id + "_event");
  };
  return {
    ...f,
    targetId,
    targetShare,
    destination,
    targetBase: `/dav/Shared/${mount}`,
    input,
    transfer,
    revoke,
    dispatch,
  };
}

it.each(["COPY", "MOVE"])(
  "serves same-owner cross-mount %s with independent durable grants",
  async (method) => {
    const f = await fixture();
    expect(
      (
        await f.call(
          "PUT",
          f.base + "/File",
          { "Content-Length": "3", "If-Match": `"b-${f.owner.ids.blob}"` },
          "abc",
        )
      ).status,
    ).toBe(204);
    const result = await f.call(method, f.base + "/File", {
      Destination: origin + f.targetBase + "/Transferred",
    });
    expect(result.status).toBe(201);
    expect(result.headers.get("Location")).toBe(f.targetBase + "/Transferred");
    expect(await (await f.call("GET", f.targetBase + "/Transferred")).text()).toBe("abc");
    expect((await f.call("HEAD", f.base + "/File")).status).toBe(method === "MOVE" ? 404 : 200);
    const row = await env.DB.prepare("SELECT * FROM operations WHERE credential_id=? AND kind=?")
      .bind(f.principal.credential_id, "dav." + method.toLowerCase())
      .first<{ op_id: string }>();
    expect(row).toMatchObject({
      selected_share_id: f.share.id,
      selected_share_version: 1,
      destination_space_id: f.owner.ids.space,
      destination_share_id: f.targetShare.id,
      destination_share_version: 1,
    });
    expect(await lookupOperation(env.DB, f.principal, row!.op_id)).toMatchObject({
      state: "committed",
      result: { status: 201, nodeId: expect.any(String) },
    });
    expect(await f.dispatch(row!.op_id)).toBe("completed");
  },
);
it.each(["copy", "move"] as const)(
  "keeps both selected scopes on terminal %s replay and rejects omission/substitution",
  async (kind) => {
    const f = await fixture(),
      done = await f.transfer(kind);
    expect(done).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    expect(await f.transfer(kind)).toEqual(done);
    await expect(
      f.transfer(kind, { destination: { spaceId: f.owner.ids.space, share: f.broader } }),
    ).rejects.toThrow("idempotency_conflict");
    const { destination: _, ...legacy } = f.input;
    await expect(
      kind === "copy"
        ? copyNode(f.app, { ...legacy, sourceNodeId: f.owner.ids.file, depth: "infinity" })
        : moveNode(f.app, { ...legacy, nodeId: f.owner.ids.file }),
    ).rejects.toThrow("idempotency_conflict");
  },
);
it.each([
  ["copy", "source"],
  ["copy", "destination"],
  ["move", "source"],
  ["move", "destination"],
] as const)("revoked %s %s scope cannot be replaced by a broader grant", async (kind, which) => {
  const f = await fixture(),
    done = await f.transfer(kind);
  if (done.kind !== "terminal") throw new Error("no_terminal");
  await f.revoke(which);
  expect(await lookupOperation(env.DB, f.principal, done.operation.id)).toBeNull();
  expect(await f.dispatch(done.operation.id)).toBe("retry");
  await expect(f.transfer(kind)).rejects.toThrow("authorization_denied");
});
it.each([
  ["copy", "source"],
  ["copy", "destination"],
  ["move", "source"],
  ["move", "destination"],
] as const)(
  "rolls back %s when %s grant changes immediately before commit",
  async (kind, which) => {
    const f = await fixture();
    let changed = false;
    f.app.DB = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await f.revoke(which);
        changed = true;
      },
      false,
    );
    expect(await f.transfer(kind)).toMatchObject({ kind: "commit_unknown" });
    expect(changed).toBe(true);
    expect(
      await env.DB.prepare("SELECT parent_id FROM nodes WHERE id=?")
        .bind(f.owner.ids.file)
        .first("parent_id"),
    ).toBe(f.owner.ids.folder);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=?")
        .bind(f.targetId)
        .first("n"),
    ).toBe(0);
  },
);
it("allows read-source COPY but requires destination edit and source edit for MOVE", async () => {
  const f = await fixture("read");
  expect(await f.transfer("copy")).toMatchObject({
    kind: "terminal",
    operation: { state: "committed" },
  });
  await expect(
    f.transfer("move", { requestId: crypto.randomUUID(), name: "Moved" }),
  ).rejects.toThrow("authorization_denied");
  const g = await fixture("edit", "read");
  await expect(g.transfer("copy")).rejects.toThrow("authorization_denied");
});
it.each(["copy", "move"] as const)(
  "an explicit personal %s scope cannot fall back to an internal grant",
  async (kind) => {
    const f = await fixture();
    await expect(
      f.transfer(kind, {
        destination: { spaceId: f.owner.ids.space, share: null } as typeof f.destination,
      }),
    ).rejects.toThrow("authorization_denied");
    await expect(
      f.transfer(kind, { principal: f.principal as typeof f.input.principal }),
    ).rejects.toThrow("authorization_denied");
  },
);
it("evaluates tagged If within the two chosen mounts and enforces both locks", async () => {
  const f = await fixture();
  const body =
    '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
  const sourceLock = await f.call("LOCK", f.base + "/File", { Depth: "0" }, body);
  const targetLock = await f.call("LOCK", f.targetBase, { Depth: "0" }, body);
  expect(sourceLock.status).toBe(200);
  expect(targetLock.status).toBe(200);
  const sourceToken = sourceLock.headers.get("Lock-Token"),
    targetToken = targetLock.headers.get("Lock-Token");
  const headers = { Destination: origin + f.targetBase + "/Moved" };
  expect(
    (await f.call("MOVE", f.base + "/File", { ...headers, If: `(${sourceToken})` })).status,
  ).toBe(423);
  expect(
    (
      await f.call("MOVE", f.base + "/File", {
        ...headers,
        If: `<${origin}/dav/Shared/${f.broaderMount}/Destination> (${targetToken})`,
      })
    ).status,
  ).toBe(412);
  expect(
    (
      await f.call("MOVE", f.base + "/File", {
        ...headers,
        If: `<${origin}${f.base}/File> (${sourceToken}) <${origin}${f.targetBase}/> (${targetToken})`,
      })
    ).status,
  ).toBe(201);
});
it("rechecks both lookup scopes in one final snapshot", async () => {
  const f = await fixture();
  const done = await f.transfer("move");
  if (done.kind !== "terminal") throw new Error("no_terminal");
  let stopped = false;
  const db = injectBatch(
    (sql) => sql.includes("json_extract(?3,'$.owner_only')"),
    async () => {
      await f.revoke("source");
      stopped = true;
    },
    false,
  );
  expect(await lookupOperation(db, f.principal, done.operation.id)).toBeNull();
  expect(stopped).toBe(true);
});
it("rejects cross-owner DAV transfers under the synchronous transfer profile", async () => {
  const f = await fixture();
  for (const method of ["COPY", "MOVE"])
    expect(
      (await f.call(method, f.base + "/File", { Destination: origin + "/dav/Folder/Other" }))
        .status,
    ).toBe(403);
});
it.each(["copy", "move"] as const)(
  "binds the destination grant to a %s namespace permit",
  async (kind) => {
    const f = await fixture();
    const lock = f.app.LOCKS.get(f.app.LOCKS.idFromName(f.owner.ids.space));
    const acquire = (destination: TransferDestination) =>
      kind === "copy"
        ? lock.acquireCopy({
            ...f.input,
            destination,
            sourceNodeId: f.owner.ids.file,
            parentId: f.targetId,
          })
        : lock.acquireMove({ ...f.input, destination, nodeId: f.owner.ids.file });
    const permit = await acquire(f.destination);
    try {
      expect(await acquire(f.destination)).toEqual(permit);
      await expect(acquire({ spaceId: f.owner.ids.space, share: f.broader })).rejects.toThrow(
        "lock_intent_conflict",
      );
    } finally {
      await lock.release(f.input.requestId, permit);
    }
  },
);
it("requires the exact destination proof when claiming a transfer", async () => {
  const f = await fixture();
  const intent = await operationIntent(
    f.input.principal,
    f.input.requestId,
    f.owner.ids.space,
    "dav.copy",
    {},
    { sourceNodeId: f.owner.ids.file, parentId: f.targetId },
    f.destination,
  );
  const source = await authorizeNode(env.DB, f.input.principal, {
    operation: "node.read",
    nodeId: f.owner.ids.file,
    spaceId: f.owner.ids.space,
  });
  const destination = await authorizeNode(
    env.DB,
    { ...f.principal, selected_share: f.targetShare },
    { operation: "node.create", parentId: f.targetId, spaceId: f.owner.ids.space },
  );
  const wrong = await authorizeNode(
    env.DB,
    { ...f.principal, selected_share: f.broader },
    { operation: "node.create", parentId: f.targetId, spaceId: f.owner.ids.space },
  );
  const lock = f.app.LOCKS.get(f.app.LOCKS.idFromName(f.owner.ids.space));
  const permit = await lock.acquireCopy({
    ...f.input,
    requestId: intent.id,
    sourceNodeId: f.owner.ids.file,
    parentId: f.targetId,
  });
  try {
    await expect(claimOperation(env.DB, intent, permit, source, COPY_NODE_STEPS)).rejects.toThrow(
      "invalid_operation_claim",
    );
    await expect(
      claimOperation(env.DB, intent, permit, source, COPY_NODE_STEPS, wrong),
    ).rejects.toThrow("invalid_operation_claim");
    expect(
      await env.DB.prepare("SELECT op_id FROM operations WHERE op_id=?").bind(intent.id).first(),
    ).toBeNull();
    expect(
      await claimOperation(env.DB, intent, permit, source, COPY_NODE_STEPS, destination),
    ).toMatchObject({ kind: "claimed" });
  } finally {
    await env.DB.prepare(
      "UPDATE operations SET state='failed',error_code='mutation_rejected' WHERE op_id=? AND state='claimed'",
    )
      .bind(intent.id)
      .run();
    await lock.release(intent.id, permit);
  }
});
it.each(["copy", "move"] as const)(
  "reconciles a lost %s commit acknowledgement under both grants",
  async (kind) => {
    const f = await fixture();
    let lost = false;
    f.app.DB = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        lost = true;
        throw new Error("lost_commit_ack");
      },
      true,
    );
    const done = await f.transfer(kind);
    expect(lost).toBe(true);
    expect(done).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    expect(await f.transfer(kind)).toEqual(done);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND deleted_at IS NULL",
      )
        .bind(f.targetId)
        .first("n"),
    ).toBe(1);
  },
);
it.each(["COPY", "MOVE"])(
  "overwrites inside the selected destination on cross-mount %s",
  async (method) => {
    const f = await fixture();
    expect(
      (
        await f.call(
          "PUT",
          f.base + "/File",
          { "Content-Length": "3", "If-Match": `"b-${f.owner.ids.blob}"` },
          "new",
        )
      ).status,
    ).toBe(204);
    const sourceBlob = await env.DB.prepare("SELECT current_blob_id FROM nodes WHERE id=?")
      .bind(f.owner.ids.file)
      .first("current_blob_id");
    expect(
      (
        await f.call(
          "PUT",
          f.targetBase + "/Transferred",
          { "Content-Length": "3", "If-None-Match": "*" },
          "old",
        )
      ).status,
    ).toBe(201);
    const old = await env.DB.prepare(
      "SELECT id,current_blob_id FROM nodes WHERE parent_id=? AND name='Transferred' AND deleted_at IS NULL",
    )
      .bind(f.targetId)
      .first<{ id: string; current_blob_id: string }>();
    const response = await f.call(method, f.base + "/File", {
      Destination: origin + f.targetBase + "/Transferred",
      Overwrite: "T",
    });
    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id=?")
        .bind(old!.id)
        .first("deleted_at"),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT current_blob_id FROM nodes WHERE parent_id=? AND name='Transferred' AND deleted_at IS NULL",
      )
        .bind(f.targetId)
        .first("current_blob_id"),
    ).toBe(sourceBlob);
    expect(await (await f.call("GET", f.targetBase + "/Transferred")).text()).toBe("new");
    expect((await f.call("HEAD", f.base + "/File")).status).toBe(method === "MOVE" ? 404 : 200);
  },
);
