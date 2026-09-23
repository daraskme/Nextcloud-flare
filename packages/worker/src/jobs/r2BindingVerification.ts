import { assertExists, assertOneChange, atomicBatch, type SqlStatement } from "../db/primary";
import {
  BINDING_PROBE_BYTES,
  BINDING_PROBE_KEY,
  BINDING_PROBE_KIND,
  isProbeNonce,
} from "../r2/bindingProbe";
import type { InventorySource, R2S3Inventory } from "../r2/s3Inventory";
import { controlFence } from "./uploadCleanup";

const CLOCK = "strftime('%s','now')*1000";

export interface BindingVerification {
  readonly source: InventorySource;
  readonly verifiedAt: number;
  /** Describes this invocation only. Never accept this boolean as cleanup authority. */
  readonly bindingVerified: true;
}

/** Only usable inside withVerifiedR2Inventory; persist mutations in the same batch as fence(). */
export interface VerifiedR2Inventory {
  readonly bucket: R2Bucket;
  readonly inventory: R2S3Inventory;
  readonly observation: BindingVerification;
  fence(): SqlStatement;
  assertCurrent(): Promise<void>;
}

function validObject(object: R2Object): void {
  if (
    object.key !== BINDING_PROBE_KEY ||
    object.size !== BINDING_PROBE_BYTES ||
    object.customMetadata?.ncf_kind !== BINDING_PROBE_KIND ||
    !object.etag ||
    object.etag.length > 256 ||
    !object.version ||
    object.version.length > 256 ||
    !Number.isSafeInteger(object.uploaded.getTime()) ||
    object.uploaded.getTime() < 0
  )
    throw new Error("invalid_r2_binding_probe");
}

async function readCurrent(bucket: R2Bucket): Promise<R2ObjectBody | null> {
  const object = await bucket.get(BINDING_PROBE_KEY);
  if (!object) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    validObject(object);
    reader = object.body.getReader();
    const bytes = new Uint8Array(BINDING_PROBE_BYTES);
    let length = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > bytes.length)
        throw new Error("invalid_r2_binding_probe");
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
    if (length !== bytes.length || !isProbeNonce(new TextDecoder().decode(bytes)))
      throw new Error("invalid_r2_binding_probe");
    return object;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else void object.body.cancel().catch(() => {});
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    /^(?:invalid_r2_binding_probe|r2_binding_(?:mismatch|conflict|scope_closed)|s3_inventory_(?:http_\d{3}|timeout|body_limit|unavailable)|invalid_s3_inventory_xml)$/.test(
      error.message,
    )
    ? error.message
    : "r2_binding_verification_failed";
}

/**
 * Rotate a fresh 256-bit challenge through BLOBS, then read it through authenticated S3.
 * No cached proof, guessed bucket identity or caller boolean grants authority. Do not delete
 * the permanent probe: delayed initial conditional creates must continue to fail.
 */
export async function withVerifiedR2Inventory<T>(
  db: D1Database,
  bucket: R2Bucket,
  inventory: R2S3Inventory,
  epoch: number,
  action: (verified: VerifiedR2Inventory) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_s3_inventory_request");
  const token = crypto.randomUUID();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const source = JSON.stringify(inventory.source);
  const fence = (phase: string) =>
    assertExists(
      `SELECT 1 FROM r2_binding_probe p JOIN control c ON c.singleton=p.singleton
     WHERE p.singleton=1 AND p.epoch=? AND c.epoch=p.epoch AND c.maintenance=1 AND c.gc_paused=1
       AND p.lease_token=? AND p.lease_expires_at>${CLOCK} AND p.nonce=? AND p.source=? AND p.phase=?`,
      [epoch, token, nonce, source, phase],
    );
  const transition = async (from: string, sql: string, values: SqlStatement["values"] = []) => {
    await atomicBatch(db, [fence(from), { sql, values }, assertOneChange]);
  };
  const countCall = (phase: string) =>
    transition(phase, "UPDATE r2_binding_probe SET calls=calls+1 WHERE singleton=1");
  let active = false;
  try {
    // Unknown claim/counter ACK means no dispatch. Retry only after expiry, with a fresh nonce.
    await atomicBatch(db, [
      controlFence(epoch, true),
      {
        sql: `INSERT INTO r2_binding_probe(singleton,epoch,generation,source,nonce,phase,lease_token,lease_expires_at)
        VALUES(1,?,1,?,?,'claimed',?,${CLOCK}+60000)
        ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,generation=r2_binding_probe.generation+1,
          source=excluded.source,nonce=excluded.nonce,phase='claimed',expected_etag=NULL,
          r2_etag=NULL,r2_version=NULL,uploaded_at=NULL,verified_at=NULL,
          lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,last_error=NULL
        WHERE r2_binding_probe.lease_expires_at<=${CLOCK} AND r2_binding_probe.epoch<=excluded.epoch`,
        values: [epoch, source, nonce, token],
      },
      assertOneChange,
    ]);
    await countCall("claimed");
    const current = await readCurrent(bucket);
    await transition(
      "claimed",
      "UPDATE r2_binding_probe SET phase='prepared',expected_etag=? WHERE singleton=1",
      [current?.etag ?? null],
    );
    await countCall("prepared");
    const object = await bucket.put(BINDING_PROBE_KEY, nonce, {
      onlyIf: current ? { etagMatches: current.etag } : new Headers({ "If-None-Match": "*" }),
      customMetadata: { ncf_kind: BINDING_PROBE_KIND },
      httpMetadata: { contentType: "text/plain", cacheControl: "no-store" },
    });
    if (!object) throw new Error("r2_binding_conflict");
    validObject(object);
    await transition(
      "prepared",
      "UPDATE r2_binding_probe SET phase='written',r2_etag=?,r2_version=?,uploaded_at=? WHERE singleton=1",
      [object.etag, object.version, object.uploaded.getTime()],
    );
    await countCall("written");
    if ((await inventory.readBindingProbe()) !== nonce) throw new Error("r2_binding_mismatch");
    const verifiedAt = Date.now();
    await transition(
      "written",
      "UPDATE r2_binding_probe SET phase='verified',verified_at=? WHERE singleton=1",
      [verifiedAt],
    );
    active = true;
    const scopedFence = (): SqlStatement => {
      if (!active) throw new Error("r2_binding_scope_closed");
      return fence("verified");
    };
    const result = await action(
      Object.freeze({
        bucket,
        inventory,
        observation: Object.freeze({
          source: Object.freeze(inventory.source),
          verifiedAt,
          bindingVerified: true as const,
        }),
        fence: scopedFence,
        assertCurrent: async () => {
          await atomicBatch(db, [scopedFence()]);
        },
      }),
    );
    await transition(
      "verified",
      "UPDATE r2_binding_probe SET phase='idle',lease_token=NULL,lease_expires_at=0 WHERE singleton=1",
    );
    return result;
  } catch (error) {
    const code = errorCode(error);
    // Retain lease and allocation after every ambiguous write. A new CAS generation reconciles it.
    await db
      .prepare(`UPDATE r2_binding_probe SET phase='failed',last_error=?
      WHERE singleton=1 AND lease_token=? AND phase<>'idle'`)
      .bind(code, token)
      .run()
      .catch(() => {});
    throw new Error(code);
  } finally {
    active = false;
  }
}
