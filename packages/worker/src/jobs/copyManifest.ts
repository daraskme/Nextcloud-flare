import { assertExists, primary, type SqlStatement } from "../db/primary";
import {
  copyPreparationAssertions,
  type PreparedCopy,
  preparedCopyBlobs,
} from "../services/copyPreparation";

export const COPY_MANIFEST_CHUNK_BYTES = 65_536;
export const COPY_JOB_STEPS = 4;
const CLOCK = "strftime('%s','now')*1000";
const MAX_BYTES = 8 * 1024 * 1024;
export const copyJobId = (operationId: string) => {
  if (!/^op_[a-f0-9]{64}$/.test(operationId)) throw new Error("invalid_copy_job");
  return "copy_" + operationId.slice(3);
};

/** No namespace or R2 dispatch: append with holds, operation receipt and outbox in one batch. */
export function copyJobManifestStatements(
  plan: PreparedCopy,
  operationId: string,
  expiresAt: number,
): SqlStatement[] {
  copyPreparationAssertions(plan);
  const jobId = copyJobId(operationId),
    { digest, ...body } = plan;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.length > MAX_BYTES) throw new Error("copy_manifest_too_large");
  const chunks = Math.ceil(bytes.length / COPY_MANIFEST_CHUNK_BYTES);
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO bulk_jobs(id,owner_id,credential_id,op_id,kind,state,epoch,manifest_ref,grant_snapshot,node_count,blob_count,created_at,updated_at)
        VALUES(?,?,?,?,'node.copy','pending',?,?,?,?,?,${CLOCK},${CLOCK})`,
      values: [
        jobId,
        plan.destinationOwnerId,
        plan.principal.credential_id,
        operationId,
        plan.principal.epoch,
        "d1:copy/" + jobId,
        JSON.stringify({ principal: plan.principal, destination: plan.destination }),
        plan.source.entries.length,
        plan.source.blobs.length,
      ],
    },
    {
      sql: "INSERT INTO copy_job_manifests(job_id,sha256,bytes,chunks,expires_at) VALUES(?,?,?,?,?)",
      values: [jobId, digest, bytes.length, chunks, expiresAt],
    },
  ];
  for (let part = 0; part < chunks; part++)
    statements.push({
      sql: "INSERT INTO copy_job_chunks(job_id,part,data) VALUES(?,?,?)",
      values: [
        jobId,
        part,
        bytes.slice(part * COPY_MANIFEST_CHUNK_BYTES, (part + 1) * COPY_MANIFEST_CHUNK_BYTES)
          .buffer,
      ],
    });
  return statements;
}
/** Holds already inserted in this transaction are permanently bound to the accepted manifest. */
export function copyJobHoldStatements(plan: PreparedCopy, operationId: string): SqlStatement[] {
  const jobId = copyJobId(operationId),
    blobs = preparedCopyBlobs(plan, jobId);
  const statements: SqlStatement[] = [];
  for (let i = 0; i < blobs.length; i += 256)
    statements.push({
      sql: `INSERT INTO copy_job_blobs(job_id,source_blob_id,destination_blob_id,pin_id,reservation_id)
      SELECT ?,json_extract(value,'$.sourceBlobId'),json_extract(value,'$.destinationBlobId'),json_extract(value,'$.pinId'),json_extract(value,'$.reservationId') FROM json_each(?)`,
      values: [jobId, JSON.stringify(blobs.slice(i, i + 256))],
    });
  statements.push(
    assertExists(
      "SELECT 1 FROM bulk_jobs j JOIN copy_job_manifests m ON m.job_id=j.id WHERE j.id=? AND j.blob_count=(SELECT COUNT(*) FROM copy_job_blobs WHERE job_id=j.id) AND m.chunks=(SELECT COUNT(*) FROM copy_job_chunks WHERE job_id=j.id) AND m.bytes=(SELECT SUM(length(data)) FROM copy_job_chunks WHERE job_id=j.id)",
      [jobId],
    ),
  );
  return statements;
}

export interface StoredCopyManifest {
  readonly plan: PreparedCopy;
  readonly expiresAt: number;
}
/** Internal data only. This never creates the request-local authorization proof or permits I/O. */
export async function loadCopyJobManifest(db: D1Database, id: string): Promise<StoredCopyManifest> {
  if (!/^copy_[a-f0-9]{64}$/.test(id)) throw new Error("invalid_copy_job");
  const row = await primary(db)
    .prepare(`SELECT m.*,(SELECT COUNT(*) FROM copy_job_chunks WHERE job_id=m.job_id) AS stored_chunks,j.op_id,j.owner_id,j.credential_id,j.epoch,j.node_count,j.blob_count,j.grant_snapshot,
      o.space_id,o.destination_space_id,o.destination_share_id,o.destination_share_version,o.principal_id,o.selected_share_id,o.selected_share_version,o.operands_json,o.result_json,source.owner_id AS source_owner_id
    FROM copy_job_manifests m JOIN bulk_jobs j ON j.id=m.job_id JOIN operations o ON o.op_id=j.op_id
      JOIN spaces source ON source.id=o.space_id JOIN spaces target ON target.id=o.destination_space_id AND target.owner_id=j.owner_id
    WHERE m.job_id=? AND j.kind='node.copy' AND j.manifest_ref='d1:copy/'||j.id AND o.kind='copy.enqueue'
      AND o.state='committed' AND o.epoch=j.epoch AND o.credential_id=j.credential_id
      AND o.principal_kind='user' AND j.id='copy_'||substr(o.op_id,4)`)
    .bind(id)
    .first<{
      sha256: string;
      bytes: number;
      chunks: number;
      stored_chunks: number;
      expires_at: number;
      op_id: string;
      owner_id: string;
      source_owner_id: string;
      credential_id: string;
      epoch: number;
      node_count: number;
      blob_count: number;
      grant_snapshot: string;
      space_id: string;
      destination_space_id: string;
      destination_share_id: string | null;
      destination_share_version: number | null;
      principal_id: string;
      selected_share_id: string | null;
      selected_share_version: number | null;
      operands_json: string;
      result_json: string;
    }>();
  if (
    !row ||
    row.bytes < 1 ||
    row.bytes > MAX_BYTES ||
    row.stored_chunks !== row.chunks ||
    row.chunks !== Math.ceil(row.bytes / COPY_MANIFEST_CHUNK_BYTES)
  )
    throw new Error("copy_manifest_unavailable");
  const bytes = new Uint8Array(row.bytes);
  // D1 represents BLOBs as number arrays. Do not materialize all 8 MiB in that form at once.
  for (let start = 0; start < row.chunks; start += 8) {
    const parts = await primary(db)
      .prepare(
        "SELECT part,data FROM copy_job_chunks WHERE job_id=? AND part>=? ORDER BY part LIMIT 8",
      )
      .bind(id, start)
      .all<{ part: number; data: number[] }>();
    if (parts.results.length !== Math.min(8, row.chunks - start))
      throw new Error("copy_manifest_unavailable");
    for (let offset = 0; offset < parts.results.length; offset++) {
      const part = parts.results[offset]!,
        i = start + offset;
      if (
        part.part !== i ||
        part.data.length !==
          Math.min(COPY_MANIFEST_CHUNK_BYTES, row.bytes - i * COPY_MANIFEST_CHUNK_BYTES)
      )
        throw new Error("copy_manifest_unavailable");
      bytes.set(part.data, i * COPY_MANIFEST_CHUNK_BYTES);
    }
  }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== row.sha256) throw new Error("copy_manifest_unavailable");
  try {
    const plan = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as PreparedCopy;
    const operands = JSON.parse(row.operands_json),
      result = JSON.parse(row.result_json);
    if (
      plan.version !== 1 ||
      plan.principal.kind !== "user" ||
      plan.principal.user_id !== row.principal_id ||
      plan.principal.credential_id !== row.credential_id ||
      plan.principal.epoch !== row.epoch ||
      (plan.principal.selected_share?.id ?? null) !== row.selected_share_id ||
      (plan.principal.selected_share?.version ?? null) !== row.selected_share_version ||
      plan.source.spaceId !== row.space_id ||
      plan.source.ownerId !== row.source_owner_id ||
      plan.destination.spaceId !== row.destination_space_id ||
      (plan.destination.share?.id ?? null) !== row.destination_share_id ||
      (plan.destination.share?.version ?? null) !== row.destination_share_version ||
      plan.destinationOwnerId !== row.owner_id ||
      plan.destinationOwnerId === plan.source.ownerId ||
      plan.source.rootId !== operands.sourceNodeId ||
      plan.destinationParentId !== operands.parentId ||
      plan.name !== operands.name ||
      plan.depth !== operands.depth ||
      (plan.overwrite?.rootId ?? null) !== (operands.overwriteTargetId ?? null) ||
      plan.source.entries.length !== row.node_count ||
      plan.source.blobs.length !== row.blob_count ||
      JSON.stringify({ principal: plan.principal, destination: plan.destination }) !==
        row.grant_snapshot ||
      result.status !== 202 ||
      result.jobId !== id
    )
      throw new Error("copy_manifest_unavailable");
    const holds = await primary(db)
      .prepare(`SELECT cb.source_blob_id,cb.destination_blob_id,cb.pin_id,cb.reservation_id,b.size
      FROM copy_job_blobs cb JOIN blobs b ON b.id=cb.source_blob_id
      JOIN blob_pins p ON p.pin_id=cb.pin_id AND p.blob_id=b.id AND p.purpose='copy' AND p.expires_at=?2
      JOIN reservations r ON r.id=cb.reservation_id AND r.owner_id=?3 AND r.bytes=b.size AND r.epoch=?4
        AND r.state='reserved' AND r.expires_at=?2 AND r.share_id IS NULL AND r.op_id IS NULL
      WHERE cb.job_id=?1 AND b.owner_id=?5 ORDER BY cb.source_blob_id LIMIT 10001`)
      .bind(id, row.expires_at, row.owner_id, row.epoch, row.source_owner_id)
      .all<{
        source_blob_id: string;
        destination_blob_id: string;
        pin_id: string;
        reservation_id: string;
        size: number;
      }>();
    if (holds.results.length !== row.blob_count) throw new Error("copy_manifest_unavailable");
    holds.results.forEach((hold, i) => {
      const blob = plan.source.blobs[i],
        suffix = String(i + 1).padStart(5, "0");
      if (
        !blob ||
        blob.id !== hold.source_blob_id ||
        blob.size !== hold.size ||
        hold.destination_blob_id !== id + "_b" + suffix ||
        hold.pin_id !== id + "_p" + suffix ||
        hold.reservation_id !== id + "_r" + suffix
      )
        throw new Error("copy_manifest_unavailable");
    });
    return Object.freeze({ plan: freeze({ ...plan, digest: hash }), expiresAt: row.expires_at });
  } catch {
    throw new Error("copy_manifest_unavailable");
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
