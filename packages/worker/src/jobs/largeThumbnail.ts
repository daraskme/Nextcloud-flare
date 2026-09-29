import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { Env } from "../env";
import { inspectImage } from "../media/images/inspect";
import { type ImageReadBudget, imageObjectSource } from "../media/images/r2Source";
import { AUDIO_COVER_GENERATOR } from "../media/images/transform";
import { TRACK_METADATA_LIMITS } from "../media/tracks/common";
import { inspectTracks } from "../media/tracks/inspect";
import { acquireSystemMutation, commitSystemMutation } from "../services/systemMutation";
import { inspectAudioCover } from "./audioCover";
import type { ImageNode, PreparedImageMetadata } from "./imageMetadata";
import { generateOutboxImages, type ImageGenerationBudget } from "./imageQueue";
import {
  imageRequestAuthority,
  imageRequestOperands,
  imageRequestSpec,
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
      spec = imageRequestSpec(o.variant),
      values = [o.nodeId, o.parentId, o.blobId, row.owner_id, spec.metadata];
    const node = await primary(env.DB)
      .prepare(spec.source)
      .bind(...values)
      .first<ImageNode & { etag: string }>();
    if (!node?.etag) throw new Error("image_source_unavailable");
    const source = assertExists(spec.source + " AND b.r2_key=?6 AND b.size=?7 AND s.r2_etag=?8", [
      ...values,
      node.key,
      node.size,
      node.etag,
    ]);
    const guard = async () => {
      await atomicBatch(env.DB, [...authority, claim, source]);
    };
    await guard();
    const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
    let prepared: PreparedImageMetadata["source"],
      terminal: readonly SqlStatement[] = [];
    if (o.variant === "sm") {
      const track = await inspectTracks(
        imageObjectSource(env.BLOBS, node, signal, guard, budget, TRACK_METADATA_LIMITS),
      );
      const artwork = await inspectAudioCover(track);
      if (artwork) prepared = { node, guard, ...artwork };
      else
        terminal = missingCover(
          node.blob,
          token,
          deadline,
          row.epoch,
          !track || track.media.kind !== "audio"
            ? "image_unsupported_audio"
            : !["mp3", "flac", "ogg", "mp4"].includes(track.media.container)
              ? "image_unsupported_cover_container"
              : track.cover
                ? "image_unsupported_format"
                : "image_cover_absent",
        );
    } else {
      const image = await inspectImage(imageObjectSource(env.BLOBS, node, signal, guard, budget));
      if (!image) throw new Error("image_source_unavailable");
      prepared = { node, image, guard };
    }
    signal.throwIfAborted();
    if (prepared)
      terminal = await generateOutboxImages(
        env,
        { ...row, id: outboxId },
        prepared,
        token,
        deadline,
        generation,
        spec.variants,
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

/** No-image results are durable too, so reloads and COW aliases never rescan an immutable original. */
function missingCover(
  blobId: string,
  claim: string,
  deadline: number,
  epoch: number,
  code: string,
): SqlStatement[] {
  return ["sm", "md"].flatMap((variant) => {
    const id = `image_skip_cover_${blobId}_${variant}`;
    return [
      assertExists(
        "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM image_transform_attempts WHERE blob_id=? AND variant=? AND generator_version=? AND state<>'not_started')",
        [blobId, variant, AUDIO_COVER_GENERATOR],
      ),
      {
        sql: `INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,claim_token,claim_expires_at,epoch,attempts,error_code)
        VALUES(?,?,'cover',?,?,'failed',?,?,?,0,?) ON CONFLICT(kind,blob_id,variant,generator_version) DO NOTHING`,
        values: [id, blobId, variant, AUDIO_COVER_GENERATOR, claim, deadline, epoch, code],
      },
      assertExists(
        "SELECT 1 FROM derivative_results d WHERE id=? AND kind='cover' AND blob_id=? AND variant=? AND generator_version=? AND state='failed' AND attempts=0 AND error_code=? AND epoch=? AND size IS NULL AND r2_key IS NULL AND NOT EXISTS(SELECT 1 FROM image_derivative_objects WHERE result_id=d.id)",
        [id, blobId, variant, AUDIO_COVER_GENERATOR, code, epoch],
      ),
    ];
  });
}
