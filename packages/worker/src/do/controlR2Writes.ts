import type {
  GlobalMutationAdmission,
  MutationAdmission,
  MutationRequest,
} from "../db/mutationAdmission";
import { assertExists, assertOneChange, atomicBatch, primary } from "../db/primary";
import { abortWriteProof, isAbortWrite } from "../db/r2Abort";
import { probeWriteProof } from "../db/r2Probe";
import { isUploadWrite, uploadWriteProof } from "../db/r2Upload";
import {
  insertR2Write,
  R2_WRITE_IDENTITY,
  type R2WriteGrant,
  type R2WriteKind,
  type R2WriteRequest,
  type R2WriteTerminal,
  r2WriteValues,
  validateR2Write,
  validateR2WriteGrant,
} from "../db/r2Write";
import { gcDispatchFence } from "../jobs/gc";
import { ORPHAN_GRACE_MS, objectFence } from "../jobs/orphanInventory";
import { accountMutationStatements } from "../services/accountMutation";
import { globalMutationStatements } from "../services/globalMutation";

interface Receipt extends Record<string, SqlStorageValue> {
  id: string;
  token: string;
  grant_json: string;
  state: "pending" | R2WriteTerminal;
}

/** The trusted Worker reports only actual native success or its own never-dispatched grant. */
export class ControlR2Writes {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly db: D1Database,
    private readonly current: (epoch: number, kind: R2WriteKind) => void,
    private readonly admit: (request: MutationRequest) => Promise<MutationAdmission>,
    private readonly settleAdmit: () => Promise<GlobalMutationAdmission>,
    private readonly globalAdmit: (
      epoch: number,
      deadline: number,
      kind:
        | "manifest.delete"
        | "blob.delete"
        | "orphan.delete"
        | "multipart.abort"
        | "bucket.abort"
        | "probe.put",
    ) => Promise<GlobalMutationAdmission>,
  ) {
    const sql = storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS control_r2_write_used(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)`,
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS control_r2_write_used_expiry ON control_r2_write_used(expires_at)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS control_r2_write_receipts(
      id TEXT PRIMARY KEY,token TEXT NOT NULL UNIQUE,grant_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','succeeded','not_started')))`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_r2_write_limit BEFORE INSERT ON control_r2_write_receipts
      WHEN (SELECT COUNT(*) FROM control_r2_write_receipts)>=32 OR EXISTS(SELECT 1 FROM control_r2_write_used WHERE id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'r2_write_capacity'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_r2_write_immutable BEFORE UPDATE ON control_r2_write_receipts
      WHEN OLD.state<>'pending' OR NEW.state='pending' OR NEW.id IS NOT OLD.id
      OR NEW.token IS NOT OLD.token OR NEW.grant_json IS NOT OLD.grant_json
      BEGIN SELECT RAISE(ABORT,'immutable_r2_write_receipt'); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS control_r2_write_delete BEFORE DELETE ON control_r2_write_receipts
      WHEN OLD.state='pending' BEGIN SELECT RAISE(ABORT,'r2_write_completion_required'); END`);
  }

  private get sql() {
    return this.storage.sql;
  }

  assertEmpty(): void {
    if (this.sql.exec("SELECT 1 FROM control_r2_write_receipts LIMIT 1").toArray().length)
      throw new Error("recovery_r2_write_unsettled");
  }

  #row(id: string): Receipt | undefined {
    return this.sql
      .exec<Receipt>("SELECT * FROM control_r2_write_receipts WHERE id=?", id)
      .toArray()[0];
  }

  async begin(input: R2WriteRequest): Promise<R2WriteGrant> {
    validateR2Write(input);
    const { id, epoch, ownerId, kind, key, deadline } = input;
    const startedAt = Date.now();
    if (deadline <= startedAt || deadline > startedAt + 5000)
      throw new Error("r2_write_unavailable");
    this.current(epoch, kind);
    this.sql.exec(
      "DELETE FROM control_r2_write_used WHERE id IN (SELECT id FROM control_r2_write_used WHERE expires_at<=? ORDER BY expires_at LIMIT 32)",
      startedAt,
    );
    const grant: R2WriteGrant = {
      id,
      epoch,
      ownerId,
      kind,
      key,
      deadline,
      startedAt,
      token: crypto.randomUUID(),
      ...(input.gc ? { gc: input.gc } : {}),
      ...(input.upload ? { upload: input.upload } : {}),
      ...(input.abort ? { abort: input.abort } : {}),
      ...(input.probe ? { probe: input.probe } : {}),
    };
    // Never replay a grant. Even a lost RPC reply can have reached the caller.
    const saved = this.sql.exec(
      "INSERT INTO control_r2_write_receipts VALUES(?,?,?,'pending') RETURNING id",
      id,
      grant.token,
      JSON.stringify(grant),
    );
    if (saved.toArray().length !== 1) throw new Error("r2_write_unavailable");
    try {
      const statements = [insertR2Write(grant, "pending"), assertOneChange];
      if (
        kind === "manifest.delete" ||
        kind === "blob.delete" ||
        kind === "orphan.delete" ||
        isAbortWrite(kind) ||
        kind === "probe.put"
      ) {
        const admission = await this.globalAdmit(epoch, deadline, kind);
        this.current(epoch, kind);
        if (Date.now() < startedAt || Date.now() >= deadline)
          throw new Error("r2_write_unavailable");
        const guards =
          kind === "probe.put"
            ? probeWriteProof(grant)
            : isAbortWrite(kind)
              ? await abortWriteProof(this.db, grant)
              : kind === "manifest.delete"
                ? [
                    assertExists(
                      `SELECT 1 FROM r2_write_attempts WHERE owner_id=? AND r2_key=? AND kind='manifest.put' AND state='succeeded'
            AND NOT EXISTS(SELECT 1 FROM target_sets WHERE manifest_ref=?)
            AND NOT EXISTS(SELECT 1 FROM r2_write_attempts WHERE r2_key=? AND state='pending')`,
                      [ownerId, key, key, key],
                    ),
                  ]
                : kind === "blob.delete"
                  ? [
                      gcDispatchFence(
                        {
                          blobId: input.gc!.blobId!,
                          ownerId: ownerId!,
                          key,
                          state: "deleting",
                        },
                        input.gc!.claimToken,
                        epoch,
                        input.gc!.mode,
                        deadline,
                      ),
                    ]
                  : [
                      assertExists(
                        "SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=? AND gc_paused=?",
                        [epoch, input.gc!.mode ? 1 : 0, input.gc!.mode ? 1 : 0],
                      ),
                      assertExists(
                        "SELECT 1 FROM orphan_objects WHERE r2_key=? AND owner_key IS NOT NULL AND epoch<=? AND first_seen_at<=strftime('%s','now')*1000-?",
                        [key, epoch, ORPHAN_GRACE_MS],
                      ),
                      assertExists(
                        "SELECT 1 FROM orphan_objects WHERE r2_key=? AND claim_expires_at>=?",
                        [key, deadline],
                      ),
                      objectFence({ ...input.gc!.object!, r2_key: key }, input.gc!.claimToken),
                    ];
        await atomicBatch(this.db, globalMutationStatements(admission, [...guards, ...statements]));
      } else {
        const spaceId = await primary(this.db)
          .prepare(
            "SELECT s.id FROM spaces s JOIN users u ON u.id=s.owner_id WHERE u.id=? AND u.disabled_at IS NULL",
          )
          .bind(ownerId)
          .first<string>("id");
        this.current(epoch, kind);
        if (!spaceId || Date.now() < startedAt || Date.now() >= deadline)
          throw new Error("r2_write_unavailable");
        const admission = await this.admit({
          permitId: `r2.${kind}:${id}`,
          spaceId,
          epoch,
          deadline,
        });
        this.current(epoch, kind);
        if (Date.now() < startedAt || Date.now() >= deadline)
          throw new Error("r2_write_unavailable");
        const guards = isUploadWrite(kind) ? await uploadWriteProof(this.db, grant) : [];
        this.current(epoch, kind);
        if (Date.now() < startedAt || Date.now() >= deadline)
          throw new Error("r2_write_unavailable");
        await atomicBatch(
          this.db,
          accountMutationStatements(admission, ownerId!, [...guards, ...statements]),
        );
      }
      this.current(epoch, kind);
      if (Date.now() < startedAt || Date.now() >= deadline || this.#row(id)?.state !== "pending")
        throw new Error("r2_write_unavailable");
      return grant;
    } catch (error) {
      // No grant has been returned. A durable tombstone fences a late D1 INSERT.
      try {
        await this.finish(grant, "not_started");
      } catch {
        /* retain the exact local proof */
      }
      throw error;
    }
  }

  async finish(grant: R2WriteGrant, outcome: R2WriteTerminal): Promise<void> {
    validateR2WriteGrant(grant);
    if (outcome !== "succeeded" && outcome !== "not_started") throw new Error("invalid_r2_write");
    const row = this.#row(grant.id);
    if (!row) {
      if (!(await this.#confirmed(grant, outcome))) throw new Error("r2_write_receipt_missing");
      return;
    }
    if (
      row.token !== grant.token ||
      row.grant_json !== JSON.stringify(grant) ||
      (row.state !== "pending" && row.state !== outcome)
    )
      throw new Error("r2_write_conflict");
    if (row.state === "pending") {
      const saved = this.sql.exec(
        "UPDATE control_r2_write_receipts SET state=? WHERE id=? AND token=? AND state='pending' RETURNING id",
        outcome,
        grant.id,
        grant.token,
      );
      if (saved.toArray().length !== 1) throw new Error("r2_write_conflict");
    }
    await this.#reconcile(grant, outcome);
  }

  async #confirmed(grant: R2WriteGrant, outcome: R2WriteTerminal): Promise<boolean> {
    return (
      (await primary(this.db)
        .prepare(`SELECT 1 FROM r2_write_attempts WHERE ${R2_WRITE_IDENTITY} AND state=?`)
        .bind(...r2WriteValues(grant), outcome)
        .first()) !== null
    );
  }

  async #reconcile(grant: R2WriteGrant, outcome: R2WriteTerminal): Promise<void> {
    try {
      const admission = await this.settleAdmit();
      const insert = insertR2Write(grant, outcome);
      await atomicBatch(
        this.db,
        globalMutationStatements(admission, [
          {
            sql: `UPDATE r2_write_attempts SET state=?,finished_at=MAX(started_at,strftime('%s','now')*1000)
          WHERE ${R2_WRITE_IDENTITY} AND state='pending'`,
            values: [outcome, ...r2WriteValues(grant)],
          },
          { ...insert, sql: insert.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") },
          assertExists(`SELECT 1 FROM r2_write_attempts WHERE ${R2_WRITE_IDENTITY} AND state=?`, [
            ...r2WriteValues(grant),
            outcome,
          ]),
          {
            sql: `DELETE FROM r2_write_attempts WHERE id IN (SELECT id FROM r2_write_attempts
          WHERE state<>'pending' AND id<>? AND finished_at<=strftime('%s','now')*1000-86400000 ORDER BY finished_at LIMIT 32)`,
            values: [grant.id],
          },
        ]),
      );
    } catch {
      /* A DB-only terminal fact may be recovered from its exact receipt. */
    }
    if (!(await this.#confirmed(grant, outcome))) throw new Error("r2_write_unsettled");
    const row = this.#row(grant.id);
    if (!row) return;
    if (
      row.token !== grant.token ||
      row.grant_json !== JSON.stringify(grant) ||
      row.state !== outcome
    )
      throw new Error("r2_write_conflict");
    this.storage.transactionSync(() => {
      const used = this.sql.exec(
        "INSERT INTO control_r2_write_used VALUES(?,?) RETURNING id",
        grant.id,
        Math.max(Date.now(), grant.startedAt) + 86400000,
      );
      if (used.toArray().length !== 1) throw new Error("r2_write_conflict");
      const removed = this.sql.exec(
        "DELETE FROM control_r2_write_receipts WHERE id=? AND token=? AND state=? RETURNING id",
        grant.id,
        grant.token,
        outcome,
      );
      if (removed.toArray().length !== 1) throw new Error("r2_write_conflict");
    });
  }

  async repair(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
      throw new Error("invalid_r2_write_limit");
    const rows = this.sql
      .exec<Receipt>(
        "SELECT * FROM control_r2_write_receipts WHERE state<>'pending' ORDER BY id LIMIT ?",
        limit,
      )
      .toArray();
    for (const row of rows) {
      try {
        await this.#reconcile(JSON.parse(row.grant_json), row.state as R2WriteTerminal);
      } catch {
        /* Keep proof; no R2 replay, timeout-based release or inferred completion. */
      }
    }
    const remaining = this.sql.exec<Receipt>("SELECT * FROM control_r2_write_receipts").toArray();
    const pending = await primary(this.db)
      .prepare("SELECT COUNT(*) AS n FROM r2_write_attempts WHERE state='pending'")
      .first<number>("n");
    return {
      checked: rows.length,
      reconciled: rows.filter((row) => !remaining.some((other) => other.id === row.id)).length,
      localPending: remaining.length,
      unknown: remaining.filter((row) => row.state === "pending").length,
      databasePending: pending,
    };
  }
}
