import { assertExists, assertOneChange, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import type { ImageReadBudget } from "../media/images/r2Source";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { consumeCopyOutbox } from "./copyQueue";
import { imageMetadataStatements } from "./imageMetadata";
import { generateOutboxImages, type ImageGenerationBudget } from "./imageQueue";
import { consumeLargeThumbnail } from "./largeThumbnail";
import { consumeMediaExtraction } from "./mediaExtraction";
import { nodeEventAuthority, readOutboxEvent } from "./outboxAuthority";

export const OUTBOX_CLAIM_LEASE_MS = 30_000;
export type ConsumeResult = "completed" | "failed" | "retry";
export type OutboxConsumerEnv = SystemMutationSource &
  Partial<Pick<Env, "BLOBS" | "LOCKS" | "IMAGES">>;

/** Complete a node event only after a fenced D1 claim and current authorization. */
export async function consumeOutbox(
  env: OutboxConsumerEnv,
  outboxId: string,
  deadline = Date.now() + 25_000,
  imageBudget: ImageReadBudget = { reads: 0, bytes: 0 },
  generationBudget: ImageGenerationBudget = { transforms: 0 },
): Promise<ConsumeResult> {
  const { DB: db } = env;
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 25_000)
    return "retry";
  if (!outboxId || outboxId.length > 128) return "retry";
  const row = await readOutboxEvent(db, outboxId);
  if (row?.kind === "media.requested") {
    if (!("CONTROL" in env) || !env.BLOBS) return "retry";
    return consumeMediaExtraction(
      { DB: db, CONTROL: env.CONTROL, BLOBS: env.BLOBS },
      outboxId,
      deadline,
      imageBudget,
    );
  }
  if (row?.kind === "image.requested") {
    if (!("CONTROL" in env) || !env.BLOBS || !env.IMAGES) return "retry";
    return consumeLargeThumbnail(
      { DB: db, CONTROL: env.CONTROL, BLOBS: env.BLOBS, IMAGES: env.IMAGES },
      outboxId,
      deadline,
      imageBudget,
      generationBudget,
    );
  }
  if (row?.kind === "copy.requested") {
    if (!("CONTROL" in env) || !env.BLOBS || !env.LOCKS) return "retry";
    return consumeCopyOutbox(
      { DB: db, CONTROL: env.CONTROL, BLOBS: env.BLOBS, LOCKS: env.LOCKS },
      outboxId,
      deadline,
    );
  }
  if (row?.state === "completed") return "completed";
  if (row?.state === "failed") return "failed";
  if (!row || !["dispatching", "sent"].includes(row.state)) return "retry";
  const authority = await nodeEventAuthority(db, row);
  if (!authority) return "retry";
  const token = crypto.randomUUID();
  const clock = "strftime('%s','now')*1000";
  try {
    const claim = await acquireSystemMutation(env, row.owner_id, "outbox.consume-claim", deadline);
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await commitSystemMutation(db, claim, row.owner_id, [
      ...authority,
      {
        sql: `UPDATE outbox SET claim_token=?,claim_expires_at=${clock}+?,updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND epoch=? AND state IN ('dispatching','sent')
            AND (claim_token IS NULL OR claim_expires_at<=${clock})
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
            AND EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.op_id=o.op_id
              WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch
                AND o.kind=? AND o.operands_json=? AND o.result_json=?
                AND s.kind='node'
                AND s.affected_id=outbox.payload_ref)`,
        values: [
          token,
          OUTBOX_CLAIM_LEASE_MS,
          outboxId,
          row.epoch,
          row.epoch,
          row.op_kind,
          row.operands_json,
          row.result_json,
        ],
      },
      assertOneChange,
    ]);
    const claimFence = assertExists(
      `SELECT 1 FROM outbox b JOIN control c ON c.singleton=1 AND c.epoch=b.epoch AND c.maintenance=0
       WHERE b.outbox_id=? AND b.claim_token=? AND b.claim_expires_at>${clock}
         AND b.epoch=? AND b.state IN ('dispatching','sent')`,
      [outboxId, token, row.epoch],
    );
    const metadata = await imageMetadataStatements(
      env,
      row,
      claimFence,
      authority,
      deadline,
      imageBudget,
    );
    let derivatives: readonly SqlStatement[] = [];
    if (metadata.source) {
      if (!("CONTROL" in env) || !env.BLOBS || !env.IMAGES)
        throw new Error("image_binding_unavailable");
      derivatives = await generateOutboxImages(
        { DB: db, CONTROL: env.CONTROL, BLOBS: env.BLOBS, IMAGES: env.IMAGES },
        { ...row, id: outboxId },
        metadata.source,
        token,
        deadline,
        generationBudget,
      );
    }
    const completion = await acquireSystemMutation(env, row.owner_id, "outbox.complete", deadline);
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await commitSystemMutation(db, completion, row.owner_id, [
      ...authority,
      claimFence,
      ...metadata.statements,
      ...derivatives,
      {
        sql: `UPDATE outbox SET state='completed',updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND claim_token=? AND claim_expires_at>${clock}
            AND epoch=? AND state IN ('dispatching','sent')
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
            AND EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.op_id=o.op_id
              WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch
                AND o.kind=? AND o.operands_json=? AND o.result_json=?
                AND s.kind='node'
                AND s.affected_id=outbox.payload_ref)`,
        values: [
          outboxId,
          token,
          row.epoch,
          row.epoch,
          row.op_kind,
          row.operands_json,
          row.result_json,
        ],
      },
      assertOneChange,
    ]);
    return "completed";
  } catch {
    // A lost D1 acknowledgement is safe to ack only when the terminal row is visible.
    return (await readOutboxEvent(db, outboxId))?.state === "completed" ? "completed" : "retry";
  }
}
