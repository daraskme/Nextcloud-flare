import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { searchName } from "@next-cloud-flare/shared/names";
import { base64url } from "jose";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { handleNodeMutationHttp } from "../../src/api/nodeMutations";
import { handleUploadHttp } from "../../src/api/uploads";
import { accessPrincipal, authorizeNode, type Principal } from "../../src/auth/authorize";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { ListCursorTokens } from "../../src/auth/listCursor";
import type { AccessSession } from "../../src/auth/sessions";
import { UploadCapabilities } from "../../src/auth/uploadCapability";
import { atomicBatch } from "../../src/db/primary";
import type { R2WriteRequest } from "../../src/db/r2Write";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { lookupOperation } from "../../src/jobs/operations";
import { copyNode } from "../../src/services/copyNode";
import { createFolder } from "../../src/services/createFolder";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { moveNode } from "../../src/services/moveNode";
import { purgeTrash } from "../../src/services/purgeTrash";
import { renameNode } from "../../src/services/renameNode";
import { restoreTrash } from "../../src/services/restoreTrash";
import { trashNode } from "../../src/services/trashNode";
import { listTrash } from "../../src/services/trashRead";
import { uploadRow } from "../../src/services/uploads/access";
import { completeSingleUpload } from "../../src/services/uploads/complete";
import { writeSingleUpload } from "../../src/services/uploads/content";
import { createSingleUpload } from "../../src/services/uploads/create";
import { createMultipartUpload, writeMultipartPart } from "../../src/services/uploads/multipart";
import { completeMultipartUpload } from "../../src/services/uploads/multipartComplete";
import { foundationFixture } from "../fixtures/foundation";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { admitted, injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const origin = "https://app.invalid";
const csrf = { verify: async () => {} };
async function fixture(rootFile = false) {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...recipient.statements,
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [`${recipient.ids.user}@example.invalid`, recipient.ids.user],
    },
  ]);
  // Foundation rows predate the search index; overwrite requires a complete file projection.
  const search = searchName("File");
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
      values: [owner.ids.file, owner.ids.space, search.textNorm, search.tokens, search.version],
    },
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
      values: [owner.ids.file],
    },
  ]);
  const session: AccessSession = {
    user_id: owner.ids.user,
    credential_id: owner.ids.credential,
    session_id: owner.ids.session,
    role: "app_admin",
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const principal = accessPrincipal({
    ...session,
    user_id: recipient.ids.user,
    credential_id: recipient.ids.credential,
    session_id: recipient.ids.session,
  });
  if (principal.kind !== "user") throw new Error("missing_user");
  const input = {
    kind: "internal",
    rootNodeId: rootFile ? owner.ids.file : owner.ids.folder,
    recipients: [`${recipient.ids.user}@example.invalid`],
    role: "edit",
    expiresAt: null,
  };
  const share = await createInternalShare(mutationEnv(), session, input);
  // A second edit grant must never replace a revoked selected grant.
  const broader = await createInternalShare(mutationEnv(), session, {
    ...input,
    rootNodeId: owner.ids.root,
  });
  const selected = { ...principal, selected_share: share };
  const app = { ...admitted(), APP_ORIGIN: origin };
  const capabilities = new UploadCapabilities(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const uploadInput = {
    principal: selected,
    requestId: crypto.randomUUID(),
    spaceId: owner.ids.space,
    parentId: owner.ids.folder,
    name: "shared.txt",
    declaredSize: 3,
  };
  const folderInput = {
    principal: selected,
    idempotencyKey: crypto.randomUUID(),
    spaceId: owner.ids.space,
    parentId: owner.ids.folder,
    name: "Shared folder",
    lockTokens: [],
  };
  const revoke = () => updateInternalShare(mutationEnv(), session, share.id, share.version, null);
  return {
    owner,
    recipient,
    session,
    principal,
    share,
    broader,
    selected,
    app,
    capabilities,
    uploadInput,
    folderInput,
    revoke,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function create(f: Fixture, multipart: boolean) {
  return (multipart ? createMultipartUpload : createSingleUpload)(
    f.app,
    f.uploadInput,
    f.capabilities,
  );
}
function write(f: Fixture, upload: { id: string; capability: string }, multipart: boolean) {
  const body = new Blob(["abc"]).stream();
  return multipart
    ? writeMultipartPart(
        f.app,
        f.principal,
        upload.id,
        upload.capability,
        f.capabilities,
        1,
        "part",
        body,
        3,
      )
    : writeSingleUpload(f.app, f.principal, upload.id, upload.capability, f.capabilities, body, 3);
}
function complete(f: Fixture, upload: { id: string; capability: string }, multipart: boolean) {
  return (multipart ? completeMultipartUpload : completeSingleUpload)(
    f.app,
    f.principal,
    upload.id,
    upload.capability,
    f.capabilities,
    "complete",
    [],
  );
}
async function dispatch(f: Fixture, id: string) {
  await env.DB.prepare(
    "UPDATE outbox SET state='dispatching',dispatch_token='test',dispatch_expires_at=? WHERE op_id=?",
  )
    .bind(Date.now() + 60000, id)
    .run();
  return consumeOutbox(f.app, `${id}_event`);
}

it("creates and renames under one selected grant and binds replay, lookup and outbox to it", async () => {
  const f = await fixture();
  const result = await createFolder(f.app, f.folderInput);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  if (result.kind !== "terminal") throw new Error("missing_terminal");
  const id = result.operation.id;
  expect(
    await env.DB.prepare(
      "SELECT selected_share_id,selected_share_version FROM operations WHERE op_id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({ selected_share_id: f.share.id, selected_share_version: f.share.version });
  expect(await createFolder(f.app, f.folderInput)).toEqual(result);
  await expect(createFolder(f.app, { ...f.folderInput, principal: f.principal })).rejects.toThrow(
    "idempotency_conflict",
  );
  await expect(
    createFolder(f.app, {
      ...f.folderInput,
      principal: { ...f.principal, selected_share: f.broader },
    }),
  ).rejects.toThrow("idempotency_conflict");
  expect(await lookupOperation(env.DB, f.principal, id)).toEqual(result.operation);
  const renamed = await renameNode(f.app, {
    principal: f.selected,
    idempotencyKey: "rename",
    spaceId: f.owner.ids.space,
    nodeId: `${id}_node`,
    name: "Renamed folder",
    lockTokens: [],
  });
  expect(renamed).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  await expect(
    renameNode(f.app, {
      principal: f.selected,
      idempotencyKey: "rename-root",
      spaceId: f.owner.ids.space,
      nodeId: f.owner.ids.folder,
      name: "Outside",
      lockTokens: [],
    }),
  ).rejects.toThrow("authorization_denied");
  expect(await dispatch(f, id)).toBe("completed");
  await f.revoke();
  expect(
    await authorizeNode(env.DB, f.principal, {
      operation: "node.read",
      spaceId: f.owner.ids.space,
      nodeId: `${id}_node`,
    }),
  ).toBeTruthy();
  expect(await lookupOperation(env.DB, f.principal, id)).toBeNull();
  if (renamed.kind !== "terminal") throw new Error("missing_terminal");
  expect(await dispatch(f, renamed.operation.id)).toBe("retry");
});

it("recovers a lost selected folder commit acknowledgement without duplicate nodes", async () => {
  const f = await fixture();
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      throw new Error("lost_ack");
    },
    true,
  );
  const result = await createFolder(admitted(db), f.folderInput);
  expect(result).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await createFolder(f.app, f.folderInput)).toEqual(result);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name=?")
      .bind(f.owner.ids.folder, f.folderInput.name)
      .first("n"),
  ).toBe(1);
});

it("rejects revocation at the namespace commit instead of using a broader edit grant", async () => {
  const f = await fixture();
  let revoked = false;
  const db = injectBatch(
    (sql) => sql.includes("UPDATE operations SET state='committed'"),
    async () => {
      await f.revoke();
      revoked = true;
    },
    false,
  );
  await createFolder(admitted(db), f.folderInput).catch(() => {});
  expect(revoked).toBe(true);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name=?")
      .bind(f.owner.ids.folder, f.folderInput.name)
      .first("n"),
  ).toBe(0);
});

it("rechecks the saved selected grant immediately before native R2 write admission", async () => {
  const f = await fixture(),
    upload = await create(f, false);
  const original = f.app.CONTROL.get(f.app.CONTROL.idFromName("fixture"));
  let checked = false;
  f.app.CONTROL = {
    idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
    get: () => ({
      ...original,
      beginR2Write: async (request: R2WriteRequest) => {
        await f.revoke();
        checked = true;
        return original.beginR2Write(request);
      },
    }),
  } as unknown as Env["CONTROL"];
  await expect(write(f, upload, false)).rejects.toThrow();
  expect(checked).toBe(true);
  const row = (await uploadRow(env.DB, upload.id))!;
  expect(await env.BLOBS.head(`u/${f.owner.ids.user}/b/${row.blob_id}`)).toBeNull();
});

it("rejects read-only selected writes even when another edit grant is valid", async () => {
  const f = await fixture();
  const share = await updateInternalShare(mutationEnv(), f.session, f.share.id, f.share.version, {
    kind: "internal",
    rootNodeId: f.owner.ids.folder,
    recipients: [`${f.recipient.ids.user}@example.invalid`],
    role: "read",
    expiresAt: null,
  });
  const principal = { ...f.principal, selected_share: { id: share.id, version: share.version } };
  await expect(createFolder(f.app, { ...f.folderInput, principal })).rejects.toThrow(
    "authorization_denied",
  );
  await expect(
    createSingleUpload(f.app, { ...f.uploadInput, principal }, f.capabilities),
  ).rejects.toThrow("authorization_denied");
});

it("accepts selected create/rename HTTP and rejects malformed selections", async () => {
  const f = await fixture();
  const http = (path: string, method: string, body: unknown) =>
    handleNodeMutationHttp(
      new Request(`${origin}/api/v1/${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
      f.app,
      f.principal,
      csrf,
    );
  const body = {
    kind: "folder",
    spaceId: f.owner.ids.space,
    parentId: f.owner.ids.folder,
    name: "HTTP folder",
    share: f.share,
  };
  for (const share of [null, {}, { ...f.share, version: 0 }, { ...f.share, unexpected: true }])
    expect((await http("nodes", "POST", { ...body, share })).status).toBe(400);
  const response = await http("nodes", "POST", body);
  expect(response.status).toBe(201);
  const saved = await response.json<{ id: string }>();
  expect(
    (
      await http(`nodes/${saved.id}_node`, "PATCH", {
        spaceId: f.owner.ids.space,
        name: "Renamed HTTP",
        share: f.share,
      })
    ).status,
  ).toBe(200);
});

it.each([false, true])(
  "persists selected scope for multipart=%s through unscoped transfer and completion calls",
  async (multipart) => {
    const f = await fixture(),
      upload = await create(f, multipart);
    await write(f, upload, multipart);
    const result = await complete(f, upload, multipart);
    expect(result).toMatchObject({
      kind: "terminal",
      operation: { state: "committed", result: { status: 201 } },
    });
    expect(await complete(f, upload, multipart)).toEqual(result);
    const row = (await uploadRow(env.DB, upload.id))!;
    expect(row).toMatchObject({
      state: "completed",
      selected_share_id: f.share.id,
      selected_share_version: f.share.version,
    });
    expect(
      await env.DB.prepare(
        "SELECT selected_share_id,selected_share_version FROM operations WHERE op_id=?",
      )
        .bind(row.completion_op_id)
        .first(),
    ).toEqual({ selected_share_id: f.share.id, selected_share_version: f.share.version });
    expect(
      await env.DB.prepare("SELECT used_bytes,reserved_bytes FROM users WHERE id=?")
        .bind(f.owner.ids.user)
        .first(),
    ).toEqual({ used_bytes: 6, reserved_bytes: 0 });
    expect(
      await env.DB.prepare("SELECT used_bytes,reserved_bytes FROM users WHERE id=?")
        .bind(f.recipient.ids.user)
        .first(),
    ).toEqual({ used_bytes: 3, reserved_bytes: 0 });
    expect(await dispatch(f, row.completion_op_id!)).toBe("completed");
    await f.revoke();
    expect(await lookupOperation(env.DB, f.principal, row.completion_op_id!)).toBeNull();
    await expect(complete(f, upload, multipart)).rejects.toThrow();
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "rejects revoked multipart=%s after transfer=%s despite another edit grant",
  async (multipart, transferred) => {
    const f = await fixture(),
      upload = await create(f, multipart);
    if (transferred) await write(f, upload, multipart);
    await f.revoke();
    await expect(
      transferred ? complete(f, upload, multipart) : write(f, upload, multipart),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name='shared.txt'",
      )
        .bind(f.owner.ids.folder)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id=?")
        .bind(f.owner.ids.user)
        .first("reserved_bytes"),
    ).toBe(3);
  },
);

it("overwrites a directly shared file without returning or requiring its private parent ID", async () => {
  const f = await fixture(true);
  const target = await env.DB.prepare("SELECT name,revision FROM nodes WHERE id=?")
    .bind(f.owner.ids.file)
    .first<{ name: string; revision: number }>();
  const response = await handleUploadHttp(
    new Request(`${origin}/api/v1/uploads`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Idempotency-Key": "direct-file",
      },
      body: JSON.stringify({
        mode: "single",
        spaceId: f.owner.ids.space,
        name: target!.name,
        declared_size: 3,
        targetId: f.owner.ids.file,
        targetRevision: target!.revision,
        share: f.share,
      }),
    }),
    f.app,
    f.principal,
    csrf,
    f.capabilities,
  );
  expect(response.status).toBe(201);
  const upload = await response.json<{ id: string; capability: string }>();
  expect(JSON.stringify(upload)).not.toContain(f.owner.ids.folder);
  await write(f, upload, false);
  expect(await complete(f, upload, false)).toMatchObject({
    kind: "terminal",
    operation: { state: "committed", result: { status: 204 } },
  });
});

async function sharedDestination(f: Fixture, name = "Destination") {
  const created = await createFolder(f.app, {
    ...f.folderInput,
    name,
    idempotencyKey: crypto.randomUUID(),
  });
  if (created.kind !== "terminal" || created.operation.state !== "committed")
    throw new Error("missing_destination");
  return `${created.operation.id}_node`;
}
function transfer(
  f: Fixture,
  kind: "move" | "copy" | "trash",
  destinationParentId: string,
  requestId: string,
  principal: Principal = f.selected,
) {
  const common = { principal, requestId, spaceId: f.owner.ids.space, lockTokens: [] };
  return kind === "trash"
    ? trashNode(f.app, { ...common, operation: "node.trash", nodeId: f.owner.ids.file })
    : kind === "move"
      ? moveNode(f.app, {
          ...common,
          operation: "node.move",
          nodeId: f.owner.ids.file,
          destinationParentId,
          name: "Moved",
        })
      : copyNode(f.app, {
          ...common,
          operation: "node.copy",
          sourceNodeId: f.owner.ids.file,
          destinationParentId,
          name: "Copied",
          depth: "infinity",
        });
}

it.each(["move", "copy", "trash"] as const)(
  "preserves selected %s identity on terminal replay, lookup and outbox",
  async (kind) => {
    const f = await fixture();
    const destination = await sharedDestination(f);
    const key = crypto.randomUUID();
    const done = await transfer(f, kind, destination, key);
    expect(done).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
    if (done.kind !== "terminal") throw new Error("missing_terminal");
    expect(await transfer(f, kind, destination, key)).toEqual(done);
    await expect(transfer(f, kind, destination, key, f.principal)).rejects.toThrow(
      "idempotency_conflict",
    );
    await expect(
      transfer(f, kind, destination, key, { ...f.principal, selected_share: f.broader }),
    ).rejects.toThrow("idempotency_conflict");
    expect(await lookupOperation(env.DB, f.principal, done.operation.id)).toEqual(done.operation);
    expect(await dispatch(f, done.operation.id)).toBe("completed");
    await f.revoke();
    await expect(transfer(f, kind, destination, key)).rejects.toThrow("authorization_denied");
    expect(await lookupOperation(env.DB, f.principal, done.operation.id)).toBeNull();
  },
);

it.each(["move", "copy"] as const)(
  "rejects selected %s to an out-of-share destination despite another edit grant",
  async (kind) => {
    const f = await fixture();
    await expect(transfer(f, kind, f.owner.ids.root, crypto.randomUUID())).rejects.toThrow(
      "authorization_denied",
    );
    expect(
      await env.DB.prepare("SELECT parent_id FROM nodes WHERE id=?")
        .bind(f.owner.ids.file)
        .first("parent_id"),
    ).toBe(f.owner.ids.folder);
  },
);

it.each(["move", "copy", "trash"] as const)(
  "rolls back selected %s when the share is revoked immediately before commit",
  async (kind) => {
    const f = await fixture();
    const destination = await sharedDestination(f);
    f.app.DB = injectBatch(
      (sql) => sql.includes("UPDATE operations SET state='committed'"),
      async () => {
        await f.revoke();
      },
      false,
    );
    const result = await transfer(f, kind, destination, crypto.randomUUID());
    expect(result).toMatchObject({ kind: "commit_unknown" });
    expect(
      await env.DB.prepare("SELECT parent_id,deleted_at FROM nodes WHERE id=?")
        .bind(f.owner.ids.file)
        .first(),
    ).toEqual({ parent_id: f.owner.ids.folder, deleted_at: null });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=?")
        .bind(destination)
        .first("n"),
    ).toBe(0);
  },
);

it("forbids trash of the selected root and read-only deletion without falling back to another grant", async () => {
  const f = await fixture();
  await expect(
    trashNode(f.app, {
      principal: f.selected,
      requestId: "root-trash",
      spaceId: f.owner.ids.space,
      nodeId: f.owner.ids.folder,
      lockTokens: [],
    }),
  ).rejects.toThrow("authorization_denied");
  const read = await updateInternalShare(mutationEnv(), f.session, f.share.id, f.share.version, {
    kind: "internal",
    rootNodeId: f.owner.ids.folder,
    recipients: [`${f.recipient.ids.user}@example.invalid`],
    role: "read",
    expiresAt: null,
  });
  for (const kind of ["move", "copy", "trash"] as const)
    await expect(
      transfer(f, kind, f.owner.ids.folder, `read-${kind}`, {
        ...f.principal,
        selected_share: { id: read.id, version: read.version },
      }),
    ).rejects.toThrow("authorization_denied");
});

it("keeps recipient-deleted items in the owner's trash while preserving the deleting actor", async () => {
  const f = await fixture();
  const nested = await createInternalShare(mutationEnv(), f.session, {
    kind: "internal",
    rootNodeId: f.owner.ids.file,
    recipients: [`${f.recipient.ids.user}@example.invalid`],
    role: "edit",
    expiresAt: null,
  });
  const done = await transfer(f, "trash", f.owner.ids.folder, "recipient-trash");
  if (done.kind !== "terminal" || done.operation.state !== "committed")
    throw new Error("missing_terminal");
  expect(
    await env.DB.prepare(
      "SELECT disabled_at IS NOT NULL AS disabled,version FROM shares WHERE id=?",
    )
      .bind(nested.id)
      .first(),
  ).toEqual({ disabled: 1, version: nested.version + 1 });
  const owner = accessPrincipal(f.session);
  const tokens = new ListCursorTokens(
    await contentKeyRing("test", {
      test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
    }),
  );
  const listed = await listTrash(env.DB, owner, tokens, f.owner.ids.space);
  expect(listed.items).toEqual([
    expect.objectContaining({ opId: done.operation.id, rootNodeId: f.owner.ids.file }),
  ]);
  expect(
    await env.DB.prepare("SELECT actor_id FROM trash_ops WHERE op_id=?")
      .bind(done.operation.id)
      .first("actor_id"),
  ).toBe(f.recipient.ids.user);
  await expect(listTrash(env.DB, f.principal, tokens, f.owner.ids.space)).rejects.toThrow(
    "trash_unavailable",
  );
  await expect(
    restoreTrash(f.app, {
      principal: f.principal,
      requestId: "recipient-restore",
      spaceId: f.owner.ids.space,
      trashOpId: done.operation.id,
      destinationParentId: f.owner.ids.folder,
      lockTokens: [],
    }),
  ).rejects.toThrow("authorization_denied");
  const purge = {
    principal: owner,
    requestId: "owner-purge",
    spaceId: f.owner.ids.space,
    trashOpId: done.operation.id,
  };
  await expect(purgeTrash(f.app, { ...purge, principal: f.principal })).rejects.toThrow(
    "authorization_denied",
  );
  const purged = await purgeTrash(f.app, purge);
  expect(purged).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await purgeTrash(f.app, purge)).toEqual(purged);
  expect(await listTrash(env.DB, owner, tokens, f.owner.ids.space)).toMatchObject({ items: [] });
});

it("hides a scoped move receipt and defers its outbox if the original parent leaves the selected share", async () => {
  const f = await fixture();
  const originalParent = await sharedDestination(f, "Original");
  const destination = await sharedDestination(f, "Next");
  await transfer(f, "move", originalParent, "first-move");
  const done = await transfer(f, "move", destination, "second-move");
  if (done.kind !== "terminal" || done.operation.state !== "committed")
    throw new Error("missing_terminal");
  expect(await lookupOperation(env.DB, f.principal, done.operation.id)).not.toBeNull();
  expect(
    await moveNode(f.app, {
      principal: accessPrincipal(f.session),
      requestId: "parent-outside",
      spaceId: f.owner.ids.space,
      nodeId: originalParent,
      destinationParentId: f.owner.ids.root,
      name: "Outside",
      lockTokens: [],
      operation: "node.move",
    }),
  ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await lookupOperation(env.DB, f.principal, done.operation.id)).toBeNull();
  expect(await dispatch(f, done.operation.id)).toBe("retry");
});

it("accepts selected move/copy/trash HTTP and refuses a shared restore request", async () => {
  const f = await fixture();
  const destination = await sharedDestination(f);
  const http = (path: string, method: string, body: unknown) =>
    handleNodeMutationHttp(
      new Request(`${origin}/api/v1/${path}`, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
      f.app,
      f.principal,
      csrf,
    );
  const body = {
    spaceId: f.owner.ids.space,
    share: f.share,
    destinationParentId: destination,
    name: "Moved",
  };
  expect((await http(`nodes/${f.owner.ids.file}/move`, "POST", body)).status).toBe(200);
  expect(
    (
      await http(`nodes/${f.owner.ids.file}/copy`, "POST", {
        ...body,
        name: "Copied",
        depth: "infinity",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await http(`nodes/${f.owner.ids.file}`, "DELETE", {
        spaceId: f.owner.ids.space,
        share: f.share,
      })
    ).status,
  ).toBe(200);
  expect((await http("trash/any/restore", "POST", body)).status).toBe(400);
});

it("does not consume a selected copy event after its original source leaves the share", async () => {
  const f = await fixture();
  const destination = await sharedDestination(f);
  const copied = await transfer(f, "copy", destination, "copy-source");
  if (copied.kind !== "terminal" || copied.operation.state !== "committed")
    throw new Error("missing_terminal");
  expect(
    await moveNode(f.app, {
      principal: accessPrincipal(f.session),
      requestId: "source-outside",
      spaceId: f.owner.ids.space,
      nodeId: f.owner.ids.file,
      destinationParentId: f.owner.ids.root,
      name: "Outside",
      lockTokens: [],
      operation: "node.move",
    }),
  ).toMatchObject({ kind: "terminal", operation: { state: "committed" } });
  expect(await lookupOperation(env.DB, f.principal, copied.operation.id)).toBeNull();
  expect(await dispatch(f, copied.operation.id)).toBe("retry");
});
