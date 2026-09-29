import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { beforeAll, expect, it } from "vitest";
import { handleGalleryHttp } from "../../src/api/gallery";
import { privateAppRoute } from "../../src/api/privateApp";
import { handlePublicShareHttp, publicShareRoute } from "../../src/api/publicShares";
import { contentKeyRing } from "../../src/auth/contentTokens";
import { GalleryCursorTokens } from "../../src/auth/galleryCursor";
import { NodeCursorTokens } from "../../src/auth/nodeCursor";
import { atomicBatch } from "../../src/db/primary";
import { IMAGE_METADATA_GENERATOR } from "../../src/media/images/inspect";
import { IMAGE_TRANSFORM_GENERATOR } from "../../src/media/images/transform";
import { GALLERY_CANDIDATES, galleryStatement, listGallery } from "../../src/services/gallery";
import { foundationFixture } from "../fixtures/foundation";
import { publicShareFixture } from "../fixtures/publicShare";
import { injectBatch } from "../fixtures/uploadEnv";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
async function metadata(node: string, blob: string, taken: number | null = null) {
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='image/png' WHERE id=?").bind(blob).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO node_media(node_id,blob_id,generator_version,width,height,taken_at,camera_model) VALUES(?,?,?,16,12,?,'<img src=x>')",
  )
    .bind(node, blob, IMAGE_METADATA_GENERATOR, taken)
    .run();
}
async function fixture() {
  await env.DB.prepare("UPDATE control SET epoch=1,maintenance=0").run();
  const f = foundationFixture(crypto.randomUUID(), Date.now());
  await atomicBatch(env.DB, f.statements);
  await metadata(f.ids.file, f.ids.blob, 200);
  const ring = await contentKeyRing("test", {
    test: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const tokens = new GalleryCursorTokens(ring),
    cursors = new NodeCursorTokens(ring);
  const principal = {
    kind: "user" as const,
    user_id: f.ids.user,
    credential_id: f.ids.credential,
    epoch: 1,
  };
  const list = (recursive = false, cursor?: string, root = f.ids.folder) =>
    listGallery(env.DB, principal, root, recursive, tokens, cursor);
  const add = async (count: number, parent = f.ids.folder, kind = "file") => {
    const prefix = crypto.randomUUID();
    if (kind === "file")
      await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<?)
        INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at)
        SELECT ?||printf('%06d',i),?,'u/'||?||'/b/'||?||printf('%06d',i),3,'etag','image/png','committed',1 FROM seq`)
        .bind(count - 1, prefix + "b", f.ids.user, f.ids.user, prefix + "b")
        .run();
    await env.DB.prepare(`WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i<?)
      INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,created_at,updated_at)
      SELECT ?||printf('%06d',i),?,?,?,printf('%06d.png',i),printf('%06d.png',i),?,CASE WHEN ? IS NULL THEN NULL ELSE ?||printf('%06d',i) END,1,100 FROM seq`)
      .bind(
        count - 1,
        prefix,
        f.ids.space,
        f.ids.user,
        parent,
        kind,
        kind === "file" ? prefix + "b" : null,
        prefix + "b",
      )
      .run();
    if (kind === "file")
      await env.DB.prepare(`INSERT INTO node_media(node_id,blob_id,generator_version,width,height,taken_at)
      SELECT id,current_blob_id,?,16,12,100 FROM nodes WHERE id LIKE ?`)
        .bind(IMAGE_METADATA_GENERATOR, prefix + "%")
        .run();
    return Array.from({ length: count }, (_, i) => prefix + String(i).padStart(6, "0"));
  };
  return { f, principal, tokens, cursors, list, add };
}
it("returns exact current image metadata, orders by date/id and pages 200 with bound cursors", async () => {
  const t = await fixture(),
    ids = await t.add(203);
  const first = await t.list();
  expect(first.items).toHaveLength(200);
  expect(first.items[0]).toMatchObject({
    id: t.f.ids.file,
    takenAt: 200,
    thumbnail: "pending",
    cameraModel: "<img src=x>",
  });
  expect(first.items.map((x) => x.id)).toEqual([t.f.ids.file, ...ids.slice(0, 199)]);
  expect((await t.list(false, first.nextCursor!)).items.map((x) => x.id)).toEqual(ids.slice(199));
  expect((await t.list(false, first.nextCursor!)).nextCursor).toBeNull();
  for (const args of [
    [true, first.nextCursor],
    [false, first.nextCursor, t.f.ids.root],
    [false, first.nextCursor! + "x"],
  ] as const)
    await expect(t.list(args[0], args[1]!, args[2])).rejects.toThrow("invalid_gallery_cursor");
  const old = await t.tokens.issue({
    ...(await t.tokens.verify(first.nextCursor!)),
    generator: "old",
  });
  await expect(t.list(false, old)).rejects.toThrow("invalid_gallery_cursor");
  await expect(t.cursors.verify(first.nextCursor!)).rejects.toThrow("invalid_node_cursor");
  await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
    .bind(t.f.ids.space)
    .run();
  await expect(t.list(false, first.nextCursor!)).rejects.toThrow("invalid_gallery_cursor");
});
it("limits folder mode and never descends through hidden or deleted folders", async () => {
  const t = await fixture(),
    [folder] = await t.add(1, t.f.ids.folder, "folder");
  const [deep] = await t.add(1, folder);
  expect((await t.list()).items.map((x) => x.id)).toEqual([t.f.ids.file]);
  expect((await t.list(true)).items.map((x) => x.id)).toEqual([t.f.ids.file, deep]);
  await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(folder).run();
  expect((await t.list(true)).items.map((x) => x.id)).toEqual([t.f.ids.file]);
  await expect(t.list(true, undefined, folder)).rejects.toThrow();
  const trash = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,created_at,epoch) VALUES(?,?,?,?,'trashed',1,1)",
  )
    .bind(trash, t.f.ids.user, t.f.ids.space, folder)
    .run();
  await env.DB.prepare("UPDATE nodes SET hidden=0,deleted_at=1,deleted_op_id=? WHERE id=?")
    .bind(trash, folder)
    .run();
  expect((await t.list(true)).items.map((x) => x.id)).toEqual([t.f.ids.file]);
});
it.each(["blob", "generator", "mime"])("excludes stale or unsafe %s metadata", async (kind) => {
  const t = await fixture();
  if (kind === "generator")
    await env.DB.prepare("UPDATE node_media SET generator_version='old' WHERE node_id=?")
      .bind(t.f.ids.file)
      .run();
  if (kind === "mime")
    await env.DB.prepare("UPDATE blobs SET mime_sniffed='text/html' WHERE id=?")
      .bind(t.f.ids.blob)
      .run();
  if (kind === "blob") {
    await env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,state,created_at) VALUES(?,?,?,1,'x','committed',1)",
    )
      .bind(t.f.ids.blob + "new", t.f.ids.user, `u/${t.f.ids.user}/b/new`)
      .run();
    await env.DB.prepare("UPDATE nodes SET current_blob_id=? WHERE id=?")
      .bind(t.f.ids.blob + "new", t.f.ids.file)
      .run();
  }
  expect((await t.list()).items).toEqual([]);
});
it("reports unsupported thumbnails while retaining AVIF originals and filters raw failure details", async () => {
  const t = await fixture();
  await env.DB.prepare("UPDATE blobs SET mime_sniffed='image/avif' WHERE id=?")
    .bind(t.f.ids.blob)
    .run();
  await env.DB.prepare(
    "INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,epoch,error_code) VALUES(?,?,'thumbnail','sm',?,'failed',1,'image_unsupported_binding')",
  )
    .bind(crypto.randomUUID(), t.f.ids.blob, IMAGE_TRANSFORM_GENERATOR)
    .run();
  expect((await t.list()).items[0]).toMatchObject({ mime: "image/avif", thumbnail: "unsupported" });
  expect(JSON.stringify(await t.list())).not.toContain("image_unsupported_binding");
});
it.each(["credential", "hidden", "generation"])(
  "rechecks %s in the page transaction",
  async (kind) => {
    const t = await fixture();
    const db = injectBatch(
      (sql) => sql.includes("walk(id,parent_id"),
      async () => {
        if (kind === "credential")
          await env.DB.prepare("UPDATE sessions SET revoked_at=1 WHERE id=?")
            .bind(t.f.ids.session)
            .run();
        if (kind === "hidden")
          await env.DB.prepare("UPDATE nodes SET hidden=1 WHERE id=?").bind(t.f.ids.root).run();
        if (kind === "generation")
          await env.DB.prepare("UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?")
            .bind(t.f.ids.space)
            .run();
      },
      false,
    );
    await expect(listGallery(db, t.principal, t.f.ids.folder, true, t.tokens)).rejects.toThrow();
  },
);
it("requires an explicit current internal share without borrowing another grant", async () => {
  const owner = await fixture(),
    other = await fixture(),
    share = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO shares(id,owner_id,root_node_id,kind,created_at) VALUES(?,?,?,'internal',1)",
  )
    .bind(share, owner.f.ids.user, owner.f.ids.folder)
    .run();
  await env.DB.prepare("INSERT INTO share_actions(share_id,action) VALUES(?,'read')")
    .bind(share)
    .run();
  await env.DB.prepare("INSERT INTO share_grants(share_id,user_id,version) VALUES(?,?,1)")
    .bind(share, other.f.ids.user)
    .run();
  const p = { ...other.principal, selected_share: { id: share, version: 1 } };
  const list = (principal = p, root = owner.f.ids.folder) =>
    listGallery(env.DB, principal, root, true, owner.tokens);
  expect((await list()).items.map((x) => x.id)).toEqual([owner.f.ids.file]);
  await expect(list(other.principal as typeof p)).rejects.toThrow();
  await expect(list(p, owner.f.ids.root)).rejects.toThrow();
  await env.DB.prepare("UPDATE share_grants SET disabled_at=1 WHERE share_id=?").bind(share).run();
  await expect(list()).rejects.toThrow();
});
it("routes private queries strictly and binds public gallery reads to their unlock session", async () => {
  const t = await fixture(),
    app = { ...env, APP_ORIGIN: "https://app.invalid" };
  const request = (suffix = "") =>
    new Request(`${app.APP_ORIGIN}/api/v1/nodes/${t.f.ids.folder}/gallery${suffix}`);
  expect(privateAppRoute(request())).toBe(true);
  expect((await handleGalleryHttp(request(), app, t.principal, t.cursors)).status).toBe(200);
  for (const query of ["?recursive=yes", "?recursive=1&recursive=0", "?cursor=", "?unknown=1"])
    expect((await handleGalleryHttp(request(query), app, t.principal, t.cursors)).status).toBe(400);
  const f = await publicShareFixture("read");
  await metadata(f.f.ids.file, f.f.ids.blob);
  const deps = { ...f.deps, cursors: t.cursors };
  const r = f.request("/gallery?recursive=1");
  expect(publicShareRoute(r)).toBe(true);
  const http = (r: Request) => handlePublicShareHttp(r, f.app, 1, deps);
  expect((await (await http(r)).json<any>()).items[0].id).toBe(f.f.ids.file);
  expect((await http(f.request(`/gallery?nodeId=${f.f.ids.root}`))).status).toBe(404);
  const missing = new Request(r);
  missing.headers.delete("Share-Session");
  expect((await http(missing)).status).toBe(412);
  await env.DB.prepare("UPDATE shares SET disabled_at=1 WHERE id=?").bind(f.share.id).run();
  expect([401, 404]).toContain((await http(new Request(r))).status);
});
it("measures the 50k gate and enforces the SQL candidate cap on wide folders", {
  timeout: 120000,
}, async () => {
  const t = await fixture();
  await t.add(50050);
  const measurements = [];
  for (const limit of [50000, GALLERY_CANDIDATES]) {
    const start = Date.now();
    const result = await env.DB.prepare(galleryStatement(true, limit))
      .bind(
        t.f.ids.folder,
        t.f.ids.space,
        t.f.ids.user,
        IMAGE_METADATA_GENERATOR,
        IMAGE_TRANSFORM_GENERATOR,
        null,
        null,
      )
      .all<{ scanned: number; items: string }>();
    const row = result.results[0]!;
    expect(row.scanned).toBe(limit);
    expect(JSON.parse(row.items)).toHaveLength(201);
    measurements.push({ limit, rowsRead: result.meta.rows_read, ms: Date.now() - start });
  }
  // DESIGN §15.1 requires the 10k fallback when the 50k gate is not met.
  const gate = measurements[0]!.rowsRead <= 60000 && measurements[0]!.ms <= 300;
  expect(GALLERY_CANDIDATES, JSON.stringify(measurements)).toBe(gate ? 50000 : 10000);
  const page = await t.list(true);
  expect(page.items).toHaveLength(200);
  expect(page.truncated).toBe(true);
  expect(page.scannedNodes).toBe(GALLERY_CANDIDATES);
});
