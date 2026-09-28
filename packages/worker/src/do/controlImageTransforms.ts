import {
  confirmImageTransform,
  IMAGE_TRANSFORM_IDENTITY,
  type ImageTransformGrant,
  type ImageTransformReceipt,
  type ImageTransformRequest,
  type ImageTransformTerminal,
  imageGrantFromRow,
  imageOutputJson,
  imageTransformAuthority,
  imageTransformValues,
  insertImageTransform,
  validateImageTransform,
  validateImageTransformGrant,
} from "../db/imageTransform";
import type {
  GlobalMutationAdmission,
  MutationAdmission,
  MutationRequest,
} from "../db/mutationAdmission";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { accountMutationStatements } from "../services/accountMutation";
import { globalMutationStatements } from "../services/globalMutation";

export const IMAGE_COST_RECORD_LIMIT = 1_000_000;
interface Receipt extends Record<string, SqlStorageValue> {
  id: string;
  grant_json: string;
  state: "pending" | ImageTransformTerminal;
  output_json: string | null;
  mirrored: number;
}
const HELD = "state='pending' OR mirrored=0";
const digest = (value: unknown) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
const sameGrant = (encoded: string, grant: ImageTransformGrant) =>
  JSON.stringify(imageTransformValues(JSON.parse(encoded))) ===
  JSON.stringify(imageTransformValues(grant));

/** Independent of D1 rollback. No age/lease expiry removes a paid or unknown transform. */
export class ControlImageTransforms {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly current: (epoch: number) => void,
    private readonly admit: (request: MutationRequest) => Promise<MutationAdmission>,
    private readonly settleAdmit: () => Promise<GlobalMutationAdmission>,
  ) {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS control_image_transforms(
      id TEXT PRIMARY KEY,identity BLOB NOT NULL UNIQUE CHECK(length(identity)=32),
      cost_key BLOB NOT NULL CHECK(length(cost_key)=32),grant_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')),
      output_json TEXT,mirrored INTEGER NOT NULL CHECK(mirrored IN (0,1)),
      CHECK((state='succeeded')=(output_json IS NOT NULL)),CHECK(state<>'pending' OR mirrored=0))`);
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS control_image_cost ON control_image_transforms(cost_key) WHERE state<>'not_started'",
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS control_image_held ON control_image_transforms(id) WHERE ${HELD}`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS control_image_transform_usage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      entries INTEGER NOT NULL CHECK(entries>=0 AND entries<=${IMAGE_COST_RECORD_LIMIT}))`);
    sql.exec("INSERT OR IGNORE INTO control_image_transform_usage VALUES(1,0)");
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_image_limit BEFORE INSERT ON control_image_transforms
      WHEN (SELECT COUNT(*) FROM control_image_transforms WHERE ${HELD})>=8
      BEGIN SELECT RAISE(ABORT,'image_transform_capacity'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_image_usage AFTER INSERT ON control_image_transforms
      BEGIN UPDATE control_image_transform_usage SET entries=entries+1 WHERE singleton=1; END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_image_immutable BEFORE UPDATE ON control_image_transforms
      WHEN NEW.id IS NOT OLD.id OR NEW.identity IS NOT OLD.identity OR NEW.cost_key IS NOT OLD.cost_key
        OR NEW.grant_json IS NOT OLD.grant_json OR NEW.state='pending'
        OR (OLD.state<>'pending' AND (NEW.state IS NOT OLD.state OR NEW.output_json IS NOT OLD.output_json))
        OR NEW.mirrored<OLD.mirrored
      BEGIN SELECT RAISE(ABORT,'immutable_image_transform_receipt'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_image_keep BEFORE DELETE ON control_image_transforms
      BEGIN SELECT RAISE(ABORT,'image_transform_cost_required'); END`);
  }
  private get sql() {
    return this.storage.sql;
  }
  #row(id: string) {
    return this.sql
      .exec<Receipt>("SELECT * FROM control_image_transforms WHERE id=?", id)
      .toArray()[0];
  }
  assertEmpty() {
    if (
      this.sql.exec(`SELECT 1 FROM control_image_transforms WHERE ${HELD} LIMIT 1`).toArray().length
    )
      throw new Error("image_transform_unsettled");
  }
  async begin(input: ImageTransformRequest): Promise<ImageTransformGrant> {
    validateImageTransform(input);
    const startedAt = Date.now();
    if (
      input.deadline <= startedAt ||
      input.deadline > startedAt + 5000 ||
      input.expiresAt > startedAt + 25000
    )
      throw new Error("image_transform_unavailable");
    this.current(input.epoch);
    const grant: ImageTransformGrant = {
      ...structuredClone(input),
      startedAt,
      token: crypto.randomUUID(),
    };
    const identity = await digest(["image-transform-v1", ...imageTransformValues(grant)]);
    const cost = await digest([
      "image-cost-v1",
      grant.ownerId,
      grant.blobId,
      grant.variant,
      grant.generator,
    ]);
    this.current(grant.epoch);
    if (Date.now() >= grant.deadline) throw new Error("image_transform_unavailable");
    // Unique cost and all completion evidence live outside the database being backed up/restored.
    this.sql.exec(
      "INSERT INTO control_image_transforms VALUES(?,?,?,?,'pending',NULL,0)",
      grant.id,
      identity,
      cost,
      JSON.stringify(grant),
    );
    try {
      const authority = await imageTransformAuthority(this.db, grant);
      const spaceId = await primary(this.db)
        .prepare("SELECT id FROM spaces WHERE owner_id=?")
        .bind(grant.ownerId)
        .first<string>("id");
      if (!spaceId) throw new Error("image_transform_unavailable");
      const admission = await this.admit({
        permitId: `images.transform:${grant.id}`,
        spaceId,
        epoch: grant.epoch,
        deadline: grant.deadline,
      });
      this.current(grant.epoch);
      if (Date.now() >= grant.deadline) throw new Error("image_transform_unavailable");
      await atomicBatch(
        this.db,
        accountMutationStatements(admission, grant.ownerId, [
          ...authority,
          insertImageTransform(grant, "pending", null),
          assertOneChange,
        ]),
      );
      this.current(grant.epoch);
      if (Date.now() >= grant.deadline || this.#row(grant.id)?.state !== "pending")
        throw new Error("image_transform_unavailable");
      return grant;
    } catch (error) {
      // The grant has not left this method, so native dispatch is impossible.
      try {
        await this.finish(grant, "not_started", null);
      } catch {
        /* Retain the terminal proof for repair. */
      }
      throw error;
    }
  }
  async finish(
    grant: ImageTransformGrant,
    state: ImageTransformTerminal,
    output: ImageTransformReceipt | null,
  ) {
    validateImageTransformGrant(grant);
    if (
      !["succeeded", "not_started"].includes(state) ||
      (state === "succeeded") !== (output !== null)
    )
      throw new Error("invalid_image_transform_outcome");
    const encoded = imageOutputJson(grant, output),
      saved = this.#row(grant.id);
    if (
      !saved ||
      !sameGrant(saved.grant_json, grant) ||
      (saved.state !== "pending" && (saved.state !== state || saved.output_json !== encoded))
    )
      throw new Error("image_transform_receipt_conflict");
    if (saved.state === "pending")
      this.sql.exec(
        "UPDATE control_image_transforms SET state=?,output_json=? WHERE id=? AND state='pending'",
        state,
        encoded,
        grant.id,
      );
    await this.#reconcile(grant, state, encoded);
  }
  async #reconcile(
    grant: ImageTransformGrant,
    state: ImageTransformTerminal,
    output: string | null,
    current: () => void = () => {},
  ) {
    current();
    try {
      const admission = await this.settleAdmit(),
        insert = insertImageTransform(grant, state, output);
      current();
      await atomicBatch(
        this.db,
        globalMutationStatements(admission, [
          {
            sql: `UPDATE image_transform_attempts SET state=?,output_json=?,finished_at=MAX(started_at,strftime('%s','now')*1000)
          WHERE ${IMAGE_TRANSFORM_IDENTITY} AND state='pending'`,
            values: [state, output, ...imageTransformValues(grant)],
          },
          { ...insert, sql: insert.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") },
          assertExists(
            `SELECT 1 FROM image_transform_attempts WHERE ${IMAGE_TRANSFORM_IDENTITY} AND state=? AND output_json IS ?`,
            [...imageTransformValues(grant), state, output],
          ),
        ]),
      );
    } catch {
      /* Read back an exact terminal fact after an ambiguous commit. */
    }
    current();
    if (!(await confirmImageTransform(this.db, grant, state, output)))
      throw new Error("image_transform_unsettled");
    current();
    const row = this.#row(grant.id);
    if (
      !row ||
      !sameGrant(row.grant_json, grant) ||
      row.state !== state ||
      row.output_json !== output
    )
      throw new Error("image_transform_receipt_conflict");
    this.sql.exec(
      "UPDATE control_image_transforms SET mirrored=1 WHERE id=? AND mirrored=0 AND state<>'pending'",
      grant.id,
    );
  }
  async repair(limit = 20, current: () => void = () => {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error("invalid_image_transform_limit");
    current();
    const local = this.sql
      .exec<Receipt>(
        "SELECT * FROM control_image_transforms WHERE mirrored=0 AND state<>'pending' ORDER BY id LIMIT ?",
        limit,
      )
      .toArray();
    let checked = 0,
      reconciled = 0;
    for (const row of local) {
      current();
      checked++;
      try {
        await this.#reconcile(
          JSON.parse(row.grant_json),
          row.state as ImageTransformTerminal,
          row.output_json,
          current,
        );
        reconciled++;
      } catch {
        current();
      }
    }
    const pending = await primary(this.db)
      .prepare("SELECT * FROM image_transform_attempts WHERE state='pending' ORDER BY id LIMIT ?")
      .bind(limit - checked)
      .all<Record<string, unknown>>();
    current();
    for (const row of pending.results) {
      checked++;
      const grant = imageGrantFromRow(row),
        identity = await digest(["image-transform-v1", ...imageTransformValues(grant)]);
      current();
      const receipt = this.sql
        .exec<Receipt>(
          "SELECT * FROM control_image_transforms WHERE id=? AND identity=? AND state<>'pending'",
          grant.id,
          identity,
        )
        .toArray()[0];
      if (!receipt) continue;
      try {
        await this.#reconcile(
          grant,
          receipt.state as ImageTransformTerminal,
          receipt.output_json,
          current,
        );
        reconciled++;
      } catch {
        current();
      }
    }
    const held = this.sql
      .exec<Receipt>(`SELECT * FROM control_image_transforms WHERE ${HELD}`)
      .toArray();
    return {
      checked,
      reconciled,
      pending: held.length,
      unknown: held.filter((r) => r.state === "pending").length,
    };
  }
}
