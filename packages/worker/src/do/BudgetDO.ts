import { DurableObject } from "cloudflare:workers";
import { problem } from "@next-cloud-flare/shared/errors";
import { primary } from "../db/primary";
import type { Env } from "../env";

const LEASE_MS = 600_000;
const REQUEST_LIMIT = 1_024;
const PARALLEL_LIMIT = 8;
const MAX_ROWS = 1_024;
const ID = /^[A-Za-z0-9_:-]{1,512}$/;
const LEASE_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface Authority {
  epoch: number;
  budgetExpiresAt: number;
  sessionExpiresAt: number;
  totalBytes: number;
}
interface BudgetState extends Record<string, SqlStorageValue> {
  budget_id: string;
  epoch: number;
  expires_at: number;
  byte_limit: number;
  bytes_charged: number;
  window_start: number;
  requests: number;
}
interface LeaseRow extends Record<string, SqlStorageValue> {
  request_id: string;
  session_id: string;
  reserved_bytes: number;
  charged_bytes: number;
  expires_at: number;
  state: "active" | "settled" | "unknown" | "expired";
}

export interface BudgetReserveRequest {
  readonly budgetId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly epoch: number;
  readonly bytes: number;
}
export interface BudgetLease {
  readonly requestId: string;
  readonly expiresAt: number;
  readonly reservedBytes: number;
}
export interface BudgetSettleRequest {
  readonly budgetId: string;
  readonly requestId: string;
  /** null means the transfer outcome is unknown and the full reservation is charged. */
  readonly deliveredBytes: number | null;
}

/** Durable, per-budget admission. Public fetch remains closed until every content route uses it. */
export class BudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS budget_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),budget_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,byte_limit INTEGER NOT NULL,
      bytes_charged INTEGER NOT NULL,window_start INTEGER NOT NULL,requests INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_leases(
      request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,reserved_bytes INTEGER NOT NULL,
      charged_bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','settled','unknown','expired')));`);
  }

  fetch(): Response {
    return problem(503, "not_ready");
  }

  #canonical(budgetId: string) {
    if (
      !ID.test(budgetId) ||
      this.ctx.id.toString() !== this.env.BUDGETS.idFromName(budgetId).toString()
    )
      throw new Error("budget_namespace_mismatch");
  }

  async #authority(request: BudgetReserveRequest, now: number): Promise<Authority> {
    const row = await primary(this.env.DB)
      .prepare(`SELECT b.epoch,b.expires_at AS budgetExpiresAt,
        cs.expires_at AS sessionExpiresAt,ts.total_bytes AS totalBytes
        FROM budgets b JOIN content_sessions cs ON cs.budget_id=b.id
        JOIN target_sets ts ON ts.id=cs.target_set_id AND ts.credential_id=cs.issued_by_credential_id
          AND ts.owner_id=b.owner_id
        JOIN tickets t ON t.id=cs.ticket_id AND t.budget_id=b.id AND t.target_set_id=ts.id
          AND t.credential_id=cs.issued_by_credential_id
        JOIN users owner ON owner.id=b.owner_id AND owner.disabled_at IS NULL
        JOIN control ctl ON ctl.singleton=1 AND ctl.epoch=b.epoch AND ctl.maintenance=0
        WHERE b.id=? AND cs.id=? AND b.epoch=? AND cs.epoch=b.epoch
          AND ts.epoch=b.epoch AND t.epoch=b.epoch
          AND b.state='active' AND b.expires_at>? AND cs.revoked_at IS NULL
          AND cs.expires_at>? AND ts.expires_at>? AND t.cancelled_at IS NULL
          AND t.expires_at>? AND b.user_id IS cs.user_id AND b.share_id IS cs.share_id
          AND EXISTS(SELECT 1 FROM credentials c WHERE c.id=cs.issued_by_credential_id
            AND ((c.kind='access' AND EXISTS(
              SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
              WHERE s.id=c.session_id AND s.kind='access' AND s.user_id=cs.user_id
                AND s.epoch=cs.epoch AND s.revoked_at IS NULL AND s.expires_at>?
                AND u.disabled_at IS NULL))
            OR (c.kind='app_password' AND EXISTS(
              SELECT 1 FROM app_passwords ap JOIN users u ON u.id=ap.user_id
              WHERE ap.id=c.app_password_id AND ap.user_id=cs.user_id
                AND ap.revoked_at IS NULL AND ap.expires_at>? AND u.disabled_at IS NULL))
            OR (c.kind='share' AND cs.user_id IS NULL AND EXISTS(
              SELECT 1 FROM share_sessions ss WHERE ss.id=c.share_session_id
                AND ss.share_id=cs.share_id AND ss.share_version=cs.share_version
                AND ss.epoch=cs.epoch AND ss.revoked_at IS NULL AND ss.expires_at>?))))
          AND (cs.share_id IS NULL OR EXISTS(
            SELECT 1 FROM shares sh WHERE sh.id=cs.share_id AND sh.version=cs.share_version
              AND sh.owner_id=b.owner_id AND sh.disabled_at IS NULL
              AND (sh.expires_at IS NULL OR sh.expires_at>?)
              AND EXISTS(SELECT 1 FROM share_actions sa WHERE sa.share_id=sh.id AND sa.action='read')
              AND ((cs.user_id IS NULL AND sh.kind='link') OR
                (cs.user_id IS NOT NULL AND sh.kind='internal' AND EXISTS(
                  SELECT 1 FROM share_grants g WHERE g.share_id=sh.id AND g.user_id=cs.user_id
                    AND g.version=sh.version AND g.disabled_at IS NULL)))))`)
      .bind(
        request.budgetId,
        request.sessionId,
        request.epoch,
        now,
        now,
        now,
        now,
        now,
        now,
        now,
        now,
      )
      .first<Authority>();
    if (!row || !Number.isSafeInteger(row.totalBytes) || row.totalBytes < 0)
      throw new Error("budget_authorization_denied");
    return row;
  }

  #state(): BudgetState | undefined {
    return this.ctx.storage.sql
      .exec<BudgetState>("SELECT * FROM budget_state WHERE singleton=1")
      .toArray()[0];
  }

  #lease(requestId: string): LeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<LeaseRow>("SELECT * FROM budget_leases WHERE request_id=?", requestId)
      .toArray()[0];
  }

  #sweep(now: number) {
    this.ctx.storage.sql.exec(
      "UPDATE budget_leases SET state='expired' WHERE state='active' AND expires_at<=?",
      now,
    );
    // A terminal request only needs its idempotency record for its lease lifetime.
    // Retaining it forever would make the bounded row limit permanent after 1,024 reads.
    this.ctx.storage.sql.exec(
      "DELETE FROM budget_leases WHERE state<>'active' AND expires_at<=?",
      now,
    );
  }

  async #alarmForActive() {
    const earliest = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(expires_at) AS at FROM budget_leases WHERE state='active'",
      )
      .one().at;
    if (earliest === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(earliest);
  }

  async reserve(request: BudgetReserveRequest): Promise<BudgetLease> {
    this.#canonical(request.budgetId);
    if (
      !LEASE_ID.test(request.sessionId) ||
      !LEASE_ID.test(request.requestId) ||
      !Number.isSafeInteger(request.epoch) ||
      request.epoch < 1 ||
      !Number.isSafeInteger(request.bytes) ||
      request.bytes < 0 ||
      request.bytes > 536_870_912_000
    )
      throw new Error("invalid_budget_request");
    const now = Date.now();
    const authority = await this.#authority(request, now);
    const byteLimit = authority.totalBytes * 3;
    if (!Number.isSafeInteger(byteLimit)) throw new Error("budget_limit_invalid");
    let state = this.#state();
    if (state && (state.budget_id !== request.budgetId || state.epoch > request.epoch))
      throw new Error("budget_epoch_conflict");
    if (!state || state.epoch < request.epoch || state.expires_at <= now) {
      this.ctx.storage.sql.exec("DELETE FROM budget_leases");
      this.ctx.storage.sql.exec(
        `INSERT INTO budget_state VALUES(1,?,?,?,?,0,?,0)
          ON CONFLICT(singleton) DO UPDATE SET budget_id=excluded.budget_id,epoch=excluded.epoch,
            expires_at=excluded.expires_at,byte_limit=excluded.byte_limit,
            bytes_charged=0,window_start=excluded.window_start,requests=0`,
        request.budgetId,
        request.epoch,
        authority.budgetExpiresAt,
        byteLimit,
        now,
      );
      state = this.#state();
    }
    if (!state) throw new Error("budget_state_missing");
    this.#sweep(now);
    const existing = this.#lease(request.requestId);
    if (existing) {
      if (
        existing.session_id !== request.sessionId ||
        existing.reserved_bytes !== request.bytes ||
        existing.state !== "active"
      )
        throw new Error("budget_request_conflict");
      await this.#alarmForActive();
      return Object.freeze({
        requestId: existing.request_id,
        expiresAt: existing.expires_at,
        reservedBytes: existing.reserved_bytes,
      });
    }
    const active = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_leases WHERE state='active'")
      .one().n;
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_leases")
      .one().n;
    const resetWindow = now - state.window_start >= LEASE_MS;
    const windowStart = resetWindow ? now : state.window_start;
    const requests = resetWindow ? 0 : state.requests;
    if (
      state.expires_at <= now ||
      state.byte_limit < byteLimit ||
      active >= PARALLEL_LIMIT ||
      rows >= MAX_ROWS ||
      requests >= REQUEST_LIMIT ||
      state.bytes_charged + request.bytes > state.byte_limit
    )
      throw new Error("budget_exceeded");
    const expiresAt = Math.min(
      now + LEASE_MS,
      authority.sessionExpiresAt,
      authority.budgetExpiresAt,
    );
    if (expiresAt <= now) throw new Error("budget_authorization_denied");
    this.ctx.storage.sql.exec(
      "INSERT INTO budget_leases VALUES(?,?,?,?,?,'active')",
      request.requestId,
      request.sessionId,
      request.bytes,
      request.bytes,
      expiresAt,
    );
    this.ctx.storage.sql.exec(
      `UPDATE budget_state SET bytes_charged=bytes_charged+?,window_start=?,requests=?
        WHERE singleton=1`,
      request.bytes,
      windowStart,
      requests + 1,
    );
    await this.#alarmForActive();
    return Object.freeze({ requestId: request.requestId, expiresAt, reservedBytes: request.bytes });
  }

  async settle(request: BudgetSettleRequest): Promise<number> {
    this.#canonical(request.budgetId);
    if (
      !LEASE_ID.test(request.requestId) ||
      (request.deliveredBytes !== null &&
        (!Number.isSafeInteger(request.deliveredBytes) || request.deliveredBytes < 0))
    )
      throw new Error("invalid_budget_settlement");
    const state = this.#state();
    const lease = this.#lease(request.requestId);
    if (!state || !lease || state.budget_id !== request.budgetId)
      throw new Error("budget_lease_missing");
    this.#sweep(Date.now());
    const current = this.#lease(request.requestId);
    if (!current) throw new Error("budget_lease_missing");
    if (current.state !== "active") {
      if (current.state === "settled" && request.deliveredBytes === current.charged_bytes)
        return current.charged_bytes;
      if (current.state === "unknown" && request.deliveredBytes === null)
        return current.charged_bytes;
      throw new Error("budget_lease_terminal");
    }
    if (request.deliveredBytes !== null && request.deliveredBytes > current.reserved_bytes)
      throw new Error("budget_lease_overrun");
    const charged = request.deliveredBytes ?? current.reserved_bytes;
    this.ctx.storage.sql.exec(
      "UPDATE budget_leases SET state=?,charged_bytes=? WHERE request_id=? AND state='active'",
      request.deliveredBytes === null ? "unknown" : "settled",
      charged,
      request.requestId,
    );
    if (charged < current.reserved_bytes)
      this.ctx.storage.sql.exec(
        "UPDATE budget_state SET bytes_charged=bytes_charged-? WHERE singleton=1",
        current.reserved_bytes - charged,
      );
    await this.#alarmForActive();
    return charged;
  }

  async alarm(): Promise<void> {
    this.#sweep(Date.now());
    await this.#alarmForActive();
  }

  status(): { bytesCharged: number; requests: number; active: number; byteLimit: number } | null {
    const state = this.#state();
    if (!state) return null;
    const active = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget_leases WHERE state='active'")
      .one().n;
    return {
      bytesCharged: state.bytes_charged,
      requests: state.requests,
      active,
      byteLimit: state.byte_limit,
    };
  }
}
