import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { authorizationAssertion, type Principal } from "../auth/authorize";
import { assertExists, assertOneChange, atomicBatch, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { digestJson } from "../jobs/operations";
import {
  type UploadRow,
  uploadAuthority,
  uploadFence,
  uploadRow,
} from "../services/uploads/access";
import { CONTROL_NAME } from "./ControlDO";
import { MultipartLedger, type PartOutcome } from "./uploadLedger";

export interface MultipartRequest {
  readonly uploadId: string;
  readonly principal: Principal;
  readonly capability: string;
}
export interface MultipartPartRequest extends MultipartRequest {
  readonly partNumber: number;
  readonly attemptId: string;
  readonly bytes: number;
}

/** Internal metadata RPC only. Request streams and R2 calls stay in the Worker. */
export class UploadDO extends DurableObject<Env> {
  readonly #ledger: MultipartLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ledger = new MultipartLedger(ctx.storage);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS multipart_binding(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),ledger_id TEXT NOT NULL)`);
  }

  fetch(): Response {
    return problem(503, "not_ready");
  }

  async #serialized<T>(work: () => Promise<T>): Promise<T> {
    // Expected validation failures must not reject blockConcurrencyWhile and reset the DO.
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { ok: true as const, value: await work() };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  #binding(): string | undefined {
    return this.ctx.storage.sql
      .exec<{ ledger_id: string }>("SELECT ledger_id FROM multipart_binding")
      .toArray()[0]?.ledger_id;
  }

  async #schedule(mirrored = false) {
    const at = this.#ledger.nextAlarmAt();
    if (
      at === null &&
      !mirrored &&
      this.#binding() &&
      this.#ledger.status(Date.now())?.cleanupPending
    )
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    else if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  async #lost(row: UploadRow): Promise<never> {
    // A D1 marker is written BEFORE the first local journal. Empty storage can never reset budgets.
    await atomicBatch(this.env.DB, [
      {
        sql: `UPDATE uploads SET state='failed',accept_parts=0,cleanup_pending=1,
          error_code='upload_ledger_lost' WHERE id=? AND mode='multipart'
          AND state IN ('created','uploading','completing')`,
        values: [row.id],
      },
      {
        sql: "UPDATE upload_parts SET state='unknown' WHERE upload_id=? AND state='in_flight'",
        values: [row.id],
      },
    ]);
    throw new Error("upload_ledger_recovery_required");
  }

  async #initialize(row: UploadRow, authorized: Awaited<ReturnType<typeof uploadAuthority>>) {
    const binding = this.#binding();
    if (row.multipart_ledger_id) {
      if (binding !== row.multipart_ledger_id || !this.#ledger.status(Date.now()))
        return this.#lost(row);
    } else {
      if (binding || this.#ledger.status(Date.now())) return this.#lost(row);
      const marker = crypto.randomUUID();
      // A lost acknowledgement deliberately leaves an unrecoverable initialization gap.
      // Neither the failed caller nor a replay may start a new ledger from that marker.
      await atomicBatch(this.env.DB, [
        authorizationAssertion(authorized),
        uploadFence(row, ["created"]),
        {
          sql: `UPDATE uploads SET multipart_ledger_id=? WHERE id=? AND multipart_ledger_id IS NULL
            AND data_calls=0 AND multipart_revision=0 AND r2_upload_id IS NOT NULL`,
          values: [marker, row.id],
        },
        assertOneChange,
      ]);
      this.ctx.storage.transactionSync(() => {
        this.#ledger.initialize(this.#identity(row), Date.now());
        this.ctx.storage.sql.exec("INSERT INTO multipart_binding VALUES(1,?)", marker);
      });
      row.multipart_ledger_id = marker;
    }
    this.#ledger.initialize(this.#identity(row), Date.now());
    await this.#schedule();
  }

  #identity(row: UploadRow) {
    if (row.mode !== "multipart" || !row.part_bytes || !row.part_count || !row.r2_upload_id)
      throw new Error("upload_multipart_not_initialized");
    return {
      uploadId: row.id,
      epoch: row.epoch,
      declaredBytes: row.declared_size,
      partBytes: row.part_bytes,
      r2UploadId: row.r2_upload_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async #mirror(row: UploadRow, assertions: readonly SqlStatement[] = []) {
    const snapshot = this.#ledger.mirrorSnapshot(Date.now());
    if (!snapshot || !row.multipart_ledger_id || this.#binding() !== row.multipart_ledger_id)
      throw new Error("upload_ledger_recovery_required");
    const stopping = ["aborting", "expired", "failed"].includes(snapshot.state);
    if (!assertions.length && !stopping) throw new Error("upload_mirror_authority_required");
    await atomicBatch(this.env.DB, [
      ...assertions,
      ...(!stopping
        ? [
            assertExists(
              `SELECT 1 FROM uploads u JOIN reservations r ON r.id=u.reservation_id
          WHERE u.id=? AND r.owner_id=u.owner_id AND r.epoch=u.epoch
          AND r.bytes=u.declared_size AND r.state='reserved'
          AND r.expires_at>strftime('%s','now')*1000
          AND u.expires_at>strftime('%s','now')*1000
          AND (u.accept_parts=1 OR u.state='completing')`,
              [row.id],
            ),
          ]
        : []),
      assertExists(
        `SELECT 1 FROM uploads WHERE id=? AND epoch=? AND mode='multipart'
          AND multipart_cleanup_started_at IS NULL
          AND r2_upload_id=? AND multipart_ledger_id=? AND multipart_revision<=?
          AND state IN (SELECT value FROM json_each(?))`,
        [
          row.id,
          row.epoch,
          row.r2_upload_id,
          row.multipart_ledger_id,
          snapshot.revision,
          JSON.stringify(
            stopping
              ? ["created", "uploading", "completing", "aborting", "expired", "failed"]
              : snapshot.state === "completing"
                ? ["created", "uploading", "completing"]
                : ["created", "uploading"],
          ),
        ],
      ),
      {
        sql: `UPDATE uploads SET state=?,accept_parts=?,in_flight=?,data_calls=?,data_bytes=?,
          control_calls=MAX(control_calls,?+1),cleanup_calls=MAX(cleanup_calls,?),cleanup_pending=?,
          last_progress_at=MAX(last_progress_at,?),error_code=?,multipart_revision=? WHERE id=?`,
        values: [
          snapshot.state,
          snapshot.state === "created" || snapshot.state === "uploading" ? 1 : 0,
          snapshot.inFlight,
          snapshot.dataCalls,
          snapshot.dataBytes,
          snapshot.controlCalls,
          snapshot.cleanupCalls,
          snapshot.cleanupPending ? 1 : 0,
          snapshot.lastProgressAt,
          snapshot.errorCode,
          snapshot.revision,
          row.id,
        ],
      },
      ...snapshot.parts.map(
        (part): SqlStatement => ({
          sql: `INSERT INTO upload_parts(upload_id,part_number,attempts,attempt_id,state,expected_size,lease_expires_at,etag,sha256)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET
          attempts=excluded.attempts,attempt_id=excluded.attempt_id,state=excluded.state,
          lease_expires_at=excluded.lease_expires_at,etag=excluded.etag,sha256=excluded.sha256`,
          values: [
            row.id,
            part.part_number,
            part.attempts,
            part.attempt_id,
            part.state === "not_started" ? "pending" : part.state,
            part.expected_bytes,
            part.lease_expires_at,
            part.etag,
            part.sha256,
          ],
        }),
      ),
    ]);
    this.#ledger.markMirrored(snapshot.revision);
    await this.#schedule(true);
  }

  async #completed(row: UploadRow) {
    const digest = await digestJson({
      spaceId: row.space_id,
      kind: "upload.complete",
      body: { uploadId: row.id, digest: row.request_digest },
    });
    await atomicBatch(this.env.DB, [
      assertExists(
        `SELECT 1 FROM uploads u JOIN operations o ON o.op_id=u.completion_op_id
        WHERE u.id=? AND u.mode='multipart' AND u.state='completed'
          AND u.multipart_object_etag IS NOT NULL AND u.multipart_complete_attempt IS NOT NULL
          AND o.kind='upload.complete' AND o.state='committed'
          AND o.request_digest=? AND o.principal_kind='user' AND o.credential_version IS NULL
          AND EXISTS(SELECT 1 FROM credentials c JOIN sessions s ON s.id=c.session_id
            WHERE c.id=u.credential_id AND s.user_id=o.principal_id)
          AND o.credential_id=u.credential_id AND o.epoch=u.epoch AND o.space_id=u.space_id
          AND json_extract(o.operands_json,'$.uploadId')=u.id
          AND json_extract(o.operands_json,'$.parentId')=u.parent_id
          AND json_extract(o.operands_json,'$.nodeId') IS u.target_id
          AND json_extract(o.result_json,'$.status')=CASE WHEN u.target_id IS NULL THEN 201 ELSE 204 END
          AND json_extract(o.result_json,'$.nodeId')=COALESCE(u.target_id,o.op_id||'_node')
          AND o.expected_steps=CASE WHEN u.target_id IS NULL THEN 10 ELSE 8 END
          AND (SELECT COUNT(*) FROM operation_steps s WHERE s.op_id=o.op_id)=o.expected_steps
          AND EXISTS(SELECT 1 FROM operation_steps s WHERE s.op_id=o.op_id AND s.kind='upload' AND s.affected_id=u.id)
          AND EXISTS(SELECT 1 FROM operation_steps s WHERE s.op_id=o.op_id AND s.kind='blob' AND s.affected_id=u.blob_id)`,
        [row.id, digest],
      ),
    ]);
    const local = this.#ledger.status(Date.now());
    if (local) {
      if (local.uploadId !== row.id || this.#binding() !== row.multipart_ledger_id)
        throw new Error("upload_terminal_conflict");
      this.#ledger.acknowledgeCompleted(row.epoch);
    }
    // A lost journal does not need reconstruction for a durably completed upload. D1 blocks writes.
    await this.ctx.storage.deleteAlarm();
  }

  async #run<T>(
    request: MultipartRequest,
    action: () => T,
    terminal?: (row: UploadRow) => T,
  ): Promise<T> {
    // Serialize only short control-plane operations, never streams or R2 calls. The gate also
    // prevents an older D1 response from clearing dirty rows belonging to a newer part result.
    return this.#serialized(async () => {
      if (
        !/^up_[a-f0-9]{64}$/.test(request.uploadId) ||
        this.ctx.id.toString() !== this.env.UPLOADS.idFromName(request.uploadId).toString()
      )
        throw new Error("upload_namespace_mismatch");
      const control = await this.env.CONTROL.get(
        this.env.CONTROL.idFromName(CONTROL_NAME),
      ).status();
      this.#ledger.invalidateEpoch(control.epoch);
      if (this.#binding() && this.#ledger.status(Date.now())?.cleanupPending)
        await this.#schedule();
      if (control.maintenance || control.epoch !== request.principal.epoch)
        throw new Error("admission_closed");
      const row = await uploadRow(this.env.DB, request.uploadId);
      if (!row) throw new Error("upload_not_found");
      if (
        !request.capability ||
        request.capability.length > 108 ||
        (await digestJson(request.capability)) !== row.capability_hash
      )
        throw new Error("invalid_upload_capability");
      const authorized = await uploadAuthority(
        this.env.DB,
        request.principal,
        row,
        row.state !== "completed",
      );
      if (row.state === "completed") {
        await atomicBatch(this.env.DB, [
          authorizationAssertion(authorized),
          uploadFence(row, ["completed"], false),
        ]);
        await this.#completed(row);
        if (!terminal) throw new Error("upload_already_completed");
        return terminal(row);
      }
      if (row.multipart_cleanup_started_at !== null) {
        await this.ctx.storage.deleteAlarm();
        throw new Error("upload_cleanup_started");
      }
      this.#identity(row);
      await this.#initialize(row, authorized);
      const assertions = [
        authorizationAssertion(authorized),
        assertExists("SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0", [
          row.epoch,
        ]),
      ];
      // Reconcile an earlier lost acknowledgement before relying on D1 last_progress_at.
      await this.#mirror(row, assertions);
      await atomicBatch(this.env.DB, [
        authorizationAssertion(authorized),
        uploadFence(row, ["created", "uploading", "completing", "aborting", "expired", "failed"]),
      ]);
      try {
        return action();
      } finally {
        await this.#schedule();
        await this.#mirror(row, assertions);
      }
    });
  }

  status(request: MultipartRequest) {
    return this.#run(
      request,
      () => this.#ledger.status(Date.now())!,
      (row) => ({
        uploadId: row.id,
        epoch: row.epoch,
        state: "completed" as const,
        partCount: row.part_count!,
        inFlight: 0,
        completedParts: row.part_count!,
        dataCalls: row.data_calls,
        dataBytes: row.data_bytes,
        controlCalls: row.control_calls,
        cleanupCalls: row.cleanup_calls,
        cleanupPending: false,
        errorCode: null,
      }),
    );
  }

  acknowledgeCompletion(request: MultipartRequest) {
    return this.#run(
      request,
      () => {
        throw new Error("upload_not_completed");
      },
      () => {},
    );
  }

  claimPart(request: MultipartPartRequest) {
    return this.#run(request, () =>
      this.#ledger.claim(
        request.principal.epoch,
        request.partNumber,
        request.attemptId,
        request.bytes,
        Date.now(),
      ),
    );
  }

  settlePart(
    request: MultipartRequest & { readonly attemptId: string; readonly outcome: PartOutcome },
  ) {
    return this.#run(request, () =>
      this.#ledger.settle(request.principal.epoch, request.attemptId, request.outcome, Date.now()),
    );
  }

  completedParts(request: MultipartRequest & { readonly after: number; readonly limit?: number }) {
    return this.#run(request, () => this.#ledger.completedParts(request.after, request.limit));
  }

  beginComplete(request: MultipartRequest) {
    return this.#run(request, () =>
      this.#ledger.beginComplete(request.principal.epoch, Date.now()),
    );
  }

  requestAbort(request: MultipartRequest) {
    return this.#run(request, () => this.#ledger.requestAbort(request.principal.epoch, Date.now()));
  }

  async alarm(): Promise<void> {
    await this.#serialized(async () => {
      const before = this.#ledger.status(Date.now());
      if (before && this.#binding()) {
        const row = await uploadRow(this.env.DB, before.uploadId);
        if (row?.state === "completed") {
          await this.#completed(row);
          return;
        }
        if (row?.multipart_cleanup_started_at != null) {
          // D1 permanently fenced this journal before R2 cleanup. Never mirror it back.
          await this.ctx.storage.deleteAlarm();
          return;
        }
      }
      if (this.#binding()) {
        const control = await this.env.CONTROL.get(
          this.env.CONTROL.idFromName(CONTROL_NAME),
        ).status();
        this.#ledger.invalidateEpoch(control.epoch);
      }
      const snapshot = this.#ledger.status(Date.now());
      if (snapshot?.cleanupPending && this.#binding()) {
        await this.#schedule();
        const row = await uploadRow(this.env.DB, snapshot.uploadId);
        if (!row) throw new Error("upload_not_found");
        // Restrictive transitions need no live user credential or open maintenance gate.
        // Failure throws so Cloudflare retries the alarm; no refund or R2 deletion occurs here.
        await this.#mirror(row);
      }
      await this.#schedule(true);
    });
  }
}
