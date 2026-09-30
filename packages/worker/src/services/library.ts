import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import type { ContentTokens } from "../auth/contentTokens";
import { atomicBatch, primary } from "../db/primary";
import type { BudgetDO } from "../do/BudgetDO";
import {
  EPUB_INDEX_GENERATOR,
  type EpubIndex,
  parseEpubIndex,
  verifyEpubIndexHash,
} from "../media/epub/index";
import {
  isZipTransient,
  readZipEntry,
  validateZipEntry,
  type ZipEntry,
  ZipFormatError,
  type ZipObjectSource,
} from "../media/epub/zip";
import { parseRange } from "../platform/range";
import { type BlobReadPlan, prepareCookieBlobRead } from "./blobRead";
import { streamLeasedContent } from "./contentStream";

interface IndexRow {
  readonly ownerId: string;
  readonly blobId: string;
  readonly sourceKey: string;
  readonly sourceSize: number;
  readonly sourceR2Etag: string;
  readonly indexKey: string;
  readonly indexSha256: string;
  readonly indexBytes: number;
  readonly entryCount: number;
  readonly titleExtracted: string | null;
  readonly authorExtracted: string | null;
  readonly seriesExtracted: string | null;
  readonly titleOverride: string | null;
  readonly authorOverride: string | null;
  readonly seriesOverride: string | null;
  readonly pageCount: number;
}

export interface PrivateEpub {
  readonly nodeId: string;
  readonly blobId: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly series: string | null;
  readonly pageCount: number;
  readonly coverToken: string | null;
  readonly spine: readonly string[];
  readonly entries: readonly {
    token: string;
    path: string;
    mime: string;
    size: number;
  }[];
}

function expectedIndexKey(row: IndexRow, nodeId: string): string {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.ownerId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.blobId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId) ||
    !/^[0-9a-f]{64}$/.test(row.indexSha256)
  )
    throw new Error("library_not_available");
  return `u/${row.ownerId}/d/${row.blobId}/${EPUB_INDEX_GENERATOR}/index/${nodeId}-${row.indexSha256}.json`;
}

async function loadIndex(bucket: R2Bucket, nodeId: string, row: IndexRow): Promise<EpubIndex> {
  if (
    row.indexKey !== expectedIndexKey(row, nodeId) ||
    !Number.isSafeInteger(row.indexBytes) ||
    row.indexBytes < 1 ||
    row.indexBytes > 8_388_608 ||
    !Number.isSafeInteger(row.entryCount) ||
    row.entryCount < 1 ||
    row.entryCount > 1_000
  )
    throw new Error("library_not_available");
  const object = await bucket.get(row.indexKey);
  if (!object || object.size !== row.indexBytes) throw new Error("library_not_available");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== row.indexBytes) throw new Error("library_not_available");
  await verifyEpubIndexHash(bytes, row.indexSha256);
  const index = parseEpubIndex(bytes, {
    key: row.sourceKey,
    size: row.sourceSize,
    r2Etag: row.sourceR2Etag,
  });
  if (
    index.entries.length !== row.entryCount ||
    index.spine.length !== row.pageCount ||
    index.metadata.title !== row.titleExtracted ||
    index.metadata.author !== row.authorExtracted ||
    index.metadata.series !== row.seriesExtracted
  )
    throw new Error("library_not_available");
  return index;
}

const INDEX_SELECT = `SELECT n.owner_id AS ownerId,b.id AS blobId,b.r2_key AS sourceKey,
  b.size AS sourceSize,bs.r2_etag AS sourceR2Etag,a.r2_key AS indexKey,
  a.sha256 AS indexSha256,a.json_bytes AS indexBytes,a.entry_count AS entryCount,
  l.title_extracted AS titleExtracted,l.author_extracted AS authorExtracted,
  l.series_extracted AS seriesExtracted,l.title_override AS titleOverride,
  l.author_override AS authorOverride,l.series_override AS seriesOverride,l.page_count AS pageCount
  FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
  JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
  JOIN library_items l ON l.node_id=n.id AND l.blob_id=b.id
  JOIN archive_index a ON a.node_id=n.id AND a.blob_id=b.id
  WHERE n.id=? AND n.kind='file' AND n.deleted_at IS NULL
    AND b.state IN ('committed','gc_candidate') AND b.r2_key='u/'||n.owner_id||'/b/'||b.id
    AND bs.bytes=b.size AND bs.r2_etag IS NOT NULL
    AND l.kind='epub' AND l.generator_version=? AND a.generator_version=?`;

export async function readPrivateEpub(
  db: D1Database,
  bucket: R2Bucket,
  principal: Principal,
  nodeId: string,
): Promise<PrivateEpub> {
  const located = await primary(db)
    .prepare("SELECT space_id AS spaceId FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<{ spaceId: string }>();
  if (!located) throw new Error("library_not_available");
  const authorized = await authorizeNode(db, principal, {
    operation: "library.read",
    nodeId,
    spaceId: located.spaceId,
  });
  if (
    authorized.operation !== "library.read" ||
    authorized.node.kind !== "file" ||
    !authorized.node.current_blob_id
  )
    throw new Error("library_not_available");
  const batches = await atomicBatch(db, [
    authorizationAssertion(authorized),
    {
      sql: `${INDEX_SELECT} AND n.space_id=? AND n.revision=? AND n.current_blob_id=?`,
      values: [
        nodeId,
        EPUB_INDEX_GENERATOR,
        EPUB_INDEX_GENERATOR,
        authorized.node.space_id,
        authorized.node.revision,
        authorized.node.current_blob_id,
      ],
    },
  ]);
  const row = batches[1]?.results[0] as IndexRow | undefined;
  if (!row) throw new Error("library_not_available");
  const index = await loadIndex(bucket, nodeId, row);
  return Object.freeze({
    nodeId,
    blobId: row.blobId,
    title: row.titleOverride ?? row.titleExtracted,
    author: row.authorOverride ?? row.authorExtracted,
    series: row.seriesOverride ?? row.seriesExtracted,
    pageCount: row.pageCount,
    coverToken: index.coverToken,
    spine: index.spine,
    entries: Object.freeze(
      index.entries.map((entry) =>
        Object.freeze({
          token: entry.token,
          path: entry.path,
          mime: entry.mime,
          size: entry.size,
        }),
      ),
    ),
  });
}

function ifNoneMatch(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}

function headers(entry: ZipEntry & { readonly mime: string }, etag: string): Headers {
  const inline = entry.mime.startsWith("image/") && entry.mime !== "image/svg+xml";
  const name = entry.path.split("/").at(-1) ?? "entry";
  const encodedName = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Type": inline ? entry.mime : "application/octet-stream",
    ETag: etag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

async function currentIndexRow(
  db: D1Database,
  nodeId: string,
  blobId: string,
  plan: BlobReadPlan,
): Promise<IndexRow> {
  const row = await primary(db)
    .prepare(`${INDEX_SELECT} AND b.id=? AND b.r2_key=? AND b.size=? AND bs.r2_etag=?`)
    .bind(
      nodeId,
      EPUB_INDEX_GENERATOR,
      EPUB_INDEX_GENERATOR,
      blobId,
      plan.key,
      plan.size,
      plan.r2Etag,
    )
    .first<IndexRow>();
  if (!row) throw new Error("library_not_available");
  return row;
}

function responseBytes(request: Request, entry: ZipEntry, etag: string): number {
  if (request.method === "HEAD" || ifNoneMatch(request.headers.get("If-None-Match"), etag))
    return 0;
  const ifRange = request.headers.get("If-Range");
  const selected = parseRange(
    ifRange === null || ifRange === etag ? request.headers.get("Range") : null,
    entry.size,
  );
  return selected.kind === "range"
    ? selected.length
    : selected.kind === "unsatisfiable"
      ? 0
      : entry.size;
}

async function entryResponse(
  bucket: R2Bucket,
  source: ZipObjectSource,
  entry: ZipEntry & { readonly mime: string },
  etag: string,
  request: Request,
  deadline: number,
): Promise<Response> {
  const outputHeaders = headers(entry, etag);
  if (ifNoneMatch(request.headers.get("If-None-Match"), etag)) {
    const object = await bucket.head(source.key);
    if (!object || object.size !== source.size || object.etag !== source.r2Etag)
      throw new Error("epub_storage_mismatch");
    return new Response(null, { status: 304, headers: outputHeaders });
  }
  const ifRange = request.headers.get("If-Range");
  const selected = parseRange(
    ifRange === null || ifRange === etag ? request.headers.get("Range") : null,
    entry.size,
  );
  if (selected.kind === "unsatisfiable") {
    outputHeaders.set("Content-Range", `bytes */${entry.size}`);
    return new Response(null, { status: 416, headers: outputHeaders });
  }
  if (request.method === "HEAD") {
    await validateZipEntry(bucket, source, entry, deadline);
    outputHeaders.set("Content-Length", String(entry.size));
    return new Response(null, { status: 200, headers: outputHeaders });
  }
  const bytes = await readZipEntry(bucket, source, entry, deadline);
  if (selected.kind === "range") {
    outputHeaders.set(
      "Content-Range",
      `bytes ${selected.offset}-${selected.offset + selected.length - 1}/${entry.size}`,
    );
    outputHeaders.set("Content-Length", String(selected.length));
    return new Response(bytes.subarray(selected.offset, selected.offset + selected.length), {
      status: 206,
      headers: outputHeaders,
    });
  }
  outputHeaders.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, { status: 200, headers: outputHeaders });
}

export async function streamBudgetedEpubEntry(
  db: D1Database,
  bucket: R2Bucket,
  budgets: DurableObjectNamespace<BudgetDO>,
  tokens: ContentTokens,
  cookieHeader: string | null,
  nodeId: string,
  blobId: string,
  entryToken: string,
  request: Request,
): Promise<Response> {
  request.signal.throwIfAborted();
  const located = await primary(db)
    .prepare("SELECT space_id AS spaceId FROM nodes WHERE id=? AND current_blob_id=?")
    .bind(nodeId, blobId)
    .first<{ spaceId: string }>();
  if (!located) throw new Error("library_not_available");
  const plan = await prepareCookieBlobRead(
    db,
    bucket,
    tokens,
    cookieHeader,
    located.spaceId,
    nodeId,
    "page",
  );
  const row = await currentIndexRow(db, nodeId, blobId, plan.blob);
  if (plan.blob.key !== `u/${row.ownerId}/b/${blobId}`) throw new Error("library_not_available");
  const index = await loadIndex(bucket, nodeId, row);
  const entry = index.entries.find((candidate) => candidate.token === entryToken);
  if (!entry) throw new Error("library_not_available");
  const etag = `"epub-${blobId}-${entry.token}-${entry.crc32.toString(16)}"`;
  const bytes = responseBytes(request, entry, etag);
  const budget = budgets.get(budgets.idFromName(plan.budgetId));
  const requestId = crypto.randomUUID();
  const lease = await budget.reserve({
    budgetId: plan.budgetId,
    sessionId: plan.sessionId,
    requestId,
    epoch: plan.epoch,
    bytes,
  });
  const source: ZipObjectSource = {
    key: plan.blob.key,
    size: plan.blob.size,
    r2Etag: plan.blob.r2Etag,
  };
  return streamLeasedContent(
    async (_signal, deadline) => {
      try {
        return await entryResponse(bucket, source, entry, etag, request, deadline);
      } catch (error) {
        if (error instanceof ZipFormatError || isZipTransient(error))
          throw new Error("epub_storage_mismatch");
        throw error;
      }
    },
    bytes,
    lease.expiresAt,
    request.signal,
    (deliveredBytes) => budget.settle({ budgetId: plan.budgetId, requestId, deliveredBytes }),
  );
}
