import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import type { ImageReadBudget } from "../media/images/r2Source";
import { acquireSystemMutation, commitSystemMutation } from "../services/systemMutation";
import { type ImageNode, prepareFileMetadata } from "./imageMetadata";
import {
  MEDIA_REQUEST_SOURCE,
  mediaRequestAuthority,
  mediaRequestOperands,
} from "./mediaRequestAuthority";
import { readOutboxEvent } from "./outboxAuthority";

/** Extraction never invokes Images or rewrites the original. Covers remain explicit requests. */
export async function consumeMediaExtraction(
  env: Pick<Env, "DB" | "CONTROL" | "BLOBS">,
  outboxId: string,
  deadline: number,
  budget: ImageReadBudget,
): Promise<"completed" | "failed" | "retry"> {
  const row = await readOutboxEvent(env.DB, outboxId);
  if (row?.state === "completed") return "completed";
  if (row?.state === "failed") return "failed";
  if (!row || !["dispatching", "sent"].includes(row.state)) return "retry";
  const authority = await mediaRequestAuthority(env.DB, row);
  if (!authority) return "retry";
  try {
    const token = crypto.randomUUID(),
      clock = "strftime('%s','now')*1000";
    const admission = await acquireSystemMutation(
      env,
      row.owner_id,
      "outbox.consume-claim",
      deadline,
    );
    await commitSystemMutation(env.DB, admission, row.owner_id, [
      ...authority,
      {
        sql: `UPDATE outbox SET claim_token=?,claim_expires_at=${clock}+30000,updated_at=MAX(updated_at,${clock})
        WHERE outbox_id=? AND epoch=? AND state IN ('dispatching','sent') AND result_json IS NULL
        AND (claim_token IS NULL OR claim_expires_at<=${clock})`,
        values: [token, outboxId, row.epoch],
      },
      assertOneChange,
    ]);
    const claim = assertExists(
      `SELECT 1 FROM outbox e JOIN control c ON c.singleton=1 AND c.epoch=e.epoch AND c.maintenance=0
       WHERE e.outbox_id=? AND e.claim_token=? AND e.claim_expires_at>=? AND e.epoch=?
       AND e.state IN ('dispatching','sent') AND e.result_json IS NULL`,
      [outboxId, token, deadline, row.epoch],
    );
    const o = mediaRequestOperands(row),
      values = [o.nodeId, o.parentId, o.blobId, row.owner_id];
    const node = await primary(env.DB)
      .prepare(MEDIA_REQUEST_SOURCE)
      .bind(...values)
      .first<ImageNode & { name: string; revision: number; etag: string }>();
    if (!node?.etag) throw new Error("media_source_unavailable");
    const hold = assertExists(
      MEDIA_REQUEST_SOURCE +
        " AND n.name=?5 AND n.revision=?6 AND b.r2_key=?7 AND b.size=?8 AND s.r2_etag=?9",
      [...values, node.name, node.revision, node.key, node.size, node.etag],
    );
    const guard = async () => {
      await atomicBatch(env.DB, [...authority, claim, hold]);
    };
    const metadata = await prepareFileMetadata(
      env,
      node,
      row.space_id,
      row.owner_id,
      hold,
      guard,
      deadline,
      budget,
      true,
    );
    if (!metadata.kind) throw new Error("media_result_unavailable");
    const completion = await acquireSystemMutation(env, row.owner_id, "outbox.complete", deadline);
    if (Date.now() >= deadline) throw new Error("media_job_deadline");
    await commitSystemMutation(env.DB, completion, row.owner_id, [
      ...authority,
      claim,
      ...metadata.statements,
      {
        sql: `UPDATE outbox SET state='completed',result_json=?,updated_at=MAX(updated_at,${clock})
        WHERE outbox_id=? AND claim_token=? AND state IN ('dispatching','sent')`,
        values: [JSON.stringify({ kind: metadata.kind }), outboxId, token],
      },
      assertOneChange,
    ]);
    return "completed";
  } catch {
    return (await readOutboxEvent(env.DB, outboxId))?.state === "completed" ? "completed" : "retry";
  }
}
