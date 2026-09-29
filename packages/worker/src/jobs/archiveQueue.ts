import {
  type ArchiveDerivativeGrant,
  archiveDerivativeAuthority,
  archiveOriginalFromGrant,
  archiveVisibleSource,
} from "../db/archiveDerivative";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { ARCHIVE_GENERATOR, encodeArchiveIndex } from "../media/archive/codec";
import { ArchiveError } from "../media/archive/format";
import { inspectArchive } from "../media/archive/index";
import { type ArchiveReadBudget, archiveObjectSource } from "../media/archive/r2Source";
import {
  archiveClaimFromRow,
  prepareArchiveDerivative,
  publishArchiveDerivative,
  storeArchiveDerivative,
} from "./archiveDerivative";
import type { ImageNode } from "./imageMetadata";
import { digestJson } from "./operations";
import type { EventRow } from "./outboxAuthority";

export const archiveIndexReadBudget = (): ArchiveReadBudget => ({
  reads: 0,
  bytes: 0,
  maxReads: 4,
  maxBytes: 9 * 1_048_576,
});
const SOURCE = `SELECT n.id,n.name,n.revision,n.current_blob_id AS blob,n.parent_id AS parent,b.r2_key AS key,b.size,s.r2_etag AS etag
 FROM nodes n JOIN blobs b ON b.id=n.current_blob_id AND b.owner_id=n.owner_id
 JOIN blob_storage s ON s.blob_id=b.id AND s.bytes=b.size AND s.removed_at IS NULL
 JOIN operation_steps step ON step.affected_id=b.id AND step.kind='blob'
 WHERE n.id=? AND n.space_id=? AND n.owner_id=? AND step.op_id=? AND n.parent_id=?
 AND n.kind='file' AND n.hidden=0 AND n.deleted_at IS NULL AND b.state IN ('committed','gc_candidate')
 AND b.r2_key='u/'||n.owner_id||'/b/'||b.id`;

const terminalFormatFailure = (error: unknown) =>
  error instanceof ArchiveError &&
  (error.code === "invalid_archive" ||
    error.code.startsWith("unsupported_archive_") ||
    [
      "archive_integer_overflow",
      "archive_range_invalid",
      "archive_unsafe_path",
      "archive_name_encoding",
      "archive_name_mismatch",
      "archive_ambiguous_end",
      "archive_end_limit",
      "archive_missing_zip64",
      "archive_index_limit",
      "archive_duplicate_path",
      "archive_directory_mismatch",
      "archive_size_limit",
      "archive_size_mismatch",
      "archive_path_conflict",
    ].includes(error.code));

/** New original uploads use their existing durable Outbox identity and saved principal. */
export async function archiveOutboxStatements(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "BLOBS" | "CONTROL">>,
  event: EventRow & { id: string },
  claimToken: string,
  deadline: number,
  budget: ArchiveReadBudget,
): Promise<readonly SqlStatement[]> {
  if (
    !["upload.complete", "dav.put"].includes(event.op_kind) ||
    !["node.created", "node.updated"].includes(event.kind)
  )
    return [];
  const args = [
    event.payload_ref,
    event.space_id,
    event.owner_id,
    event.op_id,
    JSON.parse(event.operands_json).parentId,
  ];
  const node = await primary(env.DB)
    .prepare(SOURCE)
    .bind(...args)
    .first<ImageNode & { etag: string; name: string; revision: number }>();
  if (!node) return [];
  const suffix = node.name.slice(node.name.lastIndexOf(".") + 1).toLowerCase();
  if (!["zip", "cbz", "epub"].includes(suffix)) return [];
  if (!env.BLOBS || !env.CONTROL || !node.etag) throw new Error("archive_binding_unavailable");
  const app = { DB: env.DB, BLOBS: env.BLOBS, CONTROL: env.CONTROL };
  const hold = assertExists(
    SOURCE + " AND n.name=? AND n.revision=? AND b.r2_key=? AND s.r2_etag=?",
    [...args, node.name, node.revision, node.key, node.etag],
  );
  const visible = archiveVisibleSource(node.id, event.owner_id);
  const prior = await primary(env.DB)
    .prepare(
      "SELECT * FROM archive_derivative_objects WHERE source_blob_id=? AND generator_version=?",
    )
    .bind(node.blob, ARCHIVE_GENERATOR)
    .first<Record<string, unknown>>();
  const request: ArchiveDerivativeGrant = {
    id: (prior?.id as string) ?? crypto.randomUUID(),
    ownerId: event.owner_id,
    blobId: node.blob,
    epoch: event.epoch,
    outboxId: event.id,
    claimToken,
    expiresAt: deadline,
    source: {
      nodeId: node.id,
      parentId: node.parent,
      key: node.key,
      size: node.size,
      etag: node.etag,
    },
  };
  // Even a too-small/non-ZIP upload gets a terminal, versioned failure rather than repeated reads.
  const sourceAuthority = async () => {
    if (node.size < 22) {
      await atomicBatch(env.DB, [visible, hold]);
      return; // The final caller's saved actor/claim also guard this result.
    }
    await atomicBatch(env.DB, [...(await archiveDerivativeAuthority(env.DB, request)), hold]);
  };
  await sourceAuthority();
  const failed = await primary(env.DB)
    .prepare(
      "SELECT id,error_code FROM derivative_results WHERE blob_id=? AND kind='archive_index' AND variant='index' AND generator_version=? AND state='failed'",
    )
    .bind(node.blob, ARCHIVE_GENERATOR)
    .first<{ id: string; error_code: string }>();
  const library: SqlStatement = {
    sql: `INSERT INTO library_items(node_id,blob_id,kind,generator_version,title_extracted,page_count) VALUES(?,?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET blob_id=excluded.blob_id,kind=excluded.kind,generator_version=excluded.generator_version,
    title_extracted=excluded.title_extracted,page_count=excluded.page_count,
    author_extracted=NULL,series_extracted=NULL,
    title_override=CASE WHEN library_items.blob_id=excluded.blob_id THEN library_items.title_override ELSE NULL END,
    author_override=CASE WHEN library_items.blob_id=excluded.blob_id THEN library_items.author_override ELSE NULL END,
    series_override=CASE WHEN library_items.blob_id=excluded.blob_id THEN library_items.series_override ELSE NULL END`,
    values: [node.id, node.blob, suffix, ARCHIVE_GENERATOR, node.name, null],
  };
  const failedFence = (id: string, code: string) =>
    assertExists(
      "SELECT 1 FROM derivative_results WHERE id=? AND blob_id=? AND kind='archive_index' AND variant='index' AND generator_version=? AND state='failed' AND error_code=?",
      [id, node.blob, ARCHIVE_GENERATOR, code],
    );
  if (failed) return [visible, hold, failedFence(failed.id, failed.error_code), library];
  let stored: Awaited<ReturnType<typeof publishArchiveDerivative>>;
  const active = { claimToken, expiresAt: deadline };
  if (prior && prior.state !== "prepared") {
    const c = archiveClaimFromRow(prior);
    if (
      c.grant.outboxId !== event.id ||
      JSON.stringify(c.grant.source) !== JSON.stringify(request.source)
    )
      throw new Error("archive_job_conflict");
    stored = await publishArchiveDerivative(app, c, active);
  } else {
    // Never re-read the source or resend an unknown/completed native PUT after a lost reply.
    if (
      prior &&
      (await primary(env.DB)
        .prepare(
          "SELECT 1 FROM r2_write_attempts WHERE kind='archive.put' AND r2_key=? AND state<>'not_started'",
        )
        .bind(`u/${event.owner_id}/d/${node.blob}/${ARCHIVE_GENERATOR}/index/${request.id}`)
        .first())
    )
      throw new Error("archive_job_unsettled");
    const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
    const guard = async () => {
      signal.throwIfAborted();
      await sourceAuthority();
      signal.throwIfAborted();
    };
    let output;
    try {
      if (node.size < 22) throw new ArchiveError("invalid_archive");
      const source = archiveObjectSource(env.BLOBS, node, signal, guard, budget);
      output = await encodeArchiveIndex(
        await inspectArchive(source),
        archiveOriginalFromGrant(request),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!terminalFormatFailure(error)) throw error;
      await sourceAuthority();
      const code = (error as ArchiveError).code,
        id = "archive_skip_" + node.blob;
      return [
        visible,
        hold,
        {
          sql: `INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,claim_token,claim_expires_at,epoch,attempts,error_code)
        VALUES(?,?,'archive_index','index',?,'failed',?,?,?,0,?)`,
          values: [id, node.blob, ARCHIVE_GENERATOR, claimToken, deadline, event.epoch, code],
        },
        failedFence(id, code),
        library,
      ];
    }
    const c = prior
      ? archiveClaimFromRow(prior)
      : await prepareArchiveDerivative(app, request, output);
    if (
      c.grant.outboxId !== event.id ||
      JSON.stringify(c.grant.source) !== JSON.stringify(request.source)
    )
      throw new Error("archive_job_conflict");
    stored = await storeArchiveDerivative(app, c, output, active);
  }
  const alias = "ai_" + (await digestJson([node.id, node.blob, ARCHIVE_GENERATOR]));
  return [
    visible,
    hold,
    assertExists(
      `SELECT 1 FROM archive_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
      JOIN archive_derivative_cleanup c ON c.archive_id=x.id WHERE x.id=? AND x.state='published'
      AND c.retired_at IS NULL AND d.id=? AND d.state='ready' AND d.r2_key=? AND d.size=? AND d.epoch=?`,
      [request.id, stored.id, stored.key, stored.size, event.epoch],
    ),
    {
      sql: "INSERT INTO archive_index(id,node_id,blob_id,generator_version,r2_key,sha256,entry_count,json_bytes) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id,blob_id,generator_version) DO NOTHING",
      values: [
        alias,
        node.id,
        node.blob,
        ARCHIVE_GENERATOR,
        stored.key,
        stored.sha256,
        stored.entryCount,
        stored.size,
      ],
    },
    assertExists(
      "SELECT 1 FROM archive_index WHERE id=? AND r2_key=? AND sha256=? AND json_bytes=?",
      [alias, stored.key, stored.sha256, stored.size],
    ),
    {
      ...library,
      values: [
        node.id,
        node.blob,
        suffix,
        ARCHIVE_GENERATOR,
        node.name,
        suffix === "epub" ? null : stored.pageCount,
      ],
    },
  ];
}
