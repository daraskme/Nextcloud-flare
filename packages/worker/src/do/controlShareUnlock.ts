import { base64url } from "jose";

export interface ShareUnlockAttempt {
  shareId: string;
  clientIp: string;
  epoch: number;
  deadline: number;
}
export type ShareUnlockAdmission = { allowed: true } | { allowed: false; retryAfter: number };
const WINDOW = 60000,
  MAX_KEYS = 4096;

/** Normalize trusted edge IPs; never use X-Forwarded-For or an application-supplied key. */
export function canonicalClientIp(ip: string): string {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    if (ip.split(".").some((v) => Number(v) > 255 || String(Number(v)) !== v))
      throw new Error("invalid_client_ip");
    return ip;
  }
  if (ip.length <= 45 && /^[a-fA-F\d:.]+$/.test(ip) && ip.includes(":")) {
    try {
      return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    } catch {
      /* reject malformed IP */
    }
  }
  throw new Error("invalid_client_ip");
}

/** Rolling limits survive eviction. A missing ledger waits one window before admitting requests. */
export class ControlShareUnlock {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly current: (epoch: number) => void,
    private readonly now = Date.now,
  ) {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS share_unlock_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),salt TEXT NOT NULL,not_before INTEGER NOT NULL,last_now INTEGER NOT NULL)`,
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS share_unlock_rates(id TEXT PRIMARY KEY,events TEXT NOT NULL,expires_at INTEGER NOT NULL)`,
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS share_unlock_rates_expiry ON share_unlock_rates(expires_at)",
    );
    const time = now();
    storage.sql.exec(
      "INSERT OR IGNORE INTO share_unlock_clock VALUES(1,?,?,?)",
      base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
      time + WINDOW,
      time,
    );
  }
  async admit(request: ShareUnlockAttempt): Promise<ShareUnlockAdmission> {
    if (
      !request ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(request.shareId) ||
      !Number.isSafeInteger(request.epoch) ||
      request.epoch < 1 ||
      !Number.isSafeInteger(request.deadline) ||
      request.deadline <= this.now() ||
      request.deadline > this.now() + 5000
    )
      throw new Error("share_unlock_unavailable");
    const ip = canonicalClientIp(request.clientIp);
    const state = this.storage.sql
      .exec<{ salt: string; not_before: number; last_now: number }>(
        "SELECT * FROM share_unlock_clock WHERE singleton=1",
      )
      .one();
    const key = await crypto.subtle.importKey(
      "raw",
      base64url.decode(state.salt),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = base64url.encode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip))),
    );
    return this.storage.transactionSync(() => {
      this.current(request.epoch);
      const now = this.now();
      const clock = this.storage.sql
        .exec<{ salt: string; not_before: number; last_now: number }>(
          "SELECT * FROM share_unlock_clock WHERE singleton=1",
        )
        .one();
      if (clock.salt !== state.salt || now < clock.last_now || request.deadline <= now)
        throw new Error("share_unlock_unavailable");
      this.storage.sql.exec("UPDATE share_unlock_clock SET last_now=? WHERE singleton=1", now);
      if (now < clock.not_before)
        return { allowed: false, retryAfter: Math.ceil((clock.not_before - now) / 1000) };
      this.storage.sql.exec("DELETE FROM share_unlock_rates WHERE expires_at<=?", now);
      const keys = [`s:${request.shareId}`, `ip:${digest}`];
      const rows = keys.map((id) => {
        const row = this.storage.sql
          .exec<{ events: string }>("SELECT events FROM share_unlock_rates WHERE id=?", id)
          .toArray()[0];
        const events: number[] = row ? JSON.parse(row.events) : [];
        if (
          !Array.isArray(events) ||
          events.length > 30 ||
          events.some((v) => !Number.isSafeInteger(v) || v < 0 || v > now)
        )
          throw new Error("share_unlock_unavailable");
        return { id, exists: !!row, events: events.filter((t) => t > now - WINDOW) };
      });
      let retryAfter = 0;
      for (const [i, row] of rows.entries())
        if (row.events.length >= (i === 0 ? 10 : 30))
          retryAfter = Math.max(retryAfter, Math.ceil((row.events[0]! + WINDOW - now) / 1000));
      if (retryAfter) return { allowed: false, retryAfter };
      const count = this.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM share_unlock_rates")
        .one().n;
      if (count + rows.filter((r) => !r.exists).length > MAX_KEYS)
        return { allowed: false, retryAfter: 60 };
      for (const row of rows)
        this.storage.sql.exec(
          "INSERT INTO share_unlock_rates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET events=excluded.events,expires_at=excluded.expires_at",
          row.id,
          JSON.stringify([...row.events, now]),
          now + WINDOW,
        );
      return { allowed: true };
    });
  }
}
