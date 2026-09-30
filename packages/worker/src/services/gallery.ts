import type { GalleryItem, GalleryPage } from "../../../shared/src/gallery";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import type { GalleryCursorTokens } from "../auth/galleryCursor";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { IMAGE_METADATA_GENERATOR } from "../media/images/metadata";
import { IMAGE_THUMBNAIL_GENERATOR, IMAGE_THUMBNAIL_VARIANT } from "../media/images/thumbnail";

export const GALLERY_CANDIDATE_LIMIT = 10_000;

function galleryScope(recursive: boolean) {
  return `WITH RECURSIVE walk(id,parent_id,name_ci,kind,depth,entering,visited) AS MATERIALIZED (
    SELECT id,parent_id,name_ci,kind,0,1,1 FROM nodes
      WHERE id=?1 AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL AND hidden=0
    UNION ALL
    SELECT n.id,n.parent_id,n.name_ci,CASE WHEN n.hidden=0 THEN n.kind ELSE 'file' END,
      w.depth+CASE WHEN n.parent_id=w.id THEN 1 WHEN n.id=w.parent_id THEN -1 ELSE 0 END,
      n.id IS NOT w.parent_id,w.visited+(n.id IS NOT w.parent_id)
    FROM walk w JOIN nodes n ON n.id=COALESCE(
      CASE WHEN w.entering=1 AND w.kind IN ('root','folder') AND w.depth<64 ${recursive ? "" : "AND w.id=?1"} THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN
        (SELECT c.id FROM nodes c INDEXED BY nodes_children_keyset WHERE c.parent_id=w.parent_id
          AND c.deleted_at IS NULL AND c.space_id=?2 AND c.owner_id=?3
          AND (c.name_ci,c.id)>(w.name_ci,w.id) ORDER BY c.name_ci,c.id LIMIT 1) END,
      CASE WHEN w.id<>?1 THEN w.parent_id END)
      WHERE w.visited<${GALLERY_CANDIDATE_LIMIT} AND n.space_id=?2 AND n.owner_id=?3
        AND n.deleted_at IS NULL
      LIMIT ${GALLERY_CANDIDATE_LIMIT * 2}
  ), scope AS MATERIALIZED (
    SELECT id FROM walk WHERE entering=1 LIMIT ${GALLERY_CANDIDATE_LIMIT}
  )`;
}

function galleryStatement(recursive: boolean) {
  return `${galleryScope(recursive)}
  SELECT n.id,n.name,n.current_blob_id AS currentBlobId,b.mime_sniffed AS mime,b.size,
    m.width,m.height,m.taken_at AS takenAt,n.updated_at AS updatedAt,
    CASE WHEN d.state='ready' AND d.epoch=?6 AND d.size>0 AND d.r2_key IS NOT NULL
      AND d.r2_etag IS NOT NULL THEN 'ready'
      WHEN d.state='failed' THEN 'failed' ELSE 'pending' END AS thumbnail
  FROM scope s JOIN nodes n ON n.id=s.id
  JOIN node_media m ON m.node_id=n.id AND m.blob_id=n.current_blob_id
    AND m.generator_version=?4
  JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
    AND b.state IN ('committed','gc_candidate')
  JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
    AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL
  LEFT JOIN derivative_results d ON d.blob_id=b.id AND d.kind='thumbnail'
    AND d.variant=?5 AND d.generator_version=?7
  WHERE n.hidden=0 AND n.deleted_at IS NULL AND n.kind='file'
    AND b.mime_sniffed IN ('image/jpeg','image/png','image/webp','image/avif')
    AND (?8 IS NULL OR COALESCE(m.taken_at,n.updated_at)<?8
      OR (COALESCE(m.taken_at,n.updated_at)=?8 AND n.id>?9))
  ORDER BY COALESCE(m.taken_at,n.updated_at) DESC,n.id LIMIT 201`;
}

function galleryTruncationStatement(recursive: boolean) {
  return `${galleryScope(recursive)}
    SELECT CASE WHEN COUNT(*)>=${GALLERY_CANDIDATE_LIMIT} THEN 1 ELSE 0 END AS truncated FROM scope`;
}

export async function listGallery(
  db: D1Database,
  principal: Principal,
  rootId: string,
  recursive: boolean,
  tokens: GalleryCursorTokens,
  cursor?: string,
): Promise<GalleryPage> {
  if (principal.kind !== "user" || !/^[A-Za-z0-9_-]{1,128}$/.test(rootId))
    throw new Error("gallery_unavailable");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(rootId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("gallery_unavailable");
  const authorized = await authorizeNode(db, principal, {
    operation: "gallery.read",
    nodeId: rootId,
    spaceId,
  });
  if (
    authorized.operation !== "gallery.read" ||
    (authorized.node.kind !== "root" && authorized.node.kind !== "folder")
  )
    throw new Error("gallery_unavailable");
  let lastSort: number | null = null;
  let lastId: string | null = null;
  if (cursor !== undefined) {
    const claim = await tokens.verify(cursor);
    if (
      claim.rootId !== rootId ||
      claim.spaceId !== spaceId ||
      claim.ownerId !== authorized.node.owner_id ||
      claim.userId !== principal.user_id ||
      claim.credentialId !== principal.credential_id ||
      claim.epoch !== principal.epoch ||
      claim.generation !== authorized.node.tree_generation ||
      claim.recursive !== recursive
    )
      throw new Error("invalid_gallery_cursor");
    lastSort = claim.lastSort;
    lastId = claim.lastId;
  }
  const results = await atomicBatch(db, [
    authorizationAssertion(authorized),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    {
      sql: galleryTruncationStatement(recursive),
      values: [rootId, spaceId, authorized.node.owner_id],
    },
    {
      sql: galleryStatement(recursive),
      values: [
        rootId,
        spaceId,
        authorized.node.owner_id,
        IMAGE_METADATA_GENERATOR,
        IMAGE_THUMBNAIL_VARIANT,
        principal.epoch,
        IMAGE_THUMBNAIL_GENERATOR,
        lastSort,
        lastId,
      ],
    },
  ]);
  const rows = results.at(-1)?.results as (GalleryItem & { takenAt: number | null })[] | undefined;
  const truncationRows = results.at(-2)?.results as { truncated: number }[] | undefined;
  if (!rows) throw new Error("gallery_unavailable");
  const items = rows.slice(0, 200);
  const last = items.at(-1);
  return {
    rootId,
    treeGeneration: authorized.node.tree_generation,
    recursive,
    items,
    nextCursor:
      rows.length > 200 && last
        ? await tokens.issue({
            rootId,
            spaceId,
            ownerId: authorized.node.owner_id,
            userId: principal.user_id,
            credentialId: principal.credential_id,
            epoch: principal.epoch,
            generation: authorized.node.tree_generation,
            recursive,
            lastSort: last.takenAt ?? last.updatedAt,
            lastId: last.id,
          })
        : null,
    truncated: truncationRows?.[0]?.truncated === 1,
    candidateLimit: GALLERY_CANDIDATE_LIMIT,
  };
}
