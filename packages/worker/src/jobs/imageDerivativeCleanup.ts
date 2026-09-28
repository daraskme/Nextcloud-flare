import { GC_NOT_BEFORE_SQL } from "../db/gcGrace";
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
  acquireSystemMutation,
  commitSystemMutation,
  systemMutationStatements,
} from "../services/systemMutation";

const CLOCK = "strftime('%s','now')*1000";
export const IMAGE_CLEANUP_CRON = "1-59/2 * * * *";
export const IMAGE_CLEANUP_LIMIT = 8;
type CleanupEnv = Pick<Env, "DB" | "CONTROL" | "BLOBS">;
interface Claim {
  id: string;
  owner: string;
  blob: string;
  result: string;
  reservation: string;
  pin: string;
  key: string;
  token: string;
  epoch: number;
  deadline: number;
  reason: "expired" | "source_deleted" | null;
}
const fence = (c: Claim): SqlStatement =>
  assertExists(
    `SELECT 1 FROM image_derivative_cleanup x
  JOIN control ctl ON ctl.singleton=1 WHERE x.image_id=? AND x.claim_token=? AND x.claim_epoch=?
  AND x.claim_deadline=? AND x.claim_deadline>${CLOCK} AND x.settled_at IS NULL
  AND ctl.epoch=x.claim_epoch AND (ctl.maintenance=0 OR ctl.gc_paused=1)`,
    [c.id, c.token, c.epoch, c.deadline],
  );
const quiet = (c: Claim, seal: string): SqlStatement =>
  assertExists(
    `SELECT 1 FROM image_derivative_cleanup
  WHERE image_id=? AND retired_at IS NOT NULL AND seal_token=?
  AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')`,
    [c.id, seal, c.key],
  );
function current(c: Claim) {
  if (Date.now() >= c.deadline) throw new Error("image_cleanup_deadline");
}
export const IMAGE_CLEANUP_QUERY = `SELECT x.id,x.owner_id AS owner,x.output_blob_id AS blob,
    x.result_id AS result,x.reservation_id AS reservation,x.pin_id AS pin,b.r2_key AS key,
    COALESCE(c.reason,CASE WHEN x.state<>'published' AND (t.epoch<ctl.epoch OR t.expires_at<=${CLOCK}) THEN 'expired'
      WHEN x.state='published' AND source.state IN ('deleting','deleted') THEN 'source_deleted' END) AS reason
    FROM image_derivative_cleanup c JOIN image_derivative_objects x ON x.id=c.image_id
    JOIN image_transform_attempts t ON t.id=x.id JOIN blobs b ON b.id=x.output_blob_id
    JOIN blobs source ON source.id=x.source_blob_id JOIN control ctl ON ctl.singleton=1
    WHERE c.settled_at IS NULL AND c.next_at<=${CLOCK} AND c.claim_deadline<=${CLOCK}
      AND ctl.epoch=? AND (ctl.maintenance=0 OR ctl.gc_paused=1) AND (? IS NULL OR x.id=?)
    ORDER BY c.next_at,c.image_id LIMIT 1`;
async function claim(
  env: CleanupEnv,
  epoch: number,
  deadline: number,
  imageId?: string,
): Promise<Claim | null> {
  const row = await primary(env.DB)
    .prepare(IMAGE_CLEANUP_QUERY)
    .bind(epoch, imageId ?? null, imageId ?? null)
    .first<Omit<Claim, "token" | "epoch" | "deadline">>();
  if (!row) return null;
  const c: Claim = { ...row, token: crypto.randomUUID(), epoch, deadline };
  const admission = await acquireSystemMutation(env, c.owner, "image.cleanup", deadline);
  await commitSystemMutation(env.DB, admission, c.owner, [
    {
      sql: `UPDATE image_derivative_cleanup SET claim_token=?,claim_epoch=?,claim_deadline=?,head_token=NULL,
      next_at=${CLOCK}+? WHERE image_id=? AND settled_at IS NULL AND next_at<=${CLOCK} AND claim_deadline<=${CLOCK}`,
      values: [c.token, epoch, deadline, row.reason ? 60000 : 3600000, c.id],
    },
    assertOneChange,
    fence(c),
  ]);
  current(c);
  return c;
}
async function retire(env: CleanupEnv, c: Claim) {
  const admission = await acquireSystemMutation(env, c.owner, "image.cleanup", c.deadline);
  await commitSystemMutation(env.DB, admission, c.owner, [
    fence(c),
    {
      sql: `UPDATE image_derivative_cleanup SET retired_at=MAX(${CLOCK},(SELECT created_at FROM image_derivative_objects WHERE id=?)),retired_epoch=?,reason=?
      WHERE image_id=? AND retired_at IS NULL`,
      values: [c.id, c.epoch, c.reason, c.id],
    },
    assertExists(
      "SELECT 1 FROM image_derivative_cleanup WHERE image_id=? AND retired_at IS NOT NULL",
      [c.id],
    ),
    {
      sql: "UPDATE derivative_results SET state='failed',error_code='image_retired' WHERE id=?",
      values: [c.result],
    },
    assertOneChange,
  ]);
}
async function settle(
  env: CleanupEnv,
  c: Claim,
  seal: string,
  object: R2Object | null | undefined,
) {
  current(c);
  const facts: SqlStatement[] = [];
  if (object) {
    if (
      object.key !== c.key ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      !object.etag ||
      object.etag.length > 256
    )
      throw new Error("image_cleanup_object_mismatch");
    facts.push(
      {
        sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${CLOCK}) ON CONFLICT(blob_id) DO NOTHING`,
        values: [c.blob, object.size, object.etag],
      },
      assertExists(
        "SELECT 1 FROM blob_storage WHERE blob_id=? AND bytes=? AND r2_etag=? AND removed_at IS NULL",
        [c.blob, object.size, object.etag],
      ),
    );
  }
  const disposition = object === null ? "absent" : "stored";
  const admission = await acquireSystemMutation(env, c.owner, "image.cleanup", c.deadline);
  await commitSystemMutation(env.DB, admission, c.owner, [
    fence(c),
    quiet(c, seal),
    ...facts,
    {
      sql: `UPDATE image_derivative_cleanup SET disposition=?,settled_at=MAX(retired_at,${CLOCK}) WHERE image_id=? AND settled_at IS NULL`,
      values: [disposition, c.id],
    },
    assertOneChange,
    {
      sql: "UPDATE reservations SET state='released' WHERE id=? AND state='reserved'",
      values: [c.reservation],
    },
    assertExists("SELECT 1 FROM reservations WHERE id=? AND state='released'", [c.reservation]),
    { sql: "DELETE FROM blob_pins WHERE pin_id=? AND blob_id=?", values: [c.pin, c.blob] },
    assertOneChange,
    {
      sql: "UPDATE blobs SET state=? WHERE id=? AND state IN ('staging','committed') AND ref_count=0",
      values: [disposition === "stored" ? "orphan" : "deleted", c.blob],
    },
    assertOneChange,
    ...(disposition === "stored"
      ? [
          {
            sql: `INSERT INTO gc_candidates(blob_id,state,not_before) VALUES(?,'candidate',${GC_NOT_BEFORE_SQL})
      ON CONFLICT(blob_id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before) WHERE state='candidate'`,
            values: [c.blob],
          },
          assertOneChange,
        ]
      : []),
  ]);
}
async function inspectAndSettle(
  env: CleanupEnv,
  c: Claim,
): Promise<{ settled: boolean; calls: number }> {
  current(c);
  await retire(env, c);
  current(c);
  const seal = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).sealImageDerivative(
    c.epoch,
    c.id,
  );
  if (!seal || seal.key !== c.key || !/^[a-f0-9-]{36}$/.test(seal.token))
    throw new Error("image_seal_unavailable");
  current(c);
  const recorded = await primary(env.DB)
    .prepare("SELECT 1 FROM blob_storage WHERE blob_id=? AND removed_at IS NULL")
    .bind(c.blob)
    .first();
  if (recorded) {
    await settle(env, c, seal.token, undefined);
    return { settled: true, calls: 0 };
  }
  const admission = await acquireSystemMutation(env, c.owner, "image.cleanup", c.deadline);
  // An exact recovered DB receipt never authorizes a second HEAD. A lost ACK consumes its call.
  await atomicBatch(
    env.DB,
    systemMutationStatements(admission, c.owner, [
      fence(c),
      quiet(c, seal.token),
      {
        sql: "UPDATE image_derivative_cleanup SET head_calls=head_calls+1,head_token=? WHERE image_id=? AND head_calls<64 AND head_token IS NULL",
        values: [c.token, c.id],
      },
      assertOneChange,
    ]),
  );
  current(c);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const object = await Promise.race([
      env.BLOBS.head(c.key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("image_cleanup_timeout")),
          c.deadline - Date.now(),
        );
      }),
    ]);
    current(c);
    await settle(env, c, seal.token, object);
    return { settled: true, calls: 1 };
  } catch {
    return { settled: false, calls: 1 };
  } finally {
    clearTimeout(timer);
  }
}

/** Eight fair candidates, one HEAD per lease, 64 lifetime HEADs per generation, no writes or transforms. */
export async function maintainImageDerivatives(
  env: CleanupEnv,
  epoch: number,
  options: { deadline?: number; limit?: number; imageId?: string } = {},
) {
  const now = Date.now(),
    deadline = options.deadline ?? now + 25000,
    limit = options.limit ?? IMAGE_CLEANUP_LIMIT;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !Number.isSafeInteger(deadline) ||
    deadline <= now ||
    deadline > now + 25000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > IMAGE_CLEANUP_LIMIT ||
    (options.imageId !== undefined && !/^[a-f0-9-]{36}$/.test(options.imageId))
  )
    throw new Error("invalid_image_cleanup");
  const result = { inspected: 0, retired: 0, settled: 0, held: 0, r2Calls: 0 };
  for (let i = 0; i < limit && Date.now() < deadline - 1000; i++) {
    const c = await claim(env, epoch, deadline, options.imageId);
    if (!c) break;
    result.inspected++;
    let settled = false;
    try {
      if (!c.reason) continue;
      const outcome = await inspectAndSettle(env, c);
      result.r2Calls += outcome.calls;
      settled = outcome.settled;
      if (settled) result.settled++;
    } catch {
      /* Lost evidence or native uncertainty retains the pin and reservation. */
    } finally {
      const status = await primary(env.DB)
        .prepare("SELECT retired_at,settled_at FROM image_derivative_cleanup WHERE image_id=?")
        .bind(c.id)
        .first<{ retired_at: number | null; settled_at: number | null }>();
      if (status?.retired_at !== null && status?.retired_at !== undefined) result.retired++;
      if (c.reason && !settled) result.held++;
      if (status?.settled_at === null && Date.now() < deadline) {
        try {
          const admission = await acquireSystemMutation(env, c.owner, "image.cleanup", deadline);
          await commitSystemMutation(env.DB, admission, c.owner, [
            fence(c),
            {
              sql: "UPDATE image_derivative_cleanup SET claim_deadline=0 WHERE image_id=? AND claim_token=?",
              values: [c.id, c.token],
            },
            assertOneChange,
          ]);
        } catch {
          /* The persisted lease and next-at backoff remain authoritative. */
        }
      }
    }
  }
  return result;
}
