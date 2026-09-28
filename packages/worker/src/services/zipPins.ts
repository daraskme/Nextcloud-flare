import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import {
  type AccountMutationEnv,
  acquireAccountMutation,
  commitAccountMutation,
} from "./accountMutation";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "./systemMutation";
import type { ZipTargetManifest } from "./zipManifest";
import { type prepareZipSnapshot, zipSnapshotAssertions } from "./zipSnapshot";

const CLOCK = "strftime('%s','now')*1000";
const SET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function pins(manifest: ZipTargetManifest, targetSetId: string) {
  if (!SET_ID.test(targetSetId)) throw new Error("invalid_zip_pin");
  return [...new Set(manifest.targets.map((target) => target.blobId))]
    .sort()
    .map((blobId, index) => ({ pinId: `zip:${targetSetId}:${index}`, blobId }));
}

/** Leases may run until expiry; cancellation or one finished response must not release sibling readers. */
export function zipPinsAssertion(
  manifest: ZipTargetManifest,
  targetSetId: string,
  expiresAt: number,
): SqlStatement {
  return assertExists(
    `SELECT 1 WHERE ?2>${CLOCK} AND NOT EXISTS (
    SELECT 1 FROM json_each(?1) e WHERE NOT EXISTS (
      SELECT 1 FROM blob_pins p WHERE p.pin_id=json_extract(e.value,'$.pinId')
        AND p.blob_id=json_extract(e.value,'$.blobId') AND p.purpose='zip' AND p.expires_at=?2))`,
    [JSON.stringify(pins(manifest, targetSetId)), expiresAt],
  );
}

/** Acquire the complete pin set before staging the manifest. Unknown commits retain their pins. */
export async function pinZipSnapshot(
  env: AccountMutationEnv,
  snapshot: Awaited<ReturnType<typeof prepareZipSnapshot>>,
  targetSetId: string,
  expiresAt: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 600_000
  )
    throw new Error("invalid_zip_pin");
  const { proof, manifest } = snapshot;
  const guards = zipSnapshotAssertions(proof, manifest);
  const rows = pins(manifest, targetSetId);
  await atomicBatch(env.DB, guards);
  const admission = await acquireAccountMutation(
    env,
    proof.node.owner_id,
    proof.principal.epoch,
    "content.issue",
  );
  await commitAccountMutation(env.DB, admission, proof.node.owner_id, [
    ...guards,
    assertExists(`SELECT 1 WHERE ?1>${CLOCK} AND ?1<=${CLOCK}+600999`, [expiresAt]),
    {
      sql: `INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at)
        SELECT json_extract(e.value,'$.pinId'),json_extract(e.value,'$.blobId'),'zip',?2,${CLOCK}
        FROM json_each(?1) e WHERE 1 ON CONFLICT(pin_id) DO NOTHING`,
      values: [JSON.stringify(rows), expiresAt],
    },
    zipPinsAssertion(manifest, targetSetId, expiresAt),
  ]);
}

/** Indexed, bounded DB-only cleanup. Every stream must enforce the same absolute expiry. */
export async function releaseExpiredZipPins(
  env: SystemMutationSource,
  epoch: number,
  options: { limit?: number; deadline?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 100,
    deadline = options.deadline ?? Date.now() + 5_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 || !Number.isSafeInteger(deadline))
    throw new Error("invalid_zip_cleanup");
  const candidates = await primary(env.DB)
    .prepare(`SELECT p.pin_id AS pinId,p.blob_id AS blobId,
      p.expires_at AS expiresAt,b.owner_id AS ownerId FROM blob_pins p INDEXED BY blob_pins_zip_expiry
      JOIN blobs b ON b.id=p.blob_id WHERE p.purpose='zip' AND p.expires_at<=${CLOCK}
      ORDER BY p.expires_at,p.pin_id LIMIT ?`)
    .bind(limit)
    .all<{ pinId: string; blobId: string; expiresAt: number; ownerId: string }>();
  const owners = new Map<string, typeof candidates.results>();
  for (const row of candidates.results) {
    const rows = owners.get(row.ownerId) ?? [];
    rows.push(row);
    owners.set(row.ownerId, rows);
  }
  let released = 0;
  for (const [ownerId, rows] of owners) {
    if (Date.now() >= deadline) break;
    const admission = await acquireSystemMutation(env, ownerId, "content.zip-release", deadline);
    await commitSystemMutation(env.DB, admission, ownerId, [
      assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
        epoch,
      ]),
      {
        sql: `DELETE FROM blob_pins WHERE pin_id IN (SELECT json_extract(value,'$.pinId') FROM json_each(?1))
          AND purpose='zip' AND expires_at<=${CLOCK} AND EXISTS (
          SELECT 1 FROM json_each(?1) e WHERE pin_id=json_extract(e.value,'$.pinId')
            AND blob_id=json_extract(e.value,'$.blobId') AND expires_at=json_extract(e.value,'$.expiresAt'))
          AND EXISTS(SELECT 1 FROM blobs b WHERE b.id=blob_id AND b.owner_id=?2)`,
        values: [JSON.stringify(rows), ownerId],
      },
      assertExists(
        `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM blob_pins p JOIN json_each(?1) e
        ON p.pin_id=json_extract(e.value,'$.pinId') AND p.blob_id=json_extract(e.value,'$.blobId')
        AND p.expires_at=json_extract(e.value,'$.expiresAt'))`,
        [JSON.stringify(rows)],
      ),
    ]);
    released += rows.length;
  }
  return released;
}
