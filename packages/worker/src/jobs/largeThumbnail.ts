import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import type { Env } from "../env";
import { IMAGE_METADATA_GENERATOR, inspectImage } from "../media/images/inspect";
import { type ImageReadBudget, imageObjectSource } from "../media/images/r2Source";
import { acquireSystemMutation, commitSystemMutation } from "../services/systemMutation";
import type { ImageNode } from "./imageMetadata";
import { generateOutboxImages, type ImageGenerationBudget } from "./imageQueue";
import {
  IMAGE_REQUEST_SOURCE,
  imageRequestAuthority,
  imageRequestOperands,
} from "./imageRequestAuthority";
import { readOutboxEvent } from "./outboxAuthority";

export async function consumeLargeThumbnail(
  env: Pick<Env, "DB" | "CONTROL" | "BLOBS" | "IMAGES">,
  outboxId: string,
  deadline: number,
  budget: ImageReadBudget,
  generation: ImageGenerationBudget,
): Promise<"completed" | "failed" | "retry"> {
  const row = await readOutboxEvent(env.DB, outboxId);
  if (row?.state === "completed") return "completed";
  if (row?.state === "failed") return "failed";
  if (!row || !["dispatching", "sent"].includes(row.state)) return "retry";
  const authority = await imageRequestAuthority(env.DB, row);
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
       WHERE outbox_id=? AND epoch=? AND state IN ('dispatching','sent')
       AND (claim_token IS NULL OR claim_expires_at<=${clock})`,
        values: [token, outboxId, row.epoch],
      },
      assertOneChange,
    ]);
    const claim = assertExists(
      `SELECT 1 FROM outbox e JOIN control c ON c.singleton=1 AND c.epoch=e.epoch AND c.maintenance=0
      WHERE e.outbox_id=? AND e.claim_token=? AND e.claim_expires_at>=? AND e.state IN ('dispatching','sent') AND e.epoch=?`,
      [outboxId, token, deadline, row.epoch],
    );
    const o = imageRequestOperands(row),
      values = [o.nodeId, o.parentId, o.blobId, row.owner_id, IMAGE_METADATA_GENERATOR];
    const node = await primary(env.DB)
      .prepare(IMAGE_REQUEST_SOURCE)
      .bind(...values)
      .first<ImageNode & { etag: string }>();
    if (!node?.etag) throw new Error("image_source_unavailable");
    const source = assertExists(
      IMAGE_REQUEST_SOURCE + " AND b.r2_key=?6 AND b.size=?7 AND s.r2_etag=?8",
      [...values, node.key, node.size, node.etag],
    );
    const guard = async () => {
      await atomicBatch(env.DB, [...authority, claim, source]);
    };
    await guard();
    const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
    const image = await inspectImage(imageObjectSource(env.BLOBS, node, signal, guard, budget));
    if (!image) throw new Error("image_source_unavailable");
    const terminal = await generateOutboxImages(
      env,
      { ...row, id: outboxId },
      { node, image, guard },
      token,
      deadline,
      generation,
      ["lg"],
    );
    const complete = await acquireSystemMutation(env, row.owner_id, "outbox.complete", deadline);
    if (Date.now() >= deadline) throw new Error("image_job_deadline");
    await commitSystemMutation(env.DB, complete, row.owner_id, [
      ...authority,
      claim,
      source,
      ...terminal,
      {
        sql: `UPDATE outbox SET state='completed',updated_at=MAX(updated_at,${clock}) WHERE outbox_id=? AND claim_token=? AND state IN ('dispatching','sent')`,
        values: [outboxId, token],
      },
      assertOneChange,
    ]);
    return "completed";
  } catch {
    return (await readOutboxEvent(env.DB, outboxId))?.state === "completed" ? "completed" : "retry";
  }
}
