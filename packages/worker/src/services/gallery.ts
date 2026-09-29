import type { GalleryItem, GalleryPage } from "../../../shared/src/gallery";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import type { GalleryCursorTokens } from "../auth/galleryCursor";
import { assertExists, atomicBatch, primary } from "../db/primary";
import { IMAGE_METADATA_GENERATOR } from "../media/images/inspect";
import { IMAGE_TRANSFORM_GENERATOR } from "../media/images/transform";

// The 50,000 candidate gate must pass before raising the production scan limit.
export const GALLERY_CANDIDATES = 10_000;

/** Indexed successor traversal bounds work even when one folder has millions of children. */
export function galleryStatement(recursive: boolean, limit = GALLERY_CANDIDATES) {
  if (![10000, 50000].includes(limit)) throw new Error("invalid_gallery_limit");
  return `WITH RECURSIVE ancestors(id,parent_id,depth) AS (
    SELECT id,parent_id,0 FROM nodes WHERE id=?1
    UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM ancestors a JOIN nodes n ON n.id=a.parent_id
      WHERE a.depth<64 AND n.space_id=?2 AND n.owner_id=?3 LIMIT 65
  ), walk(id,parent_id,name_ci,kind,depth,entering,visited) AS MATERIALIZED (
    SELECT id,parent_id,name_ci,kind,(SELECT MAX(depth) FROM ancestors),1,1 FROM nodes
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
      WHERE w.visited<${limit} AND n.space_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL
      LIMIT ${limit * 2}
  ), scope AS MATERIALIZED (
    SELECT id FROM walk WHERE entering=1 LIMIT ${limit}
  ), page AS MATERIALIZED (
    SELECT n.id,n.name,n.current_blob_id AS currentBlobId,n.revision,n.updated_at AS updatedAt,
      b.size,b.mime_sniffed AS mime,m.width,m.height,m.taken_at AS takenAt,m.orientation,
      m.camera_make AS cameraMake,m.camera_model AS cameraModel,
      COALESCE(m.taken_at,n.updated_at) AS sortTime
    FROM scope s CROSS JOIN nodes n ON n.id=s.id
    JOIN node_media m ON m.node_id=n.id AND m.blob_id=n.current_blob_id AND m.generator_version=?4
    JOIN blobs b ON b.id=m.blob_id AND b.owner_id=?3 AND b.state IN ('committed','gc_candidate')
    WHERE n.hidden=0 AND n.kind='file' AND m.width>0 AND m.height>0
      AND b.mime_sniffed IN ('image/jpeg','image/png','image/webp','image/avif')
      AND (?6 IS NULL OR COALESCE(m.taken_at,n.updated_at)<?6 OR (COALESCE(m.taken_at,n.updated_at)=?6 AND n.id>?7))
    ORDER BY sortTime DESC,n.id LIMIT 201
  ) SELECT (SELECT COUNT(*) FROM scope) AS scanned,
    (SELECT json_group_array(json_object('id',p.id,'name',p.name,'currentBlobId',p.currentBlobId,
      'revision',p.revision,'updatedAt',p.updatedAt,'size',p.size,'mime',p.mime,'width',p.width,'height',p.height,
      'takenAt',p.takenAt,'orientation',p.orientation,'cameraMake',p.cameraMake,'cameraModel',p.cameraModel,'sortTime',p.sortTime,
      'thumbnail',CASE WHEN d.state='failed' THEN CASE WHEN d.error_code GLOB 'image_unsupported_*' THEN 'unsupported' ELSE 'failed' END
        WHEN d.state='ready' AND x.state='published' AND c.retired_at IS NULL AND c.seal_token IS NULL
          AND c.settled_at IS NULL AND c.image_id IS NOT NULL THEN 'ready' ELSE 'pending' END))
      FROM page p LEFT JOIN derivative_results d ON d.blob_id=p.currentBlobId AND d.kind='thumbnail' AND d.variant='sm' AND d.generator_version=?5
      LEFT JOIN image_derivative_objects x ON x.result_id=d.id
      LEFT JOIN image_derivative_cleanup c ON c.image_id=x.id) AS items`;
}

export async function listGallery(
  db: D1Database,
  principal: Principal,
  rootId: string,
  recursive: boolean,
  tokens: GalleryCursorTokens,
  cursor?: string,
): Promise<GalleryPage> {
  if (!["user", "link_share"].includes(principal.kind) || !/^[A-Za-z0-9_-]{1,128}$/.test(rootId))
    throw new Error("gallery_unavailable");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(rootId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("gallery_unavailable");
  const proof = await authorizeNode(db, principal, {
    operation: "gallery.read",
    nodeId: rootId,
    spaceId,
  });
  if (proof.operation !== "gallery.read") throw new Error("gallery_unavailable");
  const root = proof.node;
  const selected =
    principal.kind === "link_share"
      ? { id: principal.share_id, version: principal.share_version }
      : principal.kind === "user"
        ? principal.selected_share
        : undefined;
  const userId = principal.kind === "link_share" ? null : principal.user_id;
  if (!selected && root.owner_id !== userId) throw new Error("gallery_unavailable");
  let lastSort: number | null = null,
    lastId: string | null = null;
  if (cursor !== undefined) {
    const claim = await tokens.verify(cursor);
    if (
      claim.parentId !== rootId ||
      claim.spaceId !== spaceId ||
      claim.ownerId !== root.owner_id ||
      claim.userId !== userId ||
      claim.credentialId !== principal.credential_id ||
      claim.epoch !== principal.epoch ||
      claim.generation !== root.tree_generation ||
      claim.generator !== IMAGE_METADATA_GENERATOR ||
      claim.recursive !== recursive ||
      claim.limit !== GALLERY_CANDIDATES ||
      claim.shareId !== selected?.id ||
      claim.shareVersion !== selected?.version
    )
      throw new Error("invalid_gallery_cursor");
    lastSort = claim.lastSort;
    lastId = claim.lastId;
  }
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
      principal.epoch,
    ]),
    {
      sql: galleryStatement(recursive),
      values: [
        rootId,
        spaceId,
        root.owner_id,
        IMAGE_METADATA_GENERATOR,
        IMAGE_TRANSFORM_GENERATOR,
        lastSort,
        lastId,
      ],
    },
  ]);
  const record = result.at(-1)?.results[0] as { scanned: number; items: string } | undefined;
  if (!record) throw new Error("gallery_unavailable");
  const rows = JSON.parse(record.items) as (GalleryItem & { sortTime: number })[],
    page = rows.slice(0, 200),
    last = page.at(-1);
  const nextCursor =
    rows.length > 200 && last
      ? await tokens.issue({
          parentId: rootId,
          spaceId,
          ownerId: root.owner_id,
          userId,
          credentialId: principal.credential_id,
          epoch: principal.epoch,
          generation: root.tree_generation,
          generator: IMAGE_METADATA_GENERATOR,
          recursive,
          limit: GALLERY_CANDIDATES,
          lastSort: last.sortTime,
          lastId: last.id,
          ...(selected ? { shareId: selected.id, shareVersion: selected.version } : {}),
        })
      : null;
  return {
    rootId,
    treeGeneration: root.tree_generation,
    recursive,
    items: page.map(({ sortTime: _sort, ...item }) => item),
    nextCursor,
    truncated: record.scanned >= GALLERY_CANDIDATES,
    scannedNodes: record.scanned,
    candidateLimit: GALLERY_CANDIDATES,
  };
}
