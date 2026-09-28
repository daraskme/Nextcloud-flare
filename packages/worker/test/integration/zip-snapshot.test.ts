import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { auditOwnerLedger } from "../../src/services/refs";
import {
  pinZipSnapshot,
  releaseExpiredZipPins,
  zipPinsAssertion,
} from "../../src/services/zipPins";
import { prepareZipSnapshot, zipSnapshotAssertions } from "../../src/services/zipSnapshot";
import { foundationFixture } from "../fixtures/foundation";
import { mutationEnv } from "../fixtures/mutationAdmission";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  const now = Date.now(),
    f = foundationFixture(crypto.randomUUID(), now - 1000);
  await atomicBatch(env.DB, f.statements);
  await env.DB.prepare("UPDATE control SET maintenance=0 WHERE singleton=1").run();
  await env.DB.prepare(
    "INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,3,'etag',?)",
  )
    .bind(f.ids.blob, now)
    .run();
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  return { f, principal, source: mutationEnv() };
}

async function folder(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  parentId = f.f.ids.folder,
) {
  const id = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'folder',?,?)`)
    .bind(id, f.f.ids.space, f.f.ids.user, parentId, name, name.toLowerCase(), now, now)
    .run();
  return id;
}

it("snapshots only the authorized folder with Unicode paths and explicit empty directories", async () => {
  const f = await fixture();
  const empty = await folder(f, "空のフォルダー");
  const result = await prepareZipSnapshot(env.DB, f.principal, f.f.ids.folder);
  expect(result.manifest.zip.entries.map((entry) => entry.path)).toEqual([
    "File",
    "空のフォルダー/",
  ]);
  expect(result.manifest.targets).toEqual([
    { spaceId: f.f.ids.space, nodeId: f.f.ids.file, blobId: f.f.ids.blob, purpose: "zip", size: 3 },
  ]);
  expect((await prepareZipSnapshot(env.DB, f.principal, empty)).encoded.totalBytes).toBe(22);
  const root = await prepareZipSnapshot(env.DB, f.principal, f.f.ids.root);
  expect(root.manifest.zip.entries.map((entry) => entry.path)).toEqual([
    "Folder/",
    "Folder/File",
    "Folder/空のフォルダー/",
  ]);
  await expect(prepareZipSnapshot(env.DB, f.principal, f.f.ids.file)).rejects.toThrow(
    /zip_unavailable/,
  );
});

it.each([
  "rename",
  "revision",
  "generation",
  "add",
  "remove",
  "credential",
  "maintenance",
  "storage",
])("rejects a %s race before pin acquisition and leaves the ledger unchanged", async (change) => {
  const f = await fixture(),
    snapshot = await prepareZipSnapshot(env.DB, f.principal, f.f.ids.folder);
  if (change === "rename")
    await env.DB.prepare("UPDATE nodes SET name='Changed',name_ci='changed' WHERE id=?")
      .bind(f.f.ids.file)
      .run();
  if (change === "revision")
    await env.DB.prepare("UPDATE nodes SET revision=revision+1 WHERE id=?")
      .bind(f.f.ids.file)
      .run();
  if (change === "generation")
    await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
      .bind(f.f.ids.space)
      .run();
  if (change === "add") await folder(f, "new");
  if (change === "remove")
    await env.DB.prepare("UPDATE nodes SET parent_id=? WHERE id=?")
      .bind(f.f.ids.root, f.f.ids.file)
      .run();
  if (change === "credential")
    await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?")
      .bind(Date.now(), f.f.ids.session)
      .run();
  if (change === "maintenance") await env.DB.prepare("UPDATE control SET maintenance=1").run();
  if (change === "storage") {
    await env.DB.prepare("UPDATE nodes SET current_blob_id=NULL WHERE id=?")
      .bind(f.f.ids.file)
      .run();
    await env.DB.prepare("UPDATE blobs SET state='deleted' WHERE id=?").bind(f.f.ids.blob).run();
    await env.DB.prepare("UPDATE blob_storage SET removed_at=? WHERE blob_id=?")
      .bind(Date.now(), f.f.ids.blob)
      .run();
  }
  await expect(
    pinZipSnapshot(f.source, snapshot, crypto.randomUUID(), Date.now() + 60_000),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE blob_id=?")
      .bind(f.f.ids.blob)
      .first("n"),
  ).toBe(0);
  expect((await auditOwnerLedger(env.DB, f.f.ids.user))?.incorrect_refs).toBe(0);
});

it("deduplicates COW blobs, retains other readers and only releases expired pins", async () => {
  const f = await fixture(),
    now = Date.now();
  await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
    VALUES(?,?,?,?,'Copy','copy','file',?,?,?)`)
    .bind(crypto.randomUUID(), f.f.ids.space, f.f.ids.user, f.f.ids.folder, f.f.ids.blob, now, now)
    .run();
  const snapshot = await prepareZipSnapshot(env.DB, f.principal, f.f.ids.folder);
  const first = crypto.randomUUID(),
    second = crypto.randomUUID(),
    expiry = now + 60_000;
  await pinZipSnapshot(f.source, snapshot, first, expiry);
  await pinZipSnapshot(f.source, snapshot, first, expiry);
  await pinZipSnapshot(f.source, snapshot, second, expiry);
  expect(
    await env.DB.prepare("SELECT ref_count FROM blobs WHERE id=?")
      .bind(f.f.ids.blob)
      .first("ref_count"),
  ).toBe(4);
  expect(await releaseExpiredZipPins(f.source, 1)).toBe(0);
  await env.DB.prepare("UPDATE blob_pins SET expires_at=1 WHERE pin_id=?")
    .bind(`zip:${first}:0`)
    .run();
  await env.DB.prepare("UPDATE users SET disabled_at=? WHERE id=?").bind(now, f.f.ids.user).run();
  expect(await releaseExpiredZipPins(f.source, 1, { limit: 1 })).toBe(1);
  await atomicBatch(env.DB, [zipPinsAssertion(snapshot.manifest, second, expiry)]);
  await expect(
    atomicBatch(env.DB, [zipPinsAssertion(snapshot.manifest, first, expiry)]),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT ref_count FROM blobs WHERE id=?")
      .bind(f.f.ids.blob)
      .first("ref_count"),
  ).toBe(3);
  expect((await auditOwnerLedger(env.DB, f.f.ids.user))?.incorrect_refs).toBe(0);
  await expect(pinZipSnapshot(f.source, snapshot, first, Date.now() - 1)).rejects.toThrow(
    /invalid_zip_pin/,
  );
});

it("cannot change a pin expiry or release pins during maintenance or the wrong epoch", async () => {
  const f = await fixture(),
    snapshot = await prepareZipSnapshot(env.DB, f.principal, f.f.ids.folder);
  const id = crypto.randomUUID(),
    expiry = Date.now() + 60_000;
  await pinZipSnapshot(f.source, snapshot, id, expiry);
  await expect(pinZipSnapshot(f.source, snapshot, id, expiry + 1)).rejects.toThrow();
  await env.DB.prepare("UPDATE blob_pins SET expires_at=1 WHERE pin_id=?")
    .bind(`zip:${id}:0`)
    .run();
  await expect(releaseExpiredZipPins(f.source, 2)).rejects.toThrow();
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await expect(releaseExpiredZipPins(f.source, 1)).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_pins WHERE pin_id=?")
      .bind(`zip:${id}:0`)
      .first("n"),
  ).toBe(1);
});

it("binds anonymous read shares to their root/version and rejects upload-only links", async () => {
  const f = await fixture(),
    now = Date.now(),
    share = crypto.randomUUID(),
    session = crypto.randomUUID();
  await atomicBatch(env.DB, [
    {
      sql: "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'link',?)",
      values: [share, f.f.ids.user, f.f.ids.folder, now],
    },
    { sql: "INSERT INTO share_actions VALUES(?,'read')", values: [share] },
    {
      sql: "INSERT INTO share_sessions(id,share_id,share_version,secret_digest,epoch,issued_at,expires_at) VALUES(?,?,1,?,1,?,?)",
      values: [session, share, `digest-${session}`, now, now + 60_000],
    },
    {
      sql: "INSERT INTO credentials(id,kind,share_session_id) VALUES(?,'share',?)",
      values: [`ss:${session}`, session],
    },
  ]);
  const principal = {
    kind: "link_share" as const,
    share_id: share,
    share_version: 1,
    credential_id: `ss:${session}`,
    epoch: 1,
  };
  const snapshot = await prepareZipSnapshot(env.DB, principal, f.f.ids.folder);
  await expect(prepareZipSnapshot(env.DB, principal, f.f.ids.root)).rejects.toThrow();
  await env.DB.prepare("UPDATE shares SET version=2 WHERE id=?").bind(share).run();
  await expect(
    atomicBatch(env.DB, zipSnapshotAssertions(snapshot.proof, snapshot.manifest)),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE shares SET version=1,kind='upload_only' WHERE id=?")
    .bind(share)
    .run();
  await expect(prepareZipSnapshot(env.DB, principal, f.f.ids.folder)).rejects.toThrow();
});

it("uses an indexed expiry scan and accepts exactly 1,000 entries", async () => {
  const f = await fixture(),
    now = Date.now();
  for (let i = 0; i < 999; i++) {
    await env.DB.prepare(`INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'folder',?,?)`)
      .bind(
        `empty-${i}`,
        f.f.ids.space,
        f.f.ids.user,
        f.f.ids.folder,
        `empty-${i}`,
        `empty-${i}`,
        now,
        now,
      )
      .run();
  }
  const snapshot = await prepareZipSnapshot(env.DB, f.principal, f.f.ids.folder);
  expect(snapshot.manifest.zip.entries).toHaveLength(1_000);
  const plan =
    await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT pin_id FROM blob_pins INDEXED BY blob_pins_zip_expiry
    WHERE purpose='zip' AND expires_at<=? ORDER BY expires_at,pin_id LIMIT 10`)
      .bind(now)
      .all<{ detail: string }>();
  expect(plan.results.map((row) => row.detail).join(" ")).toContain("blob_pins_zip_expiry");
  await folder(f, "overflow");
  await expect(prepareZipSnapshot(env.DB, f.principal, f.f.ids.folder)).rejects.toThrow(
    /zip_entry_limit/,
  );
}, 30_000);
