import { assertExists, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  EPUB_INDEX_GENERATOR,
  type EpubInspection,
  inspectEpubObject,
  verifyEpubIndexHash,
} from "../media/epub/index";

interface EpubSource {
  readonly nodeId: string;
  readonly spaceId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly revision: number;
  readonly blobId: string;
  readonly r2Key: string;
  readonly size: number;
  readonly r2Etag: string;
}

export type EpubProjection = {
  readonly source: EpubSource;
  readonly inspection: Exclude<EpubInspection, { readonly kind: "transient" }>;
  readonly publication?: {
    readonly key: string;
    readonly etag: string;
  };
} | null;

interface EpubEvent {
  readonly kind: string;
  readonly op_kind: string;
  readonly payload_ref: string;
  readonly space_id: string;
  readonly owner_id: string;
}

function isProjectionEvent(row: EpubEvent): boolean {
  return (
    row.kind === "node.updated" ||
    (row.kind === "node.created" &&
      ["dav.put", "upload.complete", "node.copy", "dav.copy"].includes(row.op_kind))
  );
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

async function source(db: D1Database, row: EpubEvent): Promise<EpubSource | null> {
  if (!isProjectionEvent(row)) return null;
  const selected = await db
    .prepare(`SELECT n.id AS nodeId,n.space_id AS spaceId,n.owner_id AS ownerId,n.name,n.revision,
      b.id AS blobId,b.r2_key AS r2Key,b.size,bs.r2_etag AS r2Etag
      FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
      JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
      WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND n.kind='file'
        AND n.deleted_at IS NULL AND lower(n.name) LIKE '%.epub'
        AND b.state IN ('committed','gc_candidate') AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
        AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM blob_encryption be WHERE be.blob_id=b.id)`)
    .bind(row.payload_ref, row.space_id, row.owner_id)
    .first<EpubSource>();
  return selected ? Object.freeze(selected) : null;
}

async function publish(
  bucket: R2Bucket,
  selected: EpubSource,
  inspection: Extract<EpubInspection, { readonly kind: "indexed" }>,
  deadline: number,
): Promise<{ readonly key: string; readonly etag: string }> {
  if (
    !safeSegment(selected.ownerId) ||
    !safeSegment(selected.nodeId) ||
    !safeSegment(selected.blobId) ||
    Date.now() >= deadline
  )
    throw new Error("invalid_epub_publication");
  const key = `u/${selected.ownerId}/d/${selected.blobId}/${EPUB_INDEX_GENERATOR}/index/${selected.nodeId}-${inspection.sha256}.json`;
  let object = await bucket.head(key);
  if (!object) {
    try {
      object = await bucket.put(key, inspection.bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      object = await bucket.head(key);
    }
  }
  if (
    !object ||
    object.size !== inspection.bytes.byteLength ||
    !object.etag ||
    Date.now() >= deadline
  )
    throw new Error("epub_publication_failed");
  const stored = await bucket.get(key);
  if (!stored || stored.size !== inspection.bytes.byteLength || Date.now() >= deadline)
    throw new Error("epub_publication_failed");
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (Date.now() >= deadline || bytes.byteLength !== inspection.bytes.byteLength)
    throw new Error("epub_publication_failed");
  await verifyEpubIndexHash(bytes, inspection.sha256);
  return Object.freeze({ key, etag: object.etag });
}

export async function prepareEpubProjection(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "BLOBS">>,
  row: EpubEvent,
  deadline: number,
): Promise<EpubProjection | "retry"> {
  const selected = await source(env.DB, row);
  if (!selected) return null;
  if (!env.BLOBS || Date.now() >= deadline) return "retry";
  const inspection = await inspectEpubObject(
    env.BLOBS,
    { key: selected.r2Key, size: selected.size, r2Etag: selected.r2Etag },
    deadline,
  );
  if (inspection.kind === "transient") return "retry";
  if (inspection.kind !== "indexed") return Object.freeze({ source: selected, inspection });
  try {
    return Object.freeze({
      source: selected,
      inspection,
      publication: await publish(env.BLOBS, selected, inspection, deadline),
    });
  } catch {
    return "retry";
  }
}

function sourceFence(selected: EpubSource): SqlStatement {
  return assertExists(
    `SELECT 1 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
      JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
      WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND n.name=? AND n.revision=?
        AND n.kind='file' AND n.deleted_at IS NULL AND n.current_blob_id=?
        AND b.r2_key=? AND b.size=? AND b.state IN ('committed','gc_candidate')
        AND bs.bytes=b.size AND bs.r2_etag=?
        AND NOT EXISTS(SELECT 1 FROM blob_encryption be WHERE be.blob_id=b.id)`,
    [
      selected.nodeId,
      selected.spaceId,
      selected.ownerId,
      selected.name,
      selected.revision,
      selected.blobId,
      selected.r2Key,
      selected.size,
      selected.r2Etag,
    ],
  );
}

export function epubCompletionStatements(projection: EpubProjection): readonly SqlStatement[] {
  if (!projection) return [];
  const { source: selected, inspection } = projection;
  if (inspection.kind !== "indexed") {
    return [
      sourceFence(selected),
      { sql: "DELETE FROM library_items WHERE node_id=?", values: [selected.nodeId] },
      { sql: "DELETE FROM archive_index WHERE node_id=?", values: [selected.nodeId] },
    ];
  }
  if (!projection.publication) throw new Error("invalid_epub_projection");
  return [
    sourceFence(selected),
    {
      sql: `INSERT INTO library_items(
        node_id,blob_id,kind,generator_version,title_extracted,author_extracted,series_extracted,page_count
      ) VALUES(?,?,'epub',?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET
        blob_id=excluded.blob_id,kind=excluded.kind,generator_version=excluded.generator_version,
        title_extracted=excluded.title_extracted,author_extracted=excluded.author_extracted,
        series_extracted=excluded.series_extracted,page_count=excluded.page_count`,
      values: [
        selected.nodeId,
        selected.blobId,
        EPUB_INDEX_GENERATOR,
        inspection.index.metadata.title,
        inspection.index.metadata.author,
        inspection.index.metadata.series,
        inspection.index.spine.length,
      ],
    },
    {
      sql: `INSERT INTO archive_index(
        id,node_id,blob_id,generator_version,r2_key,sha256,entry_count,json_bytes
      ) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(node_id,blob_id,generator_version) DO UPDATE SET
        r2_key=excluded.r2_key,sha256=excluded.sha256,
        entry_count=excluded.entry_count,json_bytes=excluded.json_bytes`,
      values: [
        crypto.randomUUID(),
        selected.nodeId,
        selected.blobId,
        EPUB_INDEX_GENERATOR,
        projection.publication.key,
        inspection.sha256,
        inspection.index.entries.length,
        inspection.bytes.byteLength,
      ],
    },
    {
      sql: `DELETE FROM archive_index
        WHERE node_id=? AND NOT (blob_id=? AND generator_version=?)`,
      values: [selected.nodeId, selected.blobId, EPUB_INDEX_GENERATOR],
    },
  ];
}
