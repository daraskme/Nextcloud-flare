import {
  IMAGE_TRANSFORM_IDENTITY,
  imageGrantFromRow,
  imageTransformValues,
} from "../db/imageTransform";
import { assertExists, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { imageFailureJson } from "../media/images/failure";
import { openImageObject } from "../media/images/objectStream";
import {
  AUDIO_COVER_GENERATOR,
  IMAGE_TRANSFORM_GENERATOR,
  type ImageTransformPlan,
  ImageTransformUnsupported,
  type ImageVariant,
  planInspectedImage,
  transformImage,
} from "../media/images/transform";
import { hex } from "../platform/stream";
import { trackedImageTransform } from "../services/imageTransform";
import { resumeImageDerivative, storeImageDerivative } from "./imageDerivative";
import type { PreparedImageMetadata } from "./imageMetadata";
import type { EventRow } from "./outboxAuthority";

/** Shared by the entire Queue invocation: at most two paid attempts and two 20MB inputs. */
export interface ImageGenerationBudget {
  transforms: number;
}

/** Return terminal result fences for the same metadata/outbox completion transaction. */
export async function generateOutboxImages(
  env: Pick<Env, "DB" | "CONTROL" | "BLOBS" | "IMAGES">,
  event: EventRow & { id: string },
  source: NonNullable<PreparedImageMetadata["source"]>,
  claimToken: string,
  deadline: number,
  budget: ImageGenerationBudget,
  variants: readonly ImageVariant[] = ["sm", "md"],
): Promise<readonly SqlStatement[]> {
  const { node, image, guard, cover } = source;
  const generator = cover ? AUDIO_COVER_GENERATOR : IMAGE_TRANSFORM_GENERATOR;
  const kind = cover ? "cover" : "thumbnail";
  const statements: SqlStatement[] = [];
  const cost = (variant: ImageVariant) =>
    primary(env.DB)
      .prepare(`SELECT * FROM image_transform_attempts
        WHERE blob_id=? AND variant=? AND generator_version=? AND state<>'not_started'`)
      .bind(node.blob, variant, generator)
      .first<Record<string, unknown>>();
  const failedResult = (variant: ImageVariant, id: string, code: string, attempts: number) => {
    statements.push(
      {
        sql: `INSERT INTO derivative_results(id,blob_id,kind,variant,generator_version,state,
          claim_token,claim_expires_at,epoch,attempts,error_code)
          VALUES(?,?,'${kind}',?,?,'failed',?,?,?,?,?)
          ON CONFLICT(kind,blob_id,variant,generator_version) DO NOTHING`,
        values: [
          id,
          node.blob,
          variant,
          generator,
          claimToken,
          deadline,
          event.epoch,
          attempts,
          code,
        ],
      },
      assertExists(
        `SELECT 1 FROM derivative_results d WHERE id=? AND blob_id=? AND kind='${kind}'
          AND variant=? AND generator_version=? AND state='failed' AND error_code=? AND attempts=?
          AND r2_key IS NULL AND size IS NULL AND epoch=?
          AND NOT EXISTS(SELECT 1 FROM image_derivative_objects WHERE result_id=d.id)`,
        [id, node.blob, variant, generator, code, attempts, event.epoch],
      ),
    );
  };
  const knownFailure = (row: Record<string, unknown>, variant: ImageVariant) => {
    const grant = imageGrantFromRow(row);
    if (
      grant.epoch !== event.epoch ||
      grant.outboxId !== event.id ||
      grant.ownerId !== event.owner_id ||
      grant.blobId !== node.blob ||
      grant.source.nodeId !== node.id ||
      grant.source.parentId !== node.parent ||
      grant.source.key !== node.key ||
      grant.source.etag !== node.etag ||
      grant.source.size !== node.size ||
      JSON.stringify(grant.source.cover ?? null) !==
        JSON.stringify(cover ? { bytes: cover.bytes.length, sha256: cover.sha256 } : null)
    )
      throw new Error("image_job_conflict");
    const failure = JSON.parse(row.failure_json as string);
    if (imageFailureJson(failure) !== row.failure_json) throw new Error("image_job_conflict");
    statements.push(
      assertExists(
        `SELECT 1 FROM image_transform_attempts WHERE ${IMAGE_TRANSFORM_IDENTITY} AND state='failed' AND failure_json=?`,
        [...imageTransformValues(grant), row.failure_json as string],
      ),
    );
    failedResult(
      variant,
      "image_" + grant.id,
      image.mime === "image/avif" && failure.kind === "binding_rejected"
        ? "image_unsupported_binding"
        : "image_transform_failed",
      1,
    );
  };
  for (const variant of variants) {
    await guard();
    if (Date.now() >= deadline) throw new Error("image_job_deadline");
    let prior = await cost(variant);
    if (prior?.state === "failed") {
      knownFailure(prior, variant);
      continue;
    }
    if (prior && prior.state !== "succeeded") throw new Error("image_job_unsettled");
    if (prior) {
      await resumeImageDerivative(env, {
        imageId: prior.id as string,
        outboxId: event.id,
        epoch: event.epoch,
        claimToken,
        expiresAt: deadline,
      });
    } else {
      let plan: ImageTransformPlan;
      try {
        plan = {
          ...planInspectedImage(image, cover?.bytes.length ?? node.size, variant),
          generator,
        };
      } catch (error) {
        if (!(error instanceof ImageTransformUnsupported)) throw error;
        statements.push(
          assertExists(
            `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM image_transform_attempts
            WHERE blob_id=? AND variant=? AND generator_version=? AND state<>'not_started')`,
            [node.blob, variant, generator],
          ),
        );
        failedResult(
          variant,
          `image_skip_${cover ? "cover_" : ""}${node.blob}_${variant}`,
          "image_unsupported_" + error.reason,
          0,
        );
        continue;
      }
      if (
        !Number.isSafeInteger(budget.transforms) ||
        budget.transforms < 0 ||
        budget.transforms >= 2
      )
        throw new Error("image_invocation_budget_exceeded");
      budget.transforms++;
      let output;
      let input: ReadableStream<Uint8Array> | undefined;
      try {
        output = await trackedImageTransform(
          env,
          {
            epoch: event.epoch,
            ownerId: event.owner_id,
            blobId: node.blob,
            outboxId: event.id,
            claimToken,
            variant,
            generator,
            expiresAt: deadline,
            source: {
              nodeId: node.id,
              parentId: node.parent,
              key: node.key,
              etag: node.etag,
              size: node.size,
              width: plan.width,
              height: plan.height,
              ...(cover ? { cover: { bytes: cover.bytes.length, sha256: cover.sha256 } } : {}),
            },
          },
          async (signal, failure) => {
            return transformImage(env.IMAGES, plan, input!, signal, failure);
          },
          async (signal) => {
            // No Images invocation can occur here. A failed GET/authority check is not_started.
            if (cover) {
              await guard();
              signal.throwIfAborted();
              if (
                cover.bytes.length !== plan.sourceBytes ||
                hex(await crypto.subtle.digest("SHA-256", new Uint8Array(cover.bytes))) !==
                  cover.sha256
              )
                throw new Error("image_cover_mismatch");
              signal.throwIfAborted();
              input = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(cover.bytes);
                  controller.close();
                },
              });
            } else input = await openImageObject(env.BLOBS, node, signal, guard);
          },
        );
      } catch (error) {
        prior = await cost(variant);
        if (prior?.state !== "failed") throw error;
        knownFailure(prior, variant);
        continue;
      } finally {
        // Admission/dispatch may fail after a successful GET but before taking its stream.
        await input?.cancel().catch(() => undefined);
      }
      prior = await cost(variant);
      if (!prior || prior.state !== "succeeded" || prior.claim_token !== claimToken)
        throw new Error("image_job_unsettled");
      await storeImageDerivative(env, prior.id as string, output);
    }
    // Cleanup or source revocation can race with the final metadata/outbox batch.
    statements.push(
      assertExists(
        `SELECT 1 FROM image_derivative_objects x JOIN derivative_results d ON d.id=x.result_id
        JOIN image_derivative_cleanup c ON c.image_id=x.id
        WHERE x.id=? AND x.source_blob_id=? AND x.state='published' AND c.retired_at IS NULL
          AND d.state='ready' AND d.kind='${kind}' AND d.blob_id=? AND d.variant=? AND d.generator_version=?`,
        [prior.id as string, node.blob, node.blob, variant, generator],
      ),
    );
  }
  return statements;
}
