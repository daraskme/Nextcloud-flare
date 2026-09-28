import {
  type ImageTransformGrant,
  imageGrantFromRow,
  imageTransformValues,
} from "../db/imageTransform";
import type { GlobalMutationAdmission } from "../db/mutationAdmission";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { globalMutationStatements } from "../services/globalMutation";
import { NativeHistory, nativeIdentity } from "./nativeHistory";

export function initializeImageSeals(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS control_image_derivative_seals(
    image_id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
    grant_json TEXT NOT NULL, output_json TEXT NOT NULL)`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS image_seal_immutable BEFORE UPDATE ON control_image_derivative_seals
    BEGIN SELECT RAISE(ABORT,'immutable_image_seal'); END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS image_seal_keep BEFORE DELETE ON control_image_derivative_seals
    BEGIN SELECT RAISE(ABORT,'image_seal_required'); END`);
}

/** A persistent seal forbids future dispatch, including after D1 rollback. */
export class ControlImageDerivatives {
  readonly #history: NativeHistory;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly current: (epoch: number) => void,
    private readonly admit: () => Promise<GlobalMutationAdmission>,
  ) {
    initializeImageSeals(storage.sql);
    this.#history = new NativeHistory(storage.sql);
  }

  #original(grant: ImageTransformGrant, outputJson: unknown) {
    const original = this.storage.sql
      .exec<{ grant_json: string; output_json: string; state: string }>(
        "SELECT grant_json,output_json,state FROM control_image_transforms WHERE id=?",
        grant.id,
      )
      .toArray()[0];
    if (
      !original ||
      original.state !== "succeeded" ||
      original.output_json !== outputJson ||
      JSON.stringify(imageTransformValues(JSON.parse(original.grant_json))) !==
        JSON.stringify(imageTransformValues(grant))
    )
      throw new Error("image_storage_history_missing");
    return original;
  }

  /** Read-only evidence for a new publication claim. Never a native dispatch grant. */
  async publicationProof(epoch: number, imageId: string) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !/^[a-f0-9-]{36}$/.test(imageId))
      throw new Error("invalid_image_publication");
    this.current(epoch);
    const row = await primary(this.db)
      .prepare(`SELECT t.*,x.write_attempt_id FROM image_transform_attempts t
      JOIN image_derivative_objects x ON x.id=t.id JOIN image_derivative_cleanup c ON c.image_id=x.id
      WHERE t.id=? AND t.state='succeeded' AND x.state IN ('stored','published') AND c.retired_at IS NULL`)
      .bind(imageId)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("image_publication_unproven");
    const grant = imageGrantFromRow(row);
    if (grant.epoch !== epoch) throw new Error("image_publication_unproven");
    const key = `u/${grant.ownerId}/d/${grant.blobId}/${grant.generator}/${grant.variant}/${grant.id}`;
    const writes = await primary(this.db)
      .prepare(`SELECT * FROM r2_write_attempts
      WHERE kind='image.put' AND state='succeeded' AND epoch=? AND owner_id=? AND r2_key=? AND source_ref=? LIMIT 2`)
      .bind(epoch, grant.ownerId, key, JSON.stringify([imageId, row.write_attempt_id]))
      .all<Record<string, unknown>>();
    if (writes.results.length !== 1) throw new Error("image_publication_unproven");
    const w = writes.results[0]!;
    const identity = await nativeIdentity("r2", [
      w.id,
      w.token,
      w.epoch,
      w.owner_id,
      w.kind,
      w.r2_key,
      w.dispatch_before,
      w.started_at,
      w.source_ref,
    ]);
    this.current(epoch);
    const original = this.#original(grant, row.output_json),
      proof = this.#history.find(identity);
    if (proof?.outcome !== "succeeded" || proof.deadline !== w.dispatch_before)
      throw new Error("image_storage_history_missing");
    const sql = this.storage.sql;
    // Keep these independent checks after the final await, including after D1 rollback.
    if (
      sql
        .exec(
          "SELECT 1 FROM control_image_derivative_seals WHERE image_id=? OR r2_key=?",
          imageId,
          key,
        )
        .toArray().length
    )
      throw new Error("image_derivative_retired");
    if (
      sql
        .exec(
          "SELECT 1 FROM control_r2_write_receipts WHERE state='pending' AND json_extract(grant_json,'$.key')=? LIMIT 1",
          key,
        )
        .toArray().length
    )
      throw new Error("image_storage_unsettled");
    return {
      imageId,
      key,
      outputJson: original.output_json,
      writeId: w.id as string,
      writeToken: w.token as string,
    };
  }

  async seal(epoch: number, imageId: string) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !/^[a-f0-9-]{36}$/.test(imageId))
      throw new Error("invalid_image_seal");
    this.current(epoch);
    const row = await primary(this.db)
      .prepare(`SELECT t.*,b.r2_key FROM image_transform_attempts t
        JOIN image_derivative_objects x ON x.id=t.id JOIN blobs b ON b.id=x.output_blob_id
        JOIN image_derivative_cleanup c ON c.image_id=x.id
        WHERE t.id=? AND t.state='succeeded' AND c.retired_at IS NOT NULL`)
      .bind(imageId)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("image_seal_unavailable");
    const grant = imageGrantFromRow(row);
    const key = `u/${grant.ownerId}/d/${grant.blobId}/${grant.generator}/${grant.variant}/${grant.id}`;
    if (row.r2_key !== key || grant.epoch > epoch) throw new Error("image_seal_unavailable");
    this.current(epoch);
    const sql = this.storage.sql;
    // The image receipt predates every permitted writer. Missing independent history is unknown.
    const original = this.#original(grant, row.output_json);
    const token = this.storage.transactionSync(() => {
      if (
        sql
          .exec(
            `SELECT 1 FROM control_r2_write_receipts
          WHERE state='pending' AND json_extract(grant_json,'$.key')=? LIMIT 1`,
            key,
          )
          .toArray().length
      )
        throw new Error("image_storage_unsettled");
      sql.exec(
        "INSERT OR IGNORE INTO control_image_derivative_seals VALUES(?,?,?,?,?)",
        imageId,
        key,
        crypto.randomUUID(),
        original.grant_json,
        original.output_json,
      );
      const saved = sql
        .exec<{ token: string; r2_key: string; grant_json: string; output_json: string }>(
          "SELECT * FROM control_image_derivative_seals WHERE image_id=?",
          imageId,
        )
        .toArray()[0];
      if (
        !saved ||
        saved.r2_key !== key ||
        saved.grant_json !== original.grant_json ||
        saved.output_json !== original.output_json
      )
        throw new Error("image_seal_conflict");
      return saved.token;
    });
    const admission = await this.admit();
    this.current(epoch);
    try {
      await atomicBatch(
        this.db,
        globalMutationStatements(admission, [
          assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=?", [epoch]),
          assertExists(
            `SELECT 1 FROM image_transform_attempts WHERE id=? AND token=? AND output_json=?`,
            [imageId, grant.token, original.output_json],
          ),
          assertExists(
            "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')",
            [key],
          ),
          {
            sql: "UPDATE image_derivative_cleanup SET seal_token=? WHERE image_id=? AND retired_at IS NOT NULL AND settled_at IS NULL AND (seal_token IS NULL OR seal_token=?)",
            values: [token, imageId, token],
          },
          assertOneChange,
        ]),
      );
    } catch (error) {
      if (
        !(await primary(this.db)
          .prepare(
            "SELECT 1 FROM image_derivative_cleanup WHERE image_id=? AND seal_token=? AND retired_at IS NOT NULL",
          )
          .bind(imageId, token)
          .first())
      )
        throw error;
    }
    this.current(epoch);
    return { token, key };
  }
}
