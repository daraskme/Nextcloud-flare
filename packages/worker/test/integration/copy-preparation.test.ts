import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import {
  copyPreparationAssertions,
  prepareCrossOwnerCopy,
  preparedCopyBlobs,
  reservePreparedCopyStatements,
} from "../../src/services/copyPreparation";
import { createInternalShare, updateInternalShare } from "../../src/services/internalShares";
import { auditOwnerLedger } from "../../src/services/refs";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
});
const jobId = () => "copy_" + crypto.randomUUID().replaceAll("-", "").repeat(2);
async function fixture(file = false, physical = true) {
  const owner = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  const recipient = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
  await atomicBatch(env.DB, [
    ...owner.statements,
    ...recipient.statements,
    {
      sql: "UPDATE users SET email=? WHERE id=?",
      values: [recipient.ids.user + "@example.invalid", recipient.ids.user],
    },
    ...(physical
      ? [
          {
            sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'etag',1)",
            values: [owner.ids.blob],
          },
        ]
      : []),
  ]);
  const session = {
    user_id: owner.ids.user,
    credential_id: owner.ids.credential,
    session_id: owner.ids.session,
    role: "app_admin" as const,
    epoch: 1,
    expires_at: Date.now() + 600000,
  };
  const fields = {
    kind: "internal",
    rootNodeId: file ? owner.ids.file : owner.ids.folder,
    recipients: [recipient.ids.user + "@example.invalid"],
    role: "read",
    expiresAt: null,
  };
  const share = await createInternalShare(mutationEnv(), session, fields);
  const broader = await createInternalShare(mutationEnv(), session, {
    ...fields,
    rootNodeId: owner.ids.root,
    role: "edit",
  });
  const principal = {
    kind: "user" as const,
    user_id: recipient.ids.user,
    credential_id: recipient.ids.credential,
    epoch: 1,
  };
  const input = {
    principal: { ...principal, selected_share: share },
    sourceSpaceId: owner.ids.space,
    sourceNodeId: fields.rootNodeId,
    destination: { spaceId: recipient.ids.space, share: null },
    destinationParentId: recipient.ids.folder,
    name: "Copied",
    depth: "infinity" as const,
  };
  const revoke = () => updateInternalShare(mutationEnv(), session, share.id, share.version, null);
  return { owner, recipient, session, share, broader, principal, input, revoke };
}
async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM blob_pins WHERE blob_id=?) AS pins,(SELECT COUNT(*) FROM reservations WHERE owner_id=?) AS reservations",
  )
    .bind(f.owner.ids.blob, f.recipient.ids.user)
    .first();
}
it("captures complete metadata, hides the root parent, and reserves COW aliases only once", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at,client_mtime,hidden) VALUES(?,?,?,?,'Alias','alias','file',?,1,1,7,1)",
  )
    .bind(
      f.owner.ids.file + "_alias",
      f.owner.ids.space,
      f.owner.ids.user,
      f.owner.ids.folder,
      f.owner.ids.blob,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO node_props(node_id,namespace,name,value_xml) VALUES(?,'urn:test','label','<x:label xmlns:x=\"urn:test\">abc</x:label>')",
  )
    .bind(f.owner.ids.file)
    .run();
  const plan = await prepareCrossOwnerCopy(env.DB, f.input);
  expect(plan.source.entries).toHaveLength(3);
  expect(plan.source.entries.find((n) => n.id === f.owner.ids.folder)?.parentId).toBeNull();
  expect(plan.source.entries.find((n) => n.id.endsWith("_alias"))).toMatchObject({
    hidden: 1,
    mtime: 7,
  });
  expect(plan.source.properties).toHaveLength(1);
  expect(plan).toMatchObject({ transferBytes: 3, logicalBytes: 6 });
  expect((await prepareCrossOwnerCopy(env.DB, f.input)).digest).toBe(plan.digest);
  expect(await counts(f)).toEqual({ pins: 0, reservations: 0 });
  const id = jobId(),
    expires = Date.now() + 60000,
    statements = reservePreparedCopyStatements(plan, id, expires);
  await atomicBatch(env.DB, statements);
  await atomicBatch(env.DB, statements);
  expect(await counts(f)).toEqual({ pins: 1, reservations: 1 });
  expect(preparedCopyBlobs(plan, id)).toHaveLength(1);
  expect(await auditOwnerLedger(env.DB, f.owner.ids.user)).toMatchObject({
    incorrect_refs: 0,
    used_bytes: 3,
    physical_bytes: 3,
    reserved_bytes: 0,
  });
  expect(await auditOwnerLedger(env.DB, f.recipient.ids.user)).toMatchObject({
    incorrect_refs: 0,
    used_bytes: 3,
    physical_bytes: 0,
    reserved_bytes: 3,
  });
  expect(Object.isFrozen(plan.source.entries[0])).toBe(true);
  expect(Object.isFrozen(statements[0]?.values)).toBe(true);
  expect(() => copyPreparationAssertions({ ...plan })).toThrow("invalid_copy_preparation_proof");
});
it.each(["quota", "after_pins"])(
  "rolls back pins and reservations on %s failure",
  async (failure) => {
    const f = await fixture(),
      plan = await prepareCrossOwnerCopy(env.DB, f.input);
    if (failure === "quota")
      await env.DB.prepare("UPDATE users SET quota_bytes=used_bytes WHERE id=?")
        .bind(f.recipient.ids.user)
        .run();
    const statements = [...reservePreparedCopyStatements(plan, jobId(), Date.now() + 60000)];
    if (failure === "after_pins") statements.push({ sql: "INSERT INTO _assert(v) VALUES(1)" });
    await expect(atomicBatch(env.DB, statements)).rejects.toThrow();
    expect(await counts(f)).toEqual({ pins: 0, reservations: 0 });
    expect(await auditOwnerLedger(env.DB, f.owner.ids.user)).toMatchObject({ incorrect_refs: 0 });
  },
);
it.each([
  "stop",
  "credential",
  "destination",
  "node",
  "name",
  "hidden",
  "mtime",
  "property_add",
  "property_replace",
  "blob",
  "membership",
])("rejects stale %s facts in the same reservation batch", async (change) => {
  const f = await fixture();
  await env.DB.prepare("INSERT INTO node_props VALUES(?,'urn:test','label','old')")
    .bind(f.owner.ids.file)
    .run();
  const plan = await prepareCrossOwnerCopy(env.DB, f.input);
  switch (change) {
    case "stop":
      await f.revoke();
      break;
    case "credential":
      await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
        .bind(f.recipient.ids.session)
        .run();
      break;
    case "destination":
      await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
        .bind(f.recipient.ids.folder)
        .run();
      break;
    case "node":
      await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
        .bind(f.owner.ids.file)
        .run();
      break;
    case "name":
      await env.DB.prepare("UPDATE nodes SET name='Changed',name_ci='changed' WHERE id=?")
        .bind(f.owner.ids.file)
        .run();
      break;
    case "hidden":
      await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(f.owner.ids.file).run();
      break;
    case "mtime":
      await env.DB.prepare("UPDATE nodes SET client_mtime=1 WHERE id=?")
        .bind(f.owner.ids.file)
        .run();
      break;
    case "property_add":
      await env.DB.prepare("INSERT INTO node_props VALUES(?,'urn:test','new','value')")
        .bind(f.owner.ids.file)
        .run();
      break;
    case "property_replace":
      await env.DB.prepare("UPDATE node_props SET value_xml='new' WHERE node_id=?")
        .bind(f.owner.ids.file)
        .run();
      break;
    case "blob":
      await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
        .bind(f.owner.ids.file)
        .run();
      break;
    case "membership":
      await env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'New','new','folder',1,1)",
      )
        .bind(f.owner.ids.file + "_new", f.owner.ids.space, f.owner.ids.user, f.owner.ids.folder)
        .run();
      break;
  }
  await expect(
    atomicBatch(env.DB, reservePreparedCopyStatements(plan, jobId(), Date.now() + 60000)),
  ).rejects.toThrow();
  expect(await counts(f)).toEqual({ pins: 0, reservations: 0 });
});
it("rechecks authorization after materializing source properties", async () => {
  const f = await fixture();
  let stopped = false;
  const db = injectBatch(
    (sql) => sql.includes("SELECT * FROM props ORDER BY"),
    async () => {
      await f.revoke();
      stopped = true;
    },
    true,
  );
  await expect(prepareCrossOwnerCopy(db, f.input)).rejects.toThrow();
  expect(stopped).toBe(true);
  expect(await counts(f)).toEqual({ pins: 0, reservations: 0 });
});
it("does not replace a selected source grant or explicit personal destination", async () => {
  const f = await fixture();
  await f.revoke();
  await expect(prepareCrossOwnerCopy(env.DB, f.input)).rejects.toThrow("authorization_denied");
  await expect(
    prepareCrossOwnerCopy(env.DB, { ...f.input, principal: f.principal }),
  ).rejects.toThrow("authorization_denied");
  const g = await fixture();
  await expect(
    prepareCrossOwnerCopy(env.DB, {
      ...g.input,
      destination: { spaceId: g.owner.ids.space, share: null },
      destinationParentId: g.owner.ids.folder,
    }),
  ).rejects.toThrow("authorization_denied");
});
it("allows direct file shares without disclosing their parent", async () => {
  const f = await fixture(true),
    plan = await prepareCrossOwnerCopy(env.DB, f.input);
  expect(plan.source.entries).toHaveLength(1);
  expect(plan.source.entries[0]).toMatchObject({ id: f.owner.ids.file, parentId: null });
  expect(JSON.stringify(plan)).not.toContain(f.owner.ids.folder);
});
it("copies only the collection and its properties for Depth 0", async () => {
  const f = await fixture();
  await env.DB.prepare("INSERT INTO node_props VALUES(?,'urn:test','label','root property')")
    .bind(f.owner.ids.folder)
    .run();
  const plan = await prepareCrossOwnerCopy(env.DB, { ...f.input, depth: "0" });
  expect(plan.source.entries).toHaveLength(1);
  expect(plan.source.properties).toHaveLength(1);
  expect(plan).toMatchObject({ logicalBytes: 0, transferBytes: 0 });
  await atomicBatch(env.DB, reservePreparedCopyStatements(plan, jobId(), Date.now() + 60000));
  expect(await counts(f)).toEqual({ pins: 0, reservations: 0 });
});
it("requires recorded immutable source storage", async () => {
  const f = await fixture(false, false);
  await expect(prepareCrossOwnerCopy(env.DB, f.input)).rejects.toThrow("copy_source_unavailable");
});
it("binds the overwrite subtree and case-folded collision policy", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'target-etag',1)",
  )
    .bind(f.recipient.ids.blob)
    .run();
  await expect(prepareCrossOwnerCopy(env.DB, { ...f.input, name: "file" })).rejects.toThrow();
  const plan = await prepareCrossOwnerCopy(env.DB, {
    ...f.input,
    name: "file",
    overwriteTargetId: f.recipient.ids.file,
  });
  expect(plan.overwrite?.entries[0]).toMatchObject({ id: f.recipient.ids.file, parentId: null });
  await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
    .bind(f.recipient.ids.file)
    .run();
  await expect(atomicBatch(env.DB, copyPreparationAssertions(plan))).rejects.toThrow();
});
it.each(["properties", "bytes"])(
  "rejects excessive %s before fetching property values",
  async (limit) => {
    const f = await fixture();
    await env.DB.prepare(
      "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<?) INSERT INTO node_props(node_id,namespace,name,value_xml) SELECT ?,'urn:test','p'||i,? FROM r",
    )
      .bind(
        limit === "properties" ? 10001 : 1100,
        f.owner.ids.file,
        limit === "properties" ? "x" : "x".repeat(8192),
      )
      .run();
    let fetched = false;
    const db = injectBatch(
      (sql) => sql.includes("SELECT * FROM props ORDER BY"),
      async () => {
        fetched = true;
      },
      false,
    );
    await expect(prepareCrossOwnerCopy(db, f.input)).rejects.toThrow("copy_manifest_too_large");
    expect(fetched).toBe(false);
  },
);
it("accepts exactly 10000 nodes and rejects an overflow sentinel without a partial manifest", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<9998) INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) SELECT ?||'_'||i,?,?,?,'N'||i,'n'||i,'folder',1,1 FROM r",
  )
    .bind(f.owner.ids.folder, f.owner.ids.space, f.owner.ids.user, f.owner.ids.folder)
    .run();
  expect((await prepareCrossOwnerCopy(env.DB, f.input)).source.entries).toHaveLength(10000);
  await env.DB.prepare(
    "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'Overflow','overflow','folder',1,1)",
  )
    .bind(f.owner.ids.folder + "_overflow", f.owner.ids.space, f.owner.ids.user, f.owner.ids.folder)
    .run();
  await expect(prepareCrossOwnerCopy(env.DB, f.input)).rejects.toThrow("copy_manifest_too_large");
});
it("captures the absolute depth boundary without bypassing the database guard", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<63) INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) SELECT ?1||'_'||i,?2,?3,CASE WHEN i=1 THEN ?1 ELSE ?1||'_'||(i-1) END,'N'||i,'n'||i,'folder',1,1 FROM r",
  )
    .bind(f.owner.ids.folder, f.owner.ids.space, f.owner.ids.user)
    .run();
  expect((await prepareCrossOwnerCopy(env.DB, f.input)).source.entries).toHaveLength(65);
  await expect(
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,?,'Too deep','too deep','folder',1,1)",
    )
      .bind(
        f.owner.ids.folder + "_64",
        f.owner.ids.space,
        f.owner.ids.user,
        f.owner.ids.folder + "_63",
      )
      .run(),
  ).rejects.toThrow("invalid_tree_depth");
});
it.each([false, true])(
  "reserves distinct blobs across chunks atomically, late quota failure=%s",
  async (fail) => {
    const f = await fixture();
    await atomicBatch(env.DB, [
      {
        sql: "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<130) INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) SELECT ?1||'_'||i,?2,'u/'||?2||'/b/'||?1||'_'||i,1,'etag','committed',1 FROM r",
        values: [f.owner.ids.blob, f.owner.ids.user],
      },
      {
        sql: "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) SELECT id,size,'etag',1 FROM blobs WHERE owner_id=? AND id<>?",
        values: [f.owner.ids.user, f.owner.ids.blob],
      },
      {
        sql: "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at) SELECT id||'_node',?,?,?,id,id,'file',id,1,1 FROM blobs WHERE owner_id=? AND id<>?",
        values: [
          f.owner.ids.space,
          f.owner.ids.user,
          f.owner.ids.folder,
          f.owner.ids.user,
          f.owner.ids.blob,
        ],
      },
    ]);
    const plan = await prepareCrossOwnerCopy(env.DB, f.input),
      id = jobId();
    expect(plan).toMatchObject({ transferBytes: 133, logicalBytes: 133 });
    expect(preparedCopyBlobs(plan, id)).toHaveLength(131);
    if (fail)
      await env.DB.prepare("UPDATE users SET quota_bytes=133 WHERE id=?")
        .bind(f.recipient.ids.user)
        .run();
    const pending = atomicBatch(
      env.DB,
      reservePreparedCopyStatements(plan, id, Date.now() + 60000),
    );
    if (fail) await expect(pending).rejects.toThrow();
    else await pending;
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE pin_id>=? AND pin_id<?")
        .bind(id + "_p", id + "_q")
        .first("n"),
    ).toBe(fail ? 0 : 131);
    expect(await auditOwnerLedger(env.DB, f.recipient.ids.user)).toMatchObject({
      used_bytes: 3,
      reserved_bytes: fail ? 0 : 133,
      incorrect_refs: 0,
    });
    expect(await auditOwnerLedger(env.DB, f.owner.ids.user)).toMatchObject({
      used_bytes: 133,
      reserved_bytes: 0,
      incorrect_refs: 0,
    });
  },
);
it.each([false, true])(
  "preserves an independently selected destination share, revoked=%s",
  async (revoked) => {
    const f = await fixture(),
      target = foundationFixture(crypto.randomUUID(), Date.now() - 1000);
    await atomicBatch(env.DB, target.statements);
    const session = {
      ...f.session,
      user_id: target.ids.user,
      credential_id: target.ids.credential,
      session_id: target.ids.session,
    };
    const input = {
      kind: "internal",
      rootNodeId: target.ids.folder,
      recipients: [f.recipient.ids.user + "@example.invalid"],
      role: "edit",
      expiresAt: null,
    };
    const share = await createInternalShare(mutationEnv(), session, input);
    await createInternalShare(mutationEnv(), session, { ...input, rootNodeId: target.ids.root });
    const plan = await prepareCrossOwnerCopy(env.DB, {
      ...f.input,
      destination: { spaceId: target.ids.space, share },
      destinationParentId: target.ids.folder,
    });
    if (revoked) await updateInternalShare(mutationEnv(), session, share.id, share.version, null);
    const pending = atomicBatch(
      env.DB,
      reservePreparedCopyStatements(plan, jobId(), Date.now() + 60000),
    );
    if (revoked) await expect(pending).rejects.toThrow();
    else await pending;
    expect(await auditOwnerLedger(env.DB, target.ids.user)).toMatchObject({
      reserved_bytes: revoked ? 0 : 3,
      incorrect_refs: 0,
    });
    expect(await auditOwnerLedger(env.DB, f.recipient.ids.user)).toMatchObject({
      reserved_bytes: 0,
    });
  },
);
it("rolls back destination reservations when the source reference cap prevents its pin", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<999) INSERT INTO blob_pins(pin_id,blob_id,purpose,created_at) SELECT ?1||'_'||i,?1,'copy',1 FROM r",
  )
    .bind(f.owner.ids.blob)
    .run();
  const plan = await prepareCrossOwnerCopy(env.DB, f.input);
  await expect(
    atomicBatch(env.DB, reservePreparedCopyStatements(plan, jobId(), Date.now() + 60000)),
  ).rejects.toThrow();
  expect(await counts(f)).toEqual({ pins: 999, reservations: 0 });
  expect(await auditOwnerLedger(env.DB, f.owner.ids.user)).toMatchObject({ incorrect_refs: 0 });
});
