import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { authorizeNode } from "../../src/auth/authorize";
import { davPrincipalForPath, parseDavPath, resolveDavNode } from "../../src/dav/path";
import { atomicBatch } from "../../src/db/primary";
import type { R2WriteRequest } from "../../src/db/r2Write";
import type { Env } from "../../src/env";
import { consumeOutbox } from "../../src/jobs/consumeOutbox";
import { lookupOperation } from "../../src/jobs/operations";
import { davUploadRow } from "../../src/services/davUpload";
import { updateInternalShare } from "../../src/services/internalShares";
import { putFile } from "../../src/services/putFile";
import { davBucket } from "../fixtures/davPut";
import { davSharedFixture as fixture } from "../fixtures/davShared";
import { clearEndedR2TestWrites, mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearEndedR2TestWrites();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const origin = "https://app.invalid";

const pf = { Depth: "1" };
const lockBody =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';

it("lists fixed mounts under Shared, keeps renamed roots stable and rejects virtual mutations", async () => {
  const f = await fixture();
  const root = await f.call("PROPFIND", "/dav/", pf);
  expect(root.status).toBe(207);
  expect(await root.text()).toContain("<D:href>/dav/Shared/</D:href>");
  const listing = await f.call("PROPFIND", "/dav/Shared/", pf);
  expect(listing.status).toBe(207);
  const xml = await listing.text();
  expect(xml).toContain(`<D:href>${f.base}/</D:href>`);
  expect(xml).not.toContain("parent_id");
  await env.DB.prepare("UPDATE nodes SET name='Renamed',name_ci='renamed' WHERE id=?")
    .bind(f.owner.ids.folder)
    .run();
  const renamed = await f.call("PROPFIND", f.base, pf);
  expect(renamed.status).toBe(207);
  const body = await renamed.text();
  expect(body).toContain(`<D:href>${f.base}/</D:href>`);
  expect(body).toContain("<D:displayname>Renamed</D:displayname>");
  expect(body).toContain(`${f.base}/File`);
  expect((await f.call("OPTIONS", "/dav/Shared")).headers.get("Allow")).toBe("OPTIONS, PROPFIND");
  expect((await f.call("MKCOL", "/dav/Shared/new")).status).toBe(404);
  for (const method of ["PUT", "LOCK", "DELETE"])
    expect((await f.call(method, "/dav/Shared/")).status).toBe(405);
  for (const method of ["MOVE", "DELETE", "MKCOL"])
    expect((await f.call(method, f.base)).status).toBe(403);
});

it.each(["limited", "no-read", "revoked-grant", "deleted-ancestor", "disabled-owner", "legacy"])(
  "hides mounts with %s authority",
  async (mode) => {
    const f = await fixture(mode === "deleted-ancestor");
    if (mode === "limited")
      await env.DB.prepare("UPDATE app_passwords SET root_node_id=? WHERE id=?")
        .bind(f.recipient.ids.root, f.id)
        .run();
    if (mode === "no-read")
      await env.DB.prepare(
        "DELETE FROM credential_scopes WHERE credential_id=? AND scope='node:read'",
      )
        .bind(f.principal.credential_id)
        .run();
    if (mode === "revoked-grant") await f.revoke();
    if (mode === "deleted-ancestor")
      await atomicBatch(env.DB, [
        {
          sql: "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,purge_after,epoch) VALUES(?,?,?,?,'trashed',1,9999999999999,1)",
          values: ["deleted", f.owner.ids.user, f.owner.ids.space, f.owner.ids.folder],
        },
        {
          sql: "UPDATE nodes SET deleted_at=1,deleted_op_id='deleted' WHERE id=?",
          values: [f.owner.ids.folder],
        },
      ]);
    if (mode === "disabled-owner")
      await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?")
        .bind(Date.now(), f.owner.ids.user)
        .run();
    if (mode === "legacy") {
      // Historical rows were inserted before the immutable mount existed.
      await env.DB.prepare(
        "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES('legacy',?,?,'internal',1)",
      )
        .bind(f.owner.ids.user, f.owner.ids.folder)
        .run();
      await env.DB.prepare(
        "INSERT INTO share_grants(share_id,user_id,version) VALUES('legacy',?,1)",
      )
        .bind(f.recipient.ids.user)
        .run();
      await env.DB.prepare(
        "INSERT INTO share_actions(share_id,action) VALUES('legacy','read')",
      ).run();
    }
    const response = await f.call("PROPFIND", "/dav/Shared/", pf);
    if (mode === "limited" || mode === "no-read") expect(response.status).toBe(404);
    else {
      expect(response.status).toBe(207);
      const body = await response.text();
      expect(body).not.toContain(mode === "legacy" ? "legacy" : f.base);
    }
    if (mode !== "legacy") expect((await f.call("PROPFIND", f.base, pf)).status).toBe(404);
    if (mode === "limited")
      expect(await (await f.call("PROPFIND", "/dav/", pf)).text()).not.toContain("/dav/Shared/");
  },
);

it("stores shared PUT bytes under the owner with selected ledger identity and rejects stale validators", async () => {
  const f = await fixture();
  const path = f.base + "/new.txt";
  expect(
    (await f.call("PUT", path, { "Content-Length": "3", "If-None-Match": "*" }, "abc")).status,
  ).toBe(201);
  const read = await f.call("GET", path);
  expect(read.status).toBe(200);
  expect(await read.text()).toBe("abc");
  const etag = read.headers.get("ETag")!;
  const head = await f.call("HEAD", path);
  expect(head.headers.get("Content-Length")).toBe("3");
  const range = await f.call("GET", path, { Range: "bytes=1-2" });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe("bc");
  for (const value of ['"stale"', `W/${etag}`])
    expect(
      (await f.call("PUT", path, { "Content-Length": "3", "If-Match": value }, "def")).status,
    ).toBe(412);
  expect(
    (await f.call("PUT", path, { "Content-Length": "3", "If-Match": etag }, "def")).status,
  ).toBe(204);
  const rows = await env.DB.prepare(
    "SELECT u.*,o.principal_id,o.selected_share_id AS operation_share FROM uploads u JOIN operations o ON o.op_id=u.completion_op_id WHERE u.credential_id=? ORDER BY u.created_at",
  )
    .bind(f.principal.credential_id)
    .all<Record<string, unknown>>();
  expect(rows.results).toHaveLength(2);
  for (const row of rows.results) {
    expect(row).toMatchObject({
      source: "dav",
      state: "completed",
      owner_id: f.owner.ids.user,
      selected_share_id: f.share.id,
      selected_share_version: f.share.version,
      principal_id: f.recipient.ids.user,
      operation_share: f.share.id,
    });
    await env.DB.prepare("UPDATE outbox SET state='sent' WHERE op_id=?")
      .bind(row.completion_op_id)
      .run();
    expect(await consumeOutbox(mutationEnv(), `${row.completion_op_id}_event`)).toBe("completed");
  }
  await f.revoke();
  expect((await f.call("GET", path)).status).toBe(404);
  for (const row of rows.results)
    expect(await lookupOperation(env.DB, f.principal, String(row.completion_op_id))).toBeNull();
});

it("overwrites a directly mounted file using its stored name without granting parent access", async () => {
  const f = await fixture(true);
  expect(
    (
      await f.call(
        "PUT",
        f.base,
        { "Content-Length": "3", "If-Match": `"b-${f.owner.ids.blob}"` },
        "new",
      )
    ).status,
  ).toBe(204);
  const read = await f.call("GET");
  expect(await read.text()).toBe("new");
  expect(
    await env.DB.prepare("SELECT name FROM nodes WHERE id=?").bind(f.owner.ids.file).first("name"),
  ).toBe("File");
  const principal = await davPrincipalForPath(env.DB, f.principal, parseDavPath(f.base));
  await expect(
    authorizeNode(env.DB, principal, {
      operation: "node.read",
      nodeId: f.owner.ids.folder,
      spaceId: f.owner.ids.space,
    }),
  ).rejects.toThrow("authorization_denied");
});

it("enforces the selected read-only role despite a broader edit grant", async () => {
  const f = await fixture(false, "read");
  expect((await f.call("PROPFIND", f.base, pf)).status).toBe(207);
  expect((await f.call("MKCOL", f.base + "/Denied", { "Idempotency-Key": "denied" })).status).toBe(
    404,
  );
  expect((await f.call("PUT", f.base + "/new", { "Content-Length": "3" }, "abc")).status).toBe(404);
  expect((await f.call("DELETE", f.base + "/File")).status).toBe(404);
});

it("runs MKCOL, PROPPATCH, COPY, MOVE and DELETE within a single mount", async () => {
  const f = await fixture();
  expect((await f.call("MKCOL", f.base + "/Dest", { "Idempotency-Key": "folder" })).status).toBe(
    201,
  );
  const patch =
    '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:color>blue</X:color></D:prop></D:set></D:propertyupdate>';
  expect(
    (await f.call("PROPPATCH", f.base + "/File", { "Idempotency-Key": "props" }, patch)).status,
  ).toBe(207);
  expect(
    (await f.call("COPY", f.base + "/File", { Destination: origin + f.base + "/Copy" })).status,
  ).toBe(201);
  expect(
    (await f.call("MOVE", f.base + "/Copy", { Destination: origin + f.base + "/Dest/Moved" }))
      .status,
  ).toBe(201);
  expect(await (await f.call("PROPFIND", f.base + "/Dest/Moved", { Depth: "0" })).text()).toContain(
    "blue",
  );
  expect((await f.call("DELETE", f.base + "/Dest/Moved")).status).toBe(204);
  const ops = await env.DB.prepare(
    "SELECT op_id,selected_share_id FROM operations WHERE credential_id=?",
  )
    .bind(f.principal.credential_id)
    .all<{ op_id: string; selected_share_id: string }>();
  expect(ops.results).toHaveLength(5);
  expect(ops.results.every((o) => o.selected_share_id === f.share.id)).toBe(true);
  for (const method of ["COPY", "MOVE"]) {
    expect(
      (
        await f.call(method, f.base + "/File", {
          Destination: origin + "/dav/Folder/Outside",
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.call(method, "/dav/Folder/File", { Destination: origin + f.base + "/Outside" }))
        .status,
    ).toBe(403);
  }
});

it("creates and refreshes shared locks, enforces tagged If bounds, and stores empty files under the owner", async () => {
  const f = await fixture();
  const path = f.base + "/empty";
  const lock = await f.call("LOCK", path, { Depth: "0", Timeout: "Second-600" }, lockBody);
  expect(lock.status).toBe(201);
  const token = lock.headers.get("Lock-Token")!;
  expect(token).toMatch(/^<opaquelocktoken:/);
  const row = await env.DB.prepare(
    "SELECT b.r2_key FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.parent_id=? AND n.name='empty'",
  )
    .bind(f.owner.ids.folder)
    .first<{ r2_key: string }>();
  expect(row!.r2_key).toMatch(`u/${f.owner.ids.user}/b/`);
  expect((await env.BLOBS.head(row!.r2_key))?.size).toBe(0);
  expect((await f.call("LOCK", path, { If: `(${token})`, Timeout: "Second-120" })).status).toBe(
    200,
  );
  expect(
    (await f.call("PUT", path, { "Content-Length": "3", "If-Match": "*" }, "abc")).status,
  ).toBe(423);
  expect(
    (
      await f.call(
        "PUT",
        path,
        {
          "Content-Length": "3",
          If: `<${origin}/dav/Shared/${f.broaderMount}/Folder/empty> (${token})`,
        },
        "abc",
      )
    ).status,
  ).toBe(412);
  expect(
    (await f.call("PUT", path, { "Content-Length": "3", If: `(${token})` }, "abc")).status,
  ).toBe(204);
  expect((await f.call("UNLOCK", path, { "Lock-Token": token })).status).toBe(204);
});

it.each([false, true])(
  "redacts owner ancestor paths and lock owner text, file mount=%s",
  async (file) => {
    const f = await fixture(file);
    await updateInternalShare(mutationEnv(), f.session, f.broader.id, f.broader.version, null);
    const lock = await f.app.LOCKS.get(f.app.LOCKS.idFromName(f.owner.ids.space)).createDavLock({
      requestId: crypto.randomUUID(),
      spaceId: f.owner.ids.space,
      nodeId: f.owner.ids.root,
      principal: {
        kind: "user",
        user_id: f.owner.ids.user,
        credential_id: f.owner.ids.credential,
        epoch: 1,
      },
      displayHref: "/dav/Private%20Parent/",
      depth: "infinity",
      ownerText: "private-owner-info",
      timeoutSeconds: 600,
    });
    for (const path of ["/dav/Shared/", f.base, ...(file ? [] : [f.base + "/File"])]) {
      const response = await f.call("PROPFIND", path, pf);
      expect(response.status).toBe(207);
      const body = await response.text();
      expect(body).not.toContain("Private");
      expect(body).not.toContain("private-owner-info");
      expect(body).not.toContain(lock.token);
      if (file) expect(body).toContain(`<D:lockroot><D:href>${f.base}</D:href>`);
      expect(body).toContain("<D:activelock>");
    }
    expect(
      (
        await f.call(
          "PUT",
          file ? f.base : f.base + "/File",
          { "Content-Length": "3", "If-Match": "*" },
          "abc",
        )
      ).status,
    ).toBe(423);
  },
);

it("rechecks share scope in the listing batch after path resolution", async () => {
  const f = await fixture();
  f.app.DB = injectBatch(
    (sql) => sql.includes("SELECT t.id,t.name,t.kind"),
    async () => {
      await f.revoke();
    },
    false,
  );
  const response = await f.call("PROPFIND", f.base, pf);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("File");
  await expect(
    resolveDavNode(
      env.DB,
      { ...f.principal, selected_share: f.share },
      parseDavPath(`/dav/Shared/${f.broaderMount}/Folder`),
    ),
  ).rejects.toThrow("dav_node_unavailable");
});

it("retains stored bytes and selected provenance after share revocation during PUT", async () => {
  const f = await fixture();
  const principal = { ...f.principal, selected_share: f.share };
  const requestId = crypto.randomUUID();
  const input = {
    principal,
    requestId,
    spaceId: f.owner.ids.space,
    parentId: f.owner.ids.folder,
    name: "late.txt",
    size: 3,
    mime: "text/plain",
    lockTokens: [],
  };
  const app = {
    ...f.app,
    BLOBS: davBucket({
      put: async (key, value, options) => {
        const object = await env.BLOBS.put(key, value, options);
        await f.revoke();
        return object;
      },
    }),
  };
  await expect(putFile(app, { ...input, body: new Blob(["abc"]).stream() })).rejects.toThrow();
  const id = await env.DB.prepare("SELECT substr(id,5) AS id FROM uploads WHERE credential_id=?")
    .bind(f.principal.credential_id)
    .first<string>("id");
  const row = await davUploadRow(env.DB, id!);
  expect(row).toMatchObject({
    state: "completing",
    selected_share_id: f.share.id,
    selected_share_version: f.share.version,
  });
  expect((await env.BLOBS.head(`u/${f.owner.ids.user}/b/${row!.blob_id}`))?.size).toBe(3);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE parent_id=? AND name='late.txt'")
      .bind(f.owner.ids.folder)
      .first("n"),
  ).toBe(0);
  await expect(
    putFile(f.app, {
      ...input,
      principal: { ...f.principal, selected_share: f.broader },
      body: new Blob(["abc"]).stream(),
    }),
  ).rejects.toThrow();
});

it("rechecks the selected DAV grant at native write admission", async () => {
  const f = await fixture();
  const control = f.app.CONTROL.get(f.app.CONTROL.idFromName("fixture"));
  let checked = false;
  f.app.CONTROL = {
    idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
    get: () => ({
      ...control,
      beginR2Write: async (request: R2WriteRequest) => {
        await f.revoke();
        checked = true;
        return control.beginR2Write(request);
      },
    }),
  } as unknown as Env["CONTROL"];
  expect((await f.call("PUT", f.base + "/blocked", { "Content-Length": "3" }, "abc")).status).toBe(
    503,
  );
  expect(checked).toBe(true);
  const row = await env.DB.prepare("SELECT blob_id FROM uploads WHERE credential_id=?")
    .bind(f.principal.credential_id)
    .first<{ blob_id: string }>();
  expect(row).not.toBeNull();
  expect(await env.BLOBS.head(`u/${f.owner.ids.user}/b/${row!.blob_id}`)).toBeNull();
});
it("binds namespace permit retries to the originally selected share", async () => {
  const f = await fixture(),
    lock = f.app.LOCKS.get(f.app.LOCKS.idFromName(f.owner.ids.space));
  const input = {
    requestId: crypto.randomUUID(),
    spaceId: f.owner.ids.space,
    parentId: f.owner.ids.folder,
    principal: { ...f.principal, selected_share: f.share },
    lockTokens: [],
  };
  const permit = await lock.acquireCreate(input);
  await expect(
    lock.acquireCreate({ ...input, principal: { ...f.principal, selected_share: f.broader } }),
  ).rejects.toThrow("lock_intent_conflict");
  await lock.release(input.requestId, permit);
});
it("bounds the virtual mount catalog and serves Depth zero without walking it", async () => {
  const f = await fixture();
  for (let start = 0; start < 1000; start += 20) {
    const statements = [];
    for (let i = start; i < start + 20; i++)
      statements.push(
        {
          sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at,mount_name,mount_name_ci) VALUES(?,?,?,'internal',1,?,?)",
          values: [`many_${i}`, f.owner.ids.user, f.owner.ids.folder, `many-${i}`, `many-${i}`],
        },
        {
          sql: "INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)",
          values: [`many_${i}`, f.recipient.ids.user],
        },
        {
          sql: "INSERT INTO share_actions(share_id,action) VALUES(?,'read')",
          values: [`many_${i}`],
        },
      );
    await atomicBatch(env.DB, statements);
  }
  expect((await f.call("PROPFIND", "/dav/Shared/", { Depth: "0" })).status).toBe(207);
  expect((await f.call("PROPFIND", "/dav/Shared/", pf)).status).toBe(507);
});

it("preserves app-password scopes on selected writes, including write-only PUT and MOVE", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "DELETE FROM credential_scopes WHERE credential_id=? AND scope IN ('node:read','node:delete')",
  )
    .bind(f.principal.credential_id)
    .run();
  expect((await f.call("GET", f.base + "/File")).status).toBe(404);
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
  expect(
    (await f.call("MOVE", f.base + "/File", { Destination: origin + f.base + "/Moved" })).status,
  ).toBe(201);
  expect((await f.call("DELETE", f.base + "/Moved")).status).toBe(404);
  await env.DB.prepare("DELETE FROM credential_scopes WHERE credential_id=? AND scope='node:write'")
    .bind(f.principal.credential_id)
    .run();
  expect(
    (await f.call("MOVE", f.base + "/Moved", { Destination: origin + f.base + "/Denied" })).status,
  ).toBe(404);
});
