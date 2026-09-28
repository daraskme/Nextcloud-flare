import { assertExists, assertOneChange, atomicBatch } from "../db/primary";
import type { Env } from "../env";
import {
  acquireSystemMutation,
  type SystemMutationSource,
  systemMutationStatements,
} from "../services/systemMutation";
import {
  beginCopyClaimRead,
  COPY_EXECUTION_LIMITS,
  type CopyJobClaim,
  checkCopyClaim,
  copyAuthorityStatements,
  copyClaimFence,
} from "./copyClaim";

const CLOCK = "strftime('%s','now')*1000";
export interface CopySourceRange {
  readonly blobId: string;
  readonly offset: number;
  readonly length: number;
}

/** Bounded immutable source data, not a destination-write receipt or checkpoint advance. */
export async function readCopyJobRange(
  env: SystemMutationSource & Pick<Env, "BLOBS">,
  claim: CopyJobClaim,
  range: CopySourceRange,
): Promise<Uint8Array> {
  if (range.length > COPY_EXECUTION_LIMITS.rangeBytes) throw new Error("invalid_copy_range");
  const length = range.length;
  return withCopyJobRange(env, claim, range, async (body) => {
    const bytes = new Uint8Array(length),
      reader = body.getReader();
    let offset = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes.set(next.value, offset);
        offset += next.value.byteLength;
      }
      return bytes;
    } finally {
      reader.releaseLock();
    }
  });
}

/** Internal streaming transfer; the consumer must finish before the same authorization lease ends. */
export async function withCopyJobRange<T>(
  env: SystemMutationSource & Pick<Env, "BLOBS">,
  claim: CopyJobClaim,
  range: CopySourceRange,
  consume: (body: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  checkCopyClaim(claim);
  const { blobId, offset, length } = range;
  const blob = claim.plan.source.blobs.find((b) => b.id === blobId);
  // Keep one fixed node witness: never fall back to a broader grant or another alias after revocation.
  const witness = claim.plan.source.entries.find((n) => n.blobId === blobId);
  if (
    !blob ||
    !witness ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > COPY_EXECUTION_LIMITS.streamRangeBytes ||
    offset + length > blob.size ||
    (length === 0 && (blob.size !== 0 || offset !== 0))
  )
    throw new Error("invalid_copy_range");
  const hold = assertExists(
    `SELECT 1 FROM copy_job_blobs cb JOIN copy_job_manifests m ON m.job_id=cb.job_id
      JOIN blobs b ON b.id=cb.source_blob_id JOIN blob_storage s ON s.blob_id=b.id
      JOIN blob_pins p ON p.pin_id=cb.pin_id AND p.blob_id=b.id
      JOIN reservations r ON r.id=cb.reservation_id
    WHERE cb.job_id=? AND b.id=? AND b.owner_id=? AND b.r2_key=? AND b.size=?
      AND b.state IN ('committed','gc_candidate') AND s.bytes=b.size AND s.removed_at IS NULL AND s.r2_etag=?
      AND p.purpose='copy' AND p.expires_at=m.expires_at AND p.expires_at>${CLOCK}
      AND r.owner_id=? AND r.bytes=b.size AND r.state='reserved' AND r.epoch=?
      AND r.expires_at=m.expires_at AND r.share_id IS NULL AND r.op_id IS NULL`,
    [
      claim.id,
      blob.id,
      claim.plan.source.ownerId,
      blob.key,
      blob.size,
      blob.etag,
      claim.plan.destinationOwnerId,
      claim.epoch,
    ],
  );
  const local = beginCopyClaimRead(claim);
  let object: R2ObjectBody | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let delivery: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stopped = new AbortController();
  let rejectStop!: (error: unknown) => void;
  const stopPromise = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const stop = (reason: unknown) => {
    if (stopped.signal.aborted) return;
    stopped.abort(reason);
    rejectStop(reason);
    delivery?.error(reason);
    delivery = undefined;
    void reader?.cancel(reason).catch(() => undefined);
    if (!reader) void object?.body.cancel(reason).catch(() => undefined);
  };
  const gate = () => {
    stopped.signal.throwIfAborted();
    checkCopyClaim(claim);
  };
  const onAbort = () => stop(local.signal.reason);
  local.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => stop(new Error("copy_claim_expired")),
    Math.max(0, claim.expiresAt - Date.now()),
  );
  const work = async () => {
    gate();
    const authority = await copyAuthorityStatements(env.DB, claim.plan, witness.id);
    const admission = await acquireSystemMutation(
      env,
      claim.plan.destinationOwnerId,
      "copy.read",
      claim.expiresAt,
    );
    gate();
    // Count before dispatch; ambiguous batch ACKs consume budget but never authorize a GET.
    await atomicBatch(
      env.DB,
      systemMutationStatements(admission, claim.plan.destinationOwnerId, [
        copyClaimFence(claim),
        ...authority,
        hold,
        {
          sql: "UPDATE job_leases SET r2_calls=r2_calls+1 WHERE job_id=? AND claim_token=? AND r2_calls<?",
          values: [claim.id, claim.token, COPY_EXECUTION_LIMITS.invocationR2Calls],
        },
        assertOneChange,
        {
          sql: `UPDATE bulk_jobs SET r2_calls=r2_calls+1,updated_at=MAX(updated_at,${CLOCK}) WHERE id=? AND r2_calls<?`,
          values: [claim.id, COPY_EXECUTION_LIMITS.r2Calls],
        },
        assertOneChange,
      ]),
    );
    gate();
    if (Date.now() >= admission.expires_at) throw new Error("copy_dispatch_expired");
    const result = await env.BLOBS.get(blob.key, {
      onlyIf: { etagMatches: blob.etag },
      ...(length ? { range: { offset, length } } : {}),
    });
    if (result && "body" in result) object = result;
    gate();
    if (
      !object ||
      object.key !== blob.key ||
      object.etag !== blob.etag ||
      object.size !== blob.size ||
      (length > 0 &&
        (!object.range ||
          !("offset" in object.range) ||
          object.range.offset !== offset ||
          object.range.length !== length)) ||
      (length === 0 &&
        object.range !== undefined &&
        (!("offset" in object.range) || object.range.offset !== 0 || object.range.length !== 0))
    )
      throw new Error("copy_source_changed");
    reader = object.body.getReader();
    let received = 0;
    let completed = false;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          delivery = controller;
        },
        async pull(controller) {
          try {
            gate();
            const next = await reader!.read();
            gate();
            if (next.done) {
              if (received !== length) throw new Error("copy_source_length_mismatch");
              const finalAuthority = await copyAuthorityStatements(env.DB, claim.plan, witness.id);
              gate();
              await atomicBatch(env.DB, [copyClaimFence(claim), ...finalAuthority, hold]);
              gate();
              completed = true;
              delivery = undefined;
              controller.close();
            } else {
              if (received + next.value.byteLength > length)
                throw new Error("copy_source_length_mismatch");
              received += next.value.byteLength;
              controller.enqueue(next.value);
            }
          } catch (error) {
            stop(error);
          }
        },
        cancel(reason) {
          delivery = undefined;
          stop(reason ?? new Error("copy_read_cancelled"));
        },
      },
      { highWaterMark: 0 },
    );
    const consumed = await consume(body);
    gate();
    if (!completed) throw new Error("copy_source_not_consumed");
    return consumed;
  };
  try {
    return await Promise.race([
      work()
        .catch((error) => {
          stop(error);
          throw error;
        })
        .finally(() => {
          // A native GET can resolve after the caller's deadline; cancel that late body too.
          if (stopped.signal.aborted) {
            if (reader) void reader.cancel(stopped.signal.reason).catch(() => undefined);
            else void object?.body.cancel(stopped.signal.reason).catch(() => undefined);
          } else reader?.releaseLock();
          local.finish();
        }),
      stopPromise,
    ]);
  } catch (error) {
    stop(error);
    throw error;
  } finally {
    clearTimeout(timer);
    local.signal.removeEventListener("abort", onAbort);
  }
}
