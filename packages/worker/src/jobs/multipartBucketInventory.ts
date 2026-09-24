import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { R2S3Inventory } from "../r2/s3Inventory";
import type { MultipartInventoryPage } from "../r2/s3InventoryPages";
import { type VerifiedR2Inventory, withVerifiedR2Inventory } from "./r2BindingVerification";

const CLOCK = "strftime('%s','now')*1000";
interface Scan {
  source: string;
  epoch: number;
  round_id: string;
  cursor_key: string | null;
  cursor_upload_id: string | null;
  pages: number;
  completed_at: number | null;
}
interface Handle {
  id: string;
  source: string;
  r2_key: string;
  r2_upload_id: string;
  state: "tracked" | "quarantined";
  held_bytes: number;
  part_epoch: number | null;
  part_round_id: string | null;
  part_marker: number;
  part_pages: number;
  parts_completed_at: number | null;
}
export interface MultipartBucketScanResult {
  examined: number;
  completed: boolean;
  /** Operator handles are bounded by the requested page size. No R2 upload IDs escape here. */
  handles: { id: string; state: "tracked" | "quarantined" }[];
}
export interface MultipartPartObservationResult {
  observed: number;
  heldBytes: number;
  completed: boolean;
}

function limits(epoch: number, limit: number) {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("invalid_multipart_bucket_limit");
}
const scanRow = (db: D1Database) =>
  primary(db).prepare("SELECT * FROM multipart_bucket_scan WHERE singleton=1").first<Scan>();
const handleRow = (db: D1Database, id: string) =>
  primary(db).prepare("SELECT * FROM multipart_bucket_handles WHERE id=?").bind(id).first<Handle>();

function scanFence(row: Scan): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_bucket_scan WHERE singleton=1 AND source=? AND epoch=? AND round_id=?
      AND cursor_key IS ? AND cursor_upload_id IS ? AND pages=? AND completed_at IS ?`,
    [
      row.source,
      row.epoch,
      row.round_id,
      row.cursor_key,
      row.cursor_upload_id,
      row.pages,
      row.completed_at,
    ],
  );
}
function partFence(row: Handle): SqlStatement {
  return assertExists(
    `SELECT 1 FROM multipart_bucket_handles WHERE id=? AND source=? AND r2_key=? AND r2_upload_id=?
      AND state='quarantined' AND part_epoch IS ? AND part_round_id IS ? AND part_marker=?
      AND part_pages=? AND parts_completed_at IS ?`,
    [
      row.id,
      row.source,
      row.r2_key,
      row.r2_upload_id,
      row.part_epoch,
      row.part_round_id,
      row.part_marker,
      row.part_pages,
      row.parts_completed_at,
    ],
  );
}

function observation(
  source: string,
  epoch: number,
  round: string,
  upload: MultipartInventoryPage["uploads"][number],
): SqlStatement {
  const parsed = /^u\/([^/]{1,128})\/b\/([^/]{1,128})$/.exec(upload.key);
  const owner = parsed?.[1] ?? null;
  const blob = parsed?.[2] ?? null;
  return {
    sql: `INSERT INTO multipart_bucket_handles(id,source,r2_key,r2_upload_id,initiated_at,
      owner_key,blob_key,owner_id,state,first_seen_at,last_seen_at,epoch,last_round_id)
      VALUES(?,?,?,?,?,?,?,(SELECT id FROM users WHERE id=?),
      CASE WHEN EXISTS(SELECT 1 FROM uploads u JOIN blobs b ON b.id=u.blob_id
        WHERE b.r2_key=? AND u.r2_upload_id=?) THEN 'tracked' ELSE 'quarantined' END,
      ${CLOCK},${CLOCK},?,?)
      ON CONFLICT(source,r2_key,r2_upload_id) DO UPDATE SET
        owner_id=COALESCE(multipart_bucket_handles.owner_id,excluded.owner_id),
        state=CASE WHEN multipart_bucket_handles.state='quarantined' THEN 'quarantined' ELSE excluded.state END,
        last_seen_at=MAX(multipart_bucket_handles.last_seen_at,excluded.last_seen_at),
        epoch=excluded.epoch,last_round_id=excluded.last_round_id
      WHERE multipart_bucket_handles.initiated_at=excluded.initiated_at
        AND multipart_bucket_handles.last_round_id<>excluded.last_round_id`,
    values: [
      crypto.randomUUID(),
      source,
      upload.key,
      upload.uploadId,
      upload.initiatedAt,
      owner,
      blob,
      owner,
      upload.key,
      upload.uploadId,
      epoch,
      round,
    ],
  };
}

/** One verified u/ listing page. An empty page is never a closure certificate. */
export async function scanMultipartBucket(
  db: D1Database,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  limit = 20,
): Promise<MultipartBucketScanResult> {
  limits(epoch, limit);
  return withVerifiedR2Inventory(db, bucket, inventory, epoch, (verified) =>
    scanPage(db, verified, epoch, limit),
  );
}

async function scanPage(
  db: D1Database,
  verified: VerifiedR2Inventory,
  epoch: number,
  limit: number,
): Promise<MultipartBucketScanResult> {
  const source = JSON.stringify(verified.observation.source);
  let row = await scanRow(db);
  if (!row) {
    await atomicBatch(db, [
      verified.fence(),
      {
        sql: "INSERT INTO multipart_bucket_scan(singleton,source,epoch,round_id) VALUES(1,?,?,?)",
        values: [source, epoch, crypto.randomUUID()],
      },
      assertOneChange,
    ]);
  } else if (row.source !== source || row.epoch !== epoch || row.completed_at !== null) {
    await atomicBatch(db, [
      verified.fence(),
      scanFence(row),
      {
        sql: `UPDATE multipart_bucket_scan SET source=?,epoch=?,round_id=?,cursor_key=NULL,cursor_upload_id=NULL,
        pages=0,completed_at=NULL WHERE singleton=1`,
        values: [source, epoch, crypto.randomUUID()],
      },
      assertOneChange,
    ]);
  }
  row = (await scanRow(db))!;
  // Unknown counter acknowledgement stops this invocation before S3 dispatch.
  await atomicBatch(db, [
    verified.fence(),
    scanFence(row),
    {
      sql: "UPDATE multipart_bucket_scan SET calls=calls+1 WHERE singleton=1",
    },
    assertOneChange,
  ]);
  const page = await verified.inventory.listMultipartUploads({
    prefix: "u/",
    limit,
    marker:
      row.cursor_key === null ? null : { key: row.cursor_key, uploadId: row.cursor_upload_id! },
  });
  const statements: SqlStatement[] = [verified.fence(), scanFence(row)];
  for (const upload of page.uploads) {
    statements.push(observation(source, epoch, row.round_id, upload), assertOneChange);
  }
  statements.push(
    {
      sql: `UPDATE multipart_bucket_scan SET cursor_key=?,cursor_upload_id=?,pages=pages+1,
      completed_at=CASE WHEN ?=1 THEN ${CLOCK} ELSE NULL END WHERE singleton=1`,
      values: [page.next?.key ?? null, page.next?.uploadId ?? null, page.next === null ? 1 : 0],
    },
    assertOneChange,
  );
  // Each SELECT is inside the same atomic page as discovery and classification.
  const resultStart = statements.length;
  for (const upload of page.uploads)
    statements.push({
      sql: "SELECT id,state FROM multipart_bucket_handles WHERE source=? AND r2_key=? AND r2_upload_id=?",
      values: [source, upload.key, upload.uploadId],
    });
  const saved = await atomicBatch(db, statements);
  return {
    examined: page.uploads.length,
    completed: page.next === null,
    handles: saved
      .slice(resultStart)
      .map((result) => result.results[0] as MultipartBucketScanResult["handles"][number]),
  };
}

/** Observe one part page; high-water holds survive missing/shrinking parts and lost replies. */
export async function observeMultipartBucketParts(
  db: D1Database,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  handleId: string,
  limit = 20,
): Promise<MultipartPartObservationResult> {
  limits(epoch, limit);
  if (typeof handleId !== "string" || !/^[a-f\d-]{36}$/.test(handleId))
    throw new Error("invalid_multipart_bucket_handle");
  return withVerifiedR2Inventory(db, bucket, inventory, epoch, (verified) =>
    observeParts(db, verified, epoch, handleId, limit),
  );
}

async function observeParts(
  db: D1Database,
  verified: VerifiedR2Inventory,
  epoch: number,
  id: string,
  limit: number,
): Promise<MultipartPartObservationResult> {
  let row = await handleRow(db, id);
  if (
    !row ||
    row.state !== "quarantined" ||
    row.source !== JSON.stringify(verified.observation.source)
  )
    throw new Error("multipart_bucket_handle_unavailable");
  if (row.part_epoch !== epoch || row.parts_completed_at !== null) {
    await atomicBatch(db, [
      verified.fence(),
      partFence(row),
      {
        sql: `UPDATE multipart_bucket_handles SET part_epoch=?,part_round_id=?,part_marker=0,
        part_pages=0,parts_completed_at=NULL WHERE id=?`,
        values: [epoch, crypto.randomUUID(), id],
      },
      assertOneChange,
    ]);
  }
  row = (await handleRow(db, id))!;
  await atomicBatch(db, [
    verified.fence(),
    partFence(row),
    {
      sql: "UPDATE multipart_bucket_handles SET part_calls=part_calls+1 WHERE id=?",
      values: [id],
    },
    assertOneChange,
  ]);
  const page = await verified.inventory.listParts({
    key: row.r2_key,
    uploadId: row.r2_upload_id,
    marker: row.part_marker,
    limit,
  });
  const statements: SqlStatement[] = [verified.fence(), partFence(row)];
  for (const part of page.parts)
    statements.push(
      {
        sql: `INSERT INTO multipart_bucket_parts(id,handle_id,part_number,bytes,observed_bytes,etag,modified_at,last_seen_at,last_round_id)
      VALUES(?,?,?,?,?,?,?,${CLOCK},?) ON CONFLICT(handle_id,part_number) DO UPDATE SET
      bytes=MAX(multipart_bucket_parts.bytes,excluded.bytes),observed_bytes=excluded.observed_bytes,
      etag=excluded.etag,modified_at=excluded.modified_at,last_seen_at=MAX(multipart_bucket_parts.last_seen_at,excluded.last_seen_at),
      last_round_id=excluded.last_round_id`,
        values: [
          crypto.randomUUID(),
          id,
          part.partNumber,
          part.bytes,
          part.bytes,
          part.etag,
          part.modifiedAt,
          row.part_round_id,
        ],
      },
      assertOneChange,
    );
  statements.push(
    {
      sql: `UPDATE multipart_bucket_handles SET part_marker=?,part_pages=part_pages+1,
      parts_completed_at=CASE WHEN ?=1 THEN ${CLOCK} ELSE NULL END WHERE id=?`,
      values: [
        page.next ?? page.parts.at(-1)?.partNumber ?? row.part_marker,
        page.next === null ? 1 : 0,
        id,
      ],
    },
    assertOneChange,
    {
      sql: "SELECT held_bytes FROM multipart_bucket_handles WHERE id=?",
      values: [id],
    },
  );
  const saved = await atomicBatch(db, statements);
  return {
    observed: page.parts.length,
    heldBytes: (saved.at(-1)!.results[0] as { held_bytes: number }).held_bytes,
    completed: page.next === null,
  };
}
