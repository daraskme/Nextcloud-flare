import {
  type ArchiveDerivativeGrant,
  type ArchiveDerivativeReceipt,
  archiveDerivativeAuthority,
  archiveDerivativeKey,
  archiveGrantFromRow,
  archiveGrantJson,
  archiveOriginalFromGrant,
  archiveOutputJson,
  archiveOutputReceipt,
} from "../db/archiveDerivative";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import { CONTROL_NAME } from "../do/controlName";
import type { Env } from "../env";
import {
  ARCHIVE_GENERATOR,
  type ArchiveIndexOutput,
  decodeArchiveIndex,
} from "../media/archive/codec";
import { hex } from "../platform/stream";
import { trackedR2Write } from "../services/r2Write";
import {
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";

type ArchiveStoreEnv = Pick<Env, "DB" | "BLOBS" | "CONTROL">;
const CLOCK = "strftime('%s','now')*1000";
const id = (g: ArchiveDerivativeGrant) => "archive_" + g.id;
export interface ArchiveDerivativeClaim {
  grant: ArchiveDerivativeGrant;
  output: ArchiveDerivativeReceipt;
  blobId: string;
  key: string;
  attemptId: string;
  state: "prepared" | "stored" | "published";
}
const held = (c: ArchiveDerivativeClaim): SqlStatement =>
  assertExists(
    `SELECT 1 FROM archive_derivative_objects
  WHERE id=? AND owner_id=? AND source_blob_id=? AND output_blob_id=? AND result_id=? AND reservation_id=? AND pin_id=? AND write_attempt_id=? AND output_json=?`,
    [
      c.grant.id,
      c.grant.ownerId,
      c.grant.blobId,
      c.blobId,
      id(c.grant),
      id(c.grant),
      id(c.grant),
      c.attemptId,
      archiveOutputJson(c.output),
    ],
  );
function current(g: ArchiveDerivativeGrant) {
  if (Date.now() >= g.expiresAt) throw new Error("archive_derivative_expired");
}
export function archiveClaimFromRow(row: Record<string, unknown>): ArchiveDerivativeClaim {
  const g = archiveGrantFromRow(row),
    output = JSON.parse(row.output_json as string) as ArchiveDerivativeReceipt;
  if (
    archiveOutputJson(output) !== row.output_json ||
    !["prepared", "stored", "published"].includes(row.state as string)
  )
    throw new Error("archive_derivative_unavailable");
  return {
    grant: g,
    output,
    blobId: id(g),
    key: archiveDerivativeKey(g),
    attemptId: row.write_attempt_id as string,
    state: row.state as ArchiveDerivativeClaim["state"],
  };
}

/** Register one immutable JSON output without invoking Images or charging logical file quota. */
export async function prepareArchiveDerivative(
  env: ArchiveStoreEnv,
  input: ArchiveDerivativeGrant,
  output: ArchiveIndexOutput,
): Promise<ArchiveDerivativeClaim> {
  const g = JSON.parse(archiveGrantJson(input)) as ArchiveDerivativeGrant;
  current(g);
  const bytes = output.bytes.slice(),
    receipt = archiveOutputReceipt({ ...output, bytes });
  const index = await decodeArchiveIndex(bytes, archiveOriginalFromGrant(g), receipt.sha256);
  if (index.entries.length !== receipt.entryCount || index.pages.length !== receipt.pageCount)
    throw new Error("archive_derivative_output_mismatch");
  const outputJson = archiveOutputJson(receipt);
  const prior = await primary(env.DB)
    .prepare("SELECT * FROM archive_derivative_objects WHERE id=?")
    .bind(g.id)
    .first<Record<string, unknown>>();
  if (prior) {
    const c = archiveClaimFromRow(prior);
    if (
      archiveGrantJson(c.grant) !== archiveGrantJson(g) ||
      archiveOutputJson(c.output) !== outputJson
    )
      throw new Error("archive_derivative_conflict");
    await atomicBatch(env.DB, [
      ...(await archiveDerivativeAuthority(env.DB, g)),
      held(c),
      assertExists(
        "SELECT 1 FROM archive_derivative_cleanup WHERE archive_id=? AND retired_at IS NULL",
        [g.id],
      ),
    ]);
    return c;
  }
  await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).recordArchiveDerivative(g, receipt);
  const c: ArchiveDerivativeClaim = {
    grant: g,
    output: receipt,
    blobId: id(g),
    key: archiveDerivativeKey(g),
    attemptId: crypto.randomUUID(),
    state: "prepared",
  };
  const authority = await archiveDerivativeAuthority(env.DB, g),
    admission = await acquireSystemMutation(env, g.ownerId, "archive.prepare", g.expiresAt);
  current(g);
  // No native write is allowed unless this exact prepare batch directly acknowledges success.
  await atomicBatch(
    env.DB,
    systemMutationStatements(admission, g.ownerId, [
      ...authority,
      {
        sql: "INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,claim_token,claim_expires_at,epoch,attempts,r2_key,size) VALUES(?,?,'archive_index','index',?,'running',?,?,?,1,?,?)",
        values: [
          id(g),
          g.blobId,
          ARCHIVE_GENERATOR,
          g.claimToken,
          g.expiresAt,
          g.epoch,
          c.key,
          receipt.bytes,
        ],
      },
      {
        sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch,physical_only) VALUES(?,?,?,'reserved',?,?,1)",
        values: [id(g), g.ownerId, receipt.bytes, g.expiresAt, g.epoch],
      },
      {
        sql: `INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,mime_sniffed,state,created_at) VALUES(?,?,?,?,?,'application/json','staging',${CLOCK})`,
        values: [c.blobId, g.ownerId, c.key, receipt.bytes, '"a-' + g.id + '"'],
      },
      {
        sql: `INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) VALUES(?,?,'job',NULL,${CLOCK})`,
        values: [id(g), c.blobId],
      },
      {
        sql: `INSERT INTO archive_derivative_objects(id,owner_id,source_blob_id,output_blob_id,result_id,reservation_id,pin_id,write_attempt_id,outbox_id,claim_token,epoch,source_json,output_json,generator_version,created_at,expires_at,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'prepared')`,
        values: [
          g.id,
          g.ownerId,
          g.blobId,
          c.blobId,
          id(g),
          id(g),
          id(g),
          c.attemptId,
          g.outboxId,
          g.claimToken,
          g.epoch,
          JSON.stringify(g.source),
          outputJson,
          ARCHIVE_GENERATOR,
          Date.now(),
          g.expiresAt,
        ],
      },
      assertOneChange,
    ]),
  );
  current(g);
  return c;
}

/** An actual storage fact is recorded even after authorization or the current epoch changes. */
export async function observeArchiveDerivative(
  env: ArchiveStoreEnv,
  c: ArchiveDerivativeClaim,
  object: R2Object,
) {
  if (
    object.key !== c.key ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    !object.etag ||
    object.etag.length > 256
  )
    throw new Error("archive_derivative_object_mismatch");
  const sha = object.checksums.sha256 ? hex(object.checksums.sha256) : null;
  const admission = await acquireSystemMutation(env, c.grant.ownerId, "archive.observe");
  await commitSystemMutation(env.DB, admission, c.grant.ownerId, [
    held(c),
    {
      sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${CLOCK}) ON CONFLICT(blob_id) DO NOTHING`,
      values: [c.blobId, object.size, object.etag],
    },
    assertExists(
      "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
      [c.blobId, object.size, object.etag],
    ),
    {
      sql: "UPDATE blobs SET sha256_verified=?,r2_etag=? WHERE id=? AND state='staging'",
      values: [sha, object.etag, c.blobId],
    },
    assertOneChange,
    {
      sql: "UPDATE archive_derivative_objects SET state='stored' WHERE id=? AND state IN ('prepared','stored')",
      values: [c.grant.id],
    },
    assertOneChange,
  ]);
}

/** A fresh claim can publish the same stored bytes, with no renewal of any native write. */
export async function publishArchiveDerivative(
  env: ArchiveStoreEnv,
  c: ArchiveDerivativeClaim,
  active: { claimToken: string; expiresAt: number },
) {
  const g = { ...c.grant, ...active };
  current(g);
  if (!Number.isSafeInteger(g.expiresAt) || g.expiresAt > Date.now() + 25000)
    throw new Error("invalid_archive_publication");
  const authority = await archiveDerivativeAuthority(env.DB, g);
  const proof = await env.CONTROL.get(
    env.CONTROL.idFromName(CONTROL_NAME),
  ).archiveDerivativePublicationProof(g.epoch, g.id);
  if (
    proof.archiveId !== g.id ||
    proof.key !== c.key ||
    proof.outputJson !== archiveOutputJson(c.output)
  )
    throw new Error("archive_publication_unproven");
  const evidence = [
    ...authority,
    held(c),
    assertExists(
      "SELECT 1 FROM archive_derivative_cleanup WHERE archive_id=? AND retired_at IS NULL",
      [g.id],
    ),
    assertExists(
      `SELECT 1 FROM r2_write_attempts WHERE id=? AND token=? AND kind='archive.put' AND state='succeeded'
      AND owner_id=? AND epoch=? AND r2_key=? AND source_ref=? AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')`,
      [
        proof.writeId,
        proof.writeToken,
        g.ownerId,
        g.epoch,
        c.key,
        JSON.stringify([g.id, c.attemptId]),
        c.key,
      ],
    ),
    assertExists(
      `SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id JOIN blob_pins p ON p.pin_id=?
      WHERE b.id=? AND b.r2_key=? AND b.size=? AND s.bytes=b.size AND s.removed_at IS NULL AND s.r2_etag=b.r2_etag
      AND b.sha256_verified=? AND p.blob_id=b.id AND p.purpose='job' AND p.expires_at IS NULL`,
      [id(g), c.blobId, c.key, c.output.bytes, c.output.sha256],
    ),
  ];
  if (c.state === "published") {
    await atomicBatch(env.DB, [
      ...evidence,
      assertExists("SELECT 1 FROM derivative_results WHERE id=? AND state='ready' AND epoch=?", [
        id(g),
        g.epoch,
      ]),
    ]);
  } else {
    const admission = await acquireSystemMutation(env, g.ownerId, "archive.publish", g.expiresAt);
    current(g);
    await commitSystemMutation(env.DB, admission, g.ownerId, [
      ...evidence,
      {
        sql: "UPDATE derivative_results SET claim_token=?,claim_expires_at=? WHERE id=? AND state='running' AND epoch=?",
        values: [g.claimToken, g.expiresAt, id(g), g.epoch],
      },
      assertOneChange,
      {
        sql: "UPDATE blobs SET state='committed' WHERE id=? AND state='staging'",
        values: [c.blobId],
      },
      assertOneChange,
      {
        sql: "UPDATE derivative_results SET state='ready' WHERE id=? AND state='running'",
        values: [id(g)],
      },
      assertOneChange,
      {
        sql: "UPDATE archive_derivative_objects SET state='published' WHERE id=? AND state='stored'",
        values: [g.id],
      },
      assertOneChange,
      {
        sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
        values: [id(g)],
      },
      assertOneChange,
    ]);
  }
  current(g);
  return {
    id: id(g),
    blobId: c.blobId,
    key: c.key,
    size: c.output.bytes,
    sha256: c.output.sha256,
    entryCount: c.output.entryCount,
    pageCount: c.output.pageCount,
  };
}

export async function storeArchiveDerivative(
  env: ArchiveStoreEnv,
  c: ArchiveDerivativeClaim,
  output: ArchiveIndexOutput,
  active = { claimToken: c.grant.claimToken, expiresAt: c.grant.expiresAt },
) {
  const g = { ...c.grant, ...active };
  current(g);
  const bytes = output.bytes.slice();
  const parsed = await decodeArchiveIndex(bytes, archiveOriginalFromGrant(g), c.output.sha256);
  if (
    bytes.length !== c.output.bytes ||
    parsed.entries.length !== c.output.entryCount ||
    parsed.pages.length !== c.output.pageCount
  )
    throw new Error("archive_derivative_output_mismatch");
  if (c.state === "prepared") {
    let observed = false;
    const checksum = await crypto.subtle.digest("SHA-256", bytes);
    const object = await trackedR2Write(
      env,
      {
        epoch: g.epoch,
        ownerId: g.ownerId,
        kind: "archive.put",
        key: c.key,
        archive: {
          archiveId: g.id,
          attemptId: c.attemptId,
          claimToken: g.claimToken,
          expiresAt: g.expiresAt,
        },
      },
      async () => {
        const result = await env.BLOBS.put(c.key, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: checksum,
          httpMetadata: { contentType: "application/json" },
        });
        if (result)
          try {
            await observeArchiveDerivative(env, c, result);
            observed = true;
          } catch {
            /* Retain the reservation and record the native end independently. */
          }
        return result;
      },
      g.expiresAt,
      () => current(g),
    );
    if (!object) throw new Error("archive_derivative_destination_exists");
    if (!observed) await observeArchiveDerivative(env, c, object);
  }
  return publishArchiveDerivative(env, c, active);
}
