import type { ArchiveBook } from "../../../shared/src/library";
import { type AuthorizedNode, authorizationAssertion } from "../auth/authorize";
import { assertExists, atomicBatch, type SqlStatement } from "../db/primary";
import {
  ARCHIVE_GENERATOR,
  type ArchiveOriginal,
  decodeArchiveIndex,
} from "../media/archive/codec";
import { ARCHIVE_LIMITS } from "../media/archive/format";
import { archiveObjectSource } from "../media/archive/r2Source";
import type { PageTarget } from "./pageManifest";

/** Complete storage proof, including EPUB containers that do not yet have a reader. */
export const ARCHIVE_INDEX_SOURCE = `FROM nodes n JOIN blobs original ON original.id=n.current_blob_id AND original.owner_id=n.owner_id
  JOIN blob_storage os ON os.blob_id=original.id
  JOIN library_items l ON l.node_id=n.id AND l.blob_id=original.id
  JOIN archive_index ai ON ai.node_id=n.id AND ai.blob_id=original.id AND ai.generator_version=l.generator_version
  JOIN archive_derivative_objects x ON x.source_blob_id=original.id AND x.owner_id=n.owner_id AND x.generator_version=ai.generator_version
  JOIN derivative_results d ON d.id=x.result_id AND d.blob_id=original.id
  JOIN blobs b ON b.id=x.output_blob_id AND b.owner_id=n.owner_id
  JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins p ON p.pin_id=x.pin_id AND p.blob_id=b.id
  JOIN archive_derivative_cleanup c ON c.archive_id=x.id
  WHERE ((n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL)
    AND (original.state IN ('committed','gc_candidate') AND os.removed_at IS NULL)
    AND (os.bytes=original.size AND os.r2_etag IS NOT NULL)
    AND (original.r2_key='u/'||n.owner_id||'/b/'||original.id)
    AND (original.r2_key=json_extract(x.source_json,'$.key') AND original.size=json_extract(x.source_json,'$.size'))
    AND (os.r2_etag=json_extract(x.source_json,'$.etag'))
    AND (l.kind IN ('zip','cbz','epub') AND l.generator_version='${ARCHIVE_GENERATOR}'))
    AND ((d.kind='archive_index' AND d.variant='index' AND d.generator_version=x.generator_version)
    AND (d.state='ready' AND x.state='published' AND b.state='committed' AND b.ref_count=1)
    AND (b.id='archive_'||x.id AND d.id=b.id AND d.size=b.size AND d.r2_key=b.r2_key)
    AND (b.r2_key='u/'||n.owner_id||'/d/'||original.id||'/${ARCHIVE_GENERATOR}/index/'||x.id)
    AND (b.mime_sniffed='application/json' AND s.bytes=b.size AND s.removed_at IS NULL AND s.r2_etag=b.r2_etag)
    AND (b.sha256_verified=json_extract(x.output_json,'$.sha256') AND b.size=json_extract(x.output_json,'$.bytes'))
    AND (ai.r2_key=b.r2_key AND ai.sha256=b.sha256_verified AND ai.json_bytes=b.size))
    AND ((ai.entry_count=json_extract(x.output_json,'$.entryCount'))
    AND (l.page_count IS CASE WHEN l.kind='epub' THEN NULL ELSE json_extract(x.output_json,'$.pageCount') END)
    AND (p.purpose='job' AND p.expires_at IS NULL AND c.retired_at IS NULL AND c.seal_token IS NULL AND c.settled_at IS NULL)
    AND EXISTS(SELECT 1 FROM r2_write_attempts w WHERE w.kind='archive.put' AND w.state='succeeded'
      AND w.epoch=x.epoch AND w.owner_id=x.owner_id AND w.r2_key=b.r2_key AND w.source_ref=json_array(x.id,x.write_attempt_id))
    AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=b.r2_key AND state='pending'))`;
export const ARCHIVE_BOOK_SOURCE = `${ARCHIVE_INDEX_SOURCE}
    AND (l.kind IN ('zip','cbz') AND l.page_count BETWEEN 1 AND ${ARCHIVE_LIMITS.entries})`;
const SOURCE = `${ARCHIVE_BOOK_SOURCE} AND (n.id=? AND n.space_id=? AND n.revision=? AND n.current_blob_id=?)`;
const FENCE = `SELECT 1 ${SOURCE} AND (x.id=? AND b.sha256_verified=? AND b.size=? AND s.r2_etag=?
  AND original.size=? AND os.r2_etag=? AND l.page_count=?)`;

/** Published output receipts survive an epoch transition; current reader authority never does. */
export async function prepareAuthorizedArchiveRead(
  db: D1Database,
  authorized: AuthorizedNode,
  extra: readonly SqlStatement[] = [],
  expected?: PageTarget,
) {
  if (
    authorized.operation !== "library.read" ||
    authorized.node.kind !== "file" ||
    !authorized.node.current_blob_id
  )
    throw new Error("content_not_available");
  const n = authorized.node,
    principal = authorized.principal;
  if (
    (principal.kind === "user" || principal.kind === "app_password") &&
    n.owner_id !== principal.user_id &&
    !principal.selected_share
  )
    throw new Error("content_not_available");
  const values = [n.id, n.space_id, n.revision, n.current_blob_id];
  const results = await atomicBatch(db, [
    authorizationAssertion(authorized),
    ...extra,
    {
      sql: `SELECT COALESCE(l.title_override,l.title_extracted,n.name) AS title,x.id AS archiveId,b.r2_key AS key,b.size,s.r2_etag AS etag,b.sha256_verified AS sha256,
      original.r2_key AS originalKey,original.size AS originalSize,os.r2_etag AS originalEtag,
      ai.entry_count AS entryCount,l.page_count AS pageCount ${SOURCE}`,
      values,
    },
  ]);
  const row = results[extra.length + 1]?.results[0] as
    | {
        title: string;
        archiveId: string;
        key: string;
        size: number;
        etag: string;
        sha256: string;
        originalKey: string;
        originalSize: number;
        originalEtag: string;
        entryCount: number;
        pageCount: number;
      }
    | undefined;
  if (!row) throw new Error(expected ? "content_not_available" : "archive_not_ready");
  if (
    expected &&
    (expected.spaceId !== n.space_id ||
      expected.nodeId !== n.id ||
      expected.blobId !== n.current_blob_id ||
      expected.archiveId !== row.archiveId ||
      expected.indexHash !== row.sha256 ||
      expected.indexBytes !== row.size ||
      expected.pageCount !== row.pageCount ||
      expected.generator !== ARCHIVE_GENERATOR ||
      expected.purpose !== "page")
  )
    throw new Error("content_not_available");
  const guard = assertExists(FENCE, [
    ...values,
    row.archiveId,
    row.sha256,
    row.size,
    row.etag,
    row.originalSize,
    row.originalEtag,
    row.pageCount,
  ]);
  const authorize = async () => {
    await atomicBatch(db, [authorizationAssertion(authorized), ...extra, guard]);
  };
  const original: ArchiveOriginal = {
    ownerId: n.owner_id,
    blobId: n.current_blob_id!,
    key: row.originalKey,
    size: row.originalSize,
    etag: row.originalEtag,
  };
  const load = async (bucket: R2Bucket, signal: AbortSignal) => {
    if (row.size < 22 || row.size > ARCHIVE_LIMITS.indexBytes)
      throw new Error("invalid_archive_index");
    const source = archiveObjectSource(bucket, row, signal, authorize, {
      reads: 0,
      bytes: 0,
      maxReads: 1,
      maxBytes: ARCHIVE_LIMITS.indexBytes,
    });
    const index = await decodeArchiveIndex(await source.read(0, row.size), original, row.sha256);
    const pageBytes = index.pages.map((ordinal) => index.entries[ordinal]!.size);
    const size = pageBytes.reduce((sum, n) => sum + n, 0);
    if (
      index.entries.length !== row.entryCount ||
      index.pages.length !== row.pageCount ||
      (expected &&
        (expected.size !== size || expected.pageBytes.some((n, i) => n !== pageBytes[i])))
    )
      throw new Error("invalid_archive_index");
    await authorize();
    const target: PageTarget = Object.freeze({
      spaceId: n.space_id,
      nodeId: n.id,
      blobId: n.current_blob_id!,
      purpose: "page",
      size,
      archiveId: row.archiveId,
      generator: ARCHIVE_GENERATOR,
      indexHash: row.sha256,
      indexBytes: row.size,
      pageCount: row.pageCount,
      pageBytes: Object.freeze(pageBytes),
    });
    return { index, target };
  };
  return {
    original,
    guard,
    authorize,
    load,
    book: {
      nodeId: n.id,
      spaceId: n.space_id,
      blobId: n.current_blob_id!,
      title: row.title,
      pageCount: row.pageCount,
      generator: ARCHIVE_GENERATOR,
      indexHash: row.sha256,
    } satisfies Omit<ArchiveBook, "reading">,
  };
}
