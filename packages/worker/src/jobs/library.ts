import type { LibraryKind } from "@ncf/shared";

import type { Env } from "../env.js";
import { extractZipEntry, indexZipArchive, type ZipEntry } from "../media/archive/zip.js";
import {
  epubDerivativeKey,
  EPUB_ENTRY_LIMIT,
  EPUB_TOTAL_XHTML_LIMIT,
  sanitizePublicationXhtml,
} from "../media/epub/sanitize.js";
import { isEffectiveLive } from "../services/effectiveLive.js";

export const libraryGeneratorVersion = "library-v1";
const PAGE_OUTPUT_LIMIT = 20 * 1024 * 1024;
const PAGE_LIMIT = 2000;

export interface LibraryJobMessage {
  kind: "library-index";
  jobId: string;
}

interface LibraryJobRow {
  id: string;
  nodeId: string;
  blobId: string;
  ownerId: string;
  kind: "archive" | "epub" | "pdf";
  generatorVersion: string;
  epoch: number;
  attempt: number;
  claimToken: string;
  rootId: string;
  r2Key: string;
  size: number;
  mime: string;
  name: string;
  series: string | null;
  tagsJson: string;
}

interface EpubDerivative {
  id: string;
  path: string;
  title: string;
  key: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function classify(
  name: string,
  mime: string,
): { job: LibraryJobRow["kind"]; item: LibraryKind } | null {
  const ext = extension(name);
  if (ext === "epub" || mime === "application/epub+zip") return { job: "epub", item: "epub" };
  if (ext === "pdf" || mime === "application/pdf") return { job: "pdf", item: "pdf" };
  if (["cbz", "zip", "cbr", "rar", "7z"].includes(ext)) return { job: "archive", item: "cbz" };
  return null;
}

function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).slice(0, 1024);
}

function pageEntries(entries: ZipEntry[]): ZipEntry[] {
  const pages = entries
    .filter((entry) => entry.contentType.startsWith("image/") && !entry.path.endsWith("/"))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  if (pages.length === 0 || pages.length > PAGE_LIMIT) throw new Error("archive_page_limit");
  if (pages.some((entry) => entry.uncompressedSize > PAGE_OUTPUT_LIMIT)) {
    throw new Error("archive_page_too_large");
  }
  return pages;
}

async function cover(
  env: Env,
  job: LibraryJobRow,
  source: ZipEntry | undefined,
): Promise<string | null> {
  if (source === undefined) return null;
  const bytes = await extractZipEntry(env.BLOBS, job.r2Key, job.size, source, PAGE_OUTPUT_LIMIT);
  const body = new Response(bytes).body;
  if (body === null) throw new Error("cover_stream_unavailable");
  const result = await env.IMAGES.input(body)
    .transform({ width: 320, height: 480, fit: "scale-down" })
    .output({ format: "image/webp", quality: 80, anim: false });
  const output = await result.response().arrayBuffer();
  if (output.byteLength > PAGE_OUTPUT_LIMIT) throw new Error("cover_output_too_large");
  const key = `u/${job.ownerId}/d/${job.blobId}/${job.generatorVersion}/cover/${job.claimToken}.webp`;
  await env.BLOBS.put(key, output, { httpMetadata: { contentType: "image/webp" } });
  return key;
}

async function sanitizeEpub(
  env: Env,
  job: LibraryJobRow,
  entries: ZipEntry[],
): Promise<{ derivatives: EpubDerivative[]; keys: string[] }> {
  const documents = entries
    .filter((entry) => entry.contentType === "application/xhtml+xml" && !entry.path.endsWith("/"))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  if (documents.length === 0 || documents.length > EPUB_ENTRY_LIMIT) {
    throw new Error("epub_entry_limit");
  }
  const derivatives: EpubDerivative[] = [];
  const keys: string[] = [];
  let total = 0;
  for (const entry of documents) {
    total += entry.uncompressedSize;
    if (total > EPUB_TOTAL_XHTML_LIMIT) throw new Error("epub_output_limit");
    const bytes = await extractZipEntry(env.BLOBS, job.r2Key, job.size, entry);
    const title = titleFromName(entry.path.split("/").at(-1) ?? entry.path);
    const xhtml = sanitizePublicationXhtml(bytes, title);
    const key = epubDerivativeKey(
      job.ownerId,
      job.blobId,
      job.generatorVersion,
      entry.entryId,
      job.claimToken,
    );
    await env.BLOBS.put(key, xhtml, { httpMetadata: { contentType: "application/xhtml+xml" } });
    derivatives.push({ id: entry.entryId, path: entry.path, title, key });
    keys.push(key);
  }
  return { derivatives, keys };
}

function indexManifestKey(job: LibraryJobRow): string {
  return `u/${job.ownerId}/d/${job.blobId}/${job.generatorVersion}/archive-index/${job.claimToken}.json`;
}

async function completeLibraryJob(
  env: Env,
  job: LibraryJobRow,
  itemKind: LibraryKind,
  entries: ZipEntry[],
  selected: ZipEntry[],
  coverKey: string | null,
  epubEntries: EpubDerivative[],
): Promise<void> {
  const manifestKey = entries.length === 0 ? null : indexManifestKey(job);
  if (manifestKey !== null) {
    await env.BLOBS.put(manifestKey, JSON.stringify(entries), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM library_jobs j JOIN nodes n ON n.id=j.node_id JOIN users u ON u.id=j.owner_id JOIN control c ON c.singleton=1 WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND j.epoch=c.epoch AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL AND u.disabled_at IS NULL)",
    ).bind(job.id, job.claimToken),
    env.DB.prepare("DELETE FROM archive_index WHERE node_id=?1").bind(job.nodeId),
  ];
  for (const [pageNo, entry] of selected.entries()) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO archive_index(node_id,blob_id,entry_id,path,method,flags,compressed_size,uncompressed_size,offset,crc32,data_offset,content_type,page_no) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
      ).bind(
        job.nodeId,
        job.blobId,
        entry.entryId,
        entry.path,
        entry.method,
        entry.flags,
        entry.compressedSize,
        entry.uncompressedSize,
        entry.localHeaderOffset,
        entry.crc32,
        entry.dataOffset,
        entry.contentType,
        itemKind === "cbz" ? pageNo : null,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE library_items SET blob_id=?1,kind=?2,title=?3,series=?4,tags_json=?5,page_count=?6,cover_key=?7,generator_version=?8,status='indexed',error_code=NULL,metadata_json=?9,updated_at=?10 WHERE node_id=?11 AND EXISTS(SELECT 1 FROM nodes WHERE id=?11 AND current_blob_id=?1 AND deleted_at IS NULL)",
    ).bind(
      job.blobId,
      itemKind,
      titleFromName(job.name),
      job.series,
      job.tagsJson,
      itemKind === "pdf"
        ? null
        : itemKind === "epub"
          ? epubEntries.length
          : selected.filter((entry) => entry.contentType.startsWith("image/")).length,
      coverKey,
      job.generatorVersion,
      JSON.stringify({ manifestKey, epubEntries }),
      now,
      job.nodeId,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE library_jobs SET state='completed',claim_token=NULL,claim_expires_at=NULL,last_error=NULL,updated_at=?1 WHERE id=?2 AND state='claimed' AND claim_token=?3",
    ).bind(now, job.id, job.claimToken),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const keys = [manifestKey, coverKey, ...epubEntries.map((entry) => entry.key)].filter(
      (key): key is string => key !== null,
    );
    await Promise.all(keys.map((key) => env.BLOBS.delete(key).catch(() => undefined)));
    throw error;
  }
}

async function failLibraryJob(env: Env, job: LibraryJobRow, error: unknown): Promise<void> {
  const code = error instanceof Error ? error.message.slice(0, 160) : "library_job_failed";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE library_items SET status='failed',error_code=?1,updated_at=?2 WHERE node_id=?3 AND blob_id=?4 AND EXISTS(SELECT 1 FROM nodes WHERE id=?3 AND current_blob_id=?4)",
    ).bind(code, now, job.nodeId, job.blobId),
    env.DB.prepare(
      "UPDATE library_jobs SET state='failed',claim_token=NULL,claim_expires_at=NULL,last_error=?1,updated_at=?2 WHERE id=?3 AND state='claimed' AND claim_token=?4",
    ).bind(code, now, job.id, job.claimToken),
  ]);
}

async function claimLibraryJob(env: Env, jobId: string): Promise<LibraryJobRow | null> {
  const token = randomId("claim");
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE library_jobs SET state='claimed',attempt=attempt+1,claim_token=?1,claim_expires_at=?2,last_error=NULL,updated_at=?3 WHERE id=?4 AND (state='pending' OR state='failed' OR (state='claimed' AND claim_expires_at<=?3)) AND attempt<3 AND epoch=(SELECT epoch FROM control WHERE singleton=1) AND EXISTS(SELECT 1 FROM users WHERE id=library_jobs.owner_id AND disabled_at IS NULL) AND EXISTS(SELECT 1 FROM nodes WHERE id=library_jobs.node_id AND owner_id=library_jobs.owner_id AND current_blob_id=library_jobs.blob_id AND deleted_at IS NULL)",
  )
    .bind(token, now + 60_000, now, jobId)
    .run();
  return env.DB.prepare(
    "SELECT j.id,j.node_id nodeId,j.blob_id blobId,j.owner_id ownerId,j.kind,j.generator_version generatorVersion,j.epoch,j.attempt,j.claim_token claimToken,s.root_node_id rootId,b.r2_key r2Key,b.size,COALESCE(b.mime_sniffed,'application/octet-stream') mime,n.name,p.name series,COALESCE((SELECT json_group_array(t.name) FROM node_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.node_id=n.id),'[]') tagsJson FROM library_jobs j JOIN nodes n ON n.id=j.node_id JOIN nodes p ON p.id=n.parent_id JOIN spaces s ON s.id=n.space_id JOIN blobs b ON b.id=j.blob_id WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(jobId, token)
    .first<LibraryJobRow>();
}

export async function enqueueLibraryJob(
  env: Env,
  nodeId: string,
  send: (message: LibraryJobMessage) => Promise<void> = async (message) => {
    await env.JOBS.send(message);
  },
): Promise<string | null> {
  const row = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,owner_id,depth) AS (SELECT id,parent_id,owner_id,0 FROM nodes WHERE id=?1 AND kind='file' AND deleted_at IS NULL UNION ALL SELECT p.id,p.parent_id,p.owner_id,a.depth+1 FROM nodes p JOIN a ON p.id=a.parent_id WHERE a.depth<64 AND p.deleted_at IS NULL) SELECT n.id nodeId,n.owner_id ownerId,n.current_blob_id blobId,n.name,COALESCE(b.mime_sniffed,'application/octet-stream') mime FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?1 AND b.state='committed' AND EXISTS(SELECT 1 FROM a JOIN library_roots r ON r.node_id=a.id AND r.user_id=a.owner_id)",
  )
    .bind(nodeId)
    .first<{ nodeId: string; ownerId: string; blobId: string; name: string; mime: string }>();
  if (row === null) return null;
  const classification = classify(row.name, row.mime);
  if (classification === null) return null;
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  const now = Date.now();
  const jobId = randomId("library");
  const itemId = randomId("item");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO library_items(id,node_id,blob_id,kind,title,author,cover_blob_id,generator_version,series,tags_json,page_count,cover_key,status,error_code,metadata_json,updated_at) VALUES(?1,?2,?3,?4,?5,NULL,NULL,?6,NULL,'[]',NULL,NULL,'pending',NULL,'{}',?7) ON CONFLICT(node_id) DO UPDATE SET blob_id=excluded.blob_id,kind=excluded.kind,title=excluded.title,generator_version=excluded.generator_version,page_count=NULL,cover_key=NULL,status='pending',error_code=NULL,metadata_json='{}',updated_at=excluded.updated_at",
    ).bind(
      itemId,
      row.nodeId,
      row.blobId,
      classification.item,
      titleFromName(row.name),
      libraryGeneratorVersion,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO library_jobs(id,node_id,blob_id,owner_id,kind,generator_version,saved_principal_json,epoch,state,attempt,claim_token,claim_expires_at,last_error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,NULL,NULL,NULL,?9,?9) ON CONFLICT(node_id,blob_id,generator_version) DO NOTHING",
    ).bind(
      jobId,
      row.nodeId,
      row.blobId,
      row.ownerId,
      classification.job,
      libraryGeneratorVersion,
      JSON.stringify({ kind: "system", systemKind: "library", ownerId: row.ownerId }),
      control.epoch,
      now,
    ),
  ]);
  const job = await env.DB.prepare(
    "SELECT id,state,attempt FROM library_jobs WHERE node_id=?1 AND blob_id=?2 AND generator_version=?3",
  )
    .bind(row.nodeId, row.blobId, libraryGeneratorVersion)
    .first<{ id: string; state: string; attempt: number }>();
  if (job === null || job.state === "completed" || job.attempt >= 3) return job?.id ?? null;
  await send({ kind: "library-index", jobId: job.id });
  return job.id;
}

export async function discoverLibraryJobs(env: Env, limit = 100): Promise<number> {
  const rows = await env.DB.prepare(
    "WITH RECURSIVE scope(user_id,id,depth) AS (SELECT user_id,node_id,0 FROM library_roots UNION ALL SELECT scope.user_id,n.id,scope.depth+1 FROM nodes n JOIN scope ON n.parent_id=scope.id WHERE n.deleted_at IS NULL AND scope.depth<64) SELECT DISTINCT n.id FROM scope JOIN nodes n ON n.id=scope.id JOIN blobs b ON b.id=n.current_blob_id LEFT JOIN library_items i ON i.node_id=n.id AND i.blob_id=n.current_blob_id AND i.generator_version=?1 WHERE n.owner_id=scope.user_id AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed' AND i.id IS NULL ORDER BY n.updated_at,n.id LIMIT ?2",
  )
    .bind(libraryGeneratorVersion, limit)
    .all<{ id: string }>();
  for (const row of rows.results) await enqueueLibraryJob(env, row.id, () => Promise.resolve());
  return rows.results.length;
}

export async function dispatchPendingLibraryJobs(env: Env, limit = 100): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id FROM library_jobs WHERE state='pending' ORDER BY created_at,id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await env.JOBS.send({ kind: "library-index", jobId: row.id } satisfies LibraryJobMessage);
  }
  return rows.results.length;
}

export async function processLibraryJob(env: Env, jobId: string): Promise<void> {
  const job = await claimLibraryJob(env, jobId);
  if (job === null) {
    const terminal = await env.DB.prepare("SELECT state,attempt FROM library_jobs WHERE id=?1")
      .bind(jobId)
      .first<{ state: string; attempt: number }>();
    if (
      terminal?.state === "completed" ||
      (terminal?.state === "failed" && terminal.attempt >= 3)
    ) {
      return;
    }
    throw new Error("library_job_not_claimed");
  }
  try {
    if (!(await isEffectiveLive(env, job.nodeId, job.rootId))) throw new Error("node_not_found");
    const ext = extension(job.name);
    if (["cbr", "rar", "7z"].includes(ext)) throw new Error("unsupported_format");
    if (job.kind === "pdf") {
      await completeLibraryJob(env, job, "pdf", [], [], null, []);
      return;
    }
    const entries = await indexZipArchive(env.BLOBS, job.r2Key, job.size);
    if (job.kind === "epub") {
      const sanitized = await sanitizeEpub(env, job, entries);
      const images = entries
        .filter((entry) => entry.contentType.startsWith("image/") && !entry.path.endsWith("/"))
        .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
      const coverKey = await cover(env, job, images[0]);
      const selectedIds = new Set([
        ...sanitized.derivatives.map((entry) => entry.id),
        ...(images[0] === undefined ? [] : [images[0].entryId]),
      ]);
      await completeLibraryJob(
        env,
        job,
        "epub",
        entries,
        entries.filter((entry) => selectedIds.has(entry.entryId)),
        coverKey,
        sanitized.derivatives,
      );
      return;
    }
    const pages = pageEntries(entries);
    const coverKey = await cover(env, job, pages[0]);
    await completeLibraryJob(env, job, "cbz", entries, pages, coverKey, []);
  } catch (error) {
    await failLibraryJob(env, job, error).catch(() => undefined);
    throw error;
  }
}
