import type { Env } from "../env.js";

interface BudgetState {
  maxBytes: number;
  consumedBytes: number;
  requests: number;
  active: number;
  windowStartedAt?: number;
}

interface LeaseRequest {
  maxBytes: number;
  bytes: number;
}

interface LeaseState {
  bytes: number;
  expiresAt: number;
}

const LEASE_TTL_MS = 10 * 60 * 1000;

function validLeaseRequest(value: unknown): value is LeaseRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as Partial<LeaseRequest>;
  return (
    Number.isSafeInteger(request.maxBytes) &&
    request.maxBytes !== undefined &&
    request.maxBytes >= 0 &&
    Number.isSafeInteger(request.bytes) &&
    request.bytes !== undefined &&
    request.bytes >= 0
  );
}

function leaseId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class BudgetDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async acquire(input: LeaseRequest): Promise<Response> {
    const id = leaseId();
    const accepted = await this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const stored = await transaction.get<BudgetState>("budget");
      const current =
        stored === undefined ||
        (stored.active === 0 && now - (stored.windowStartedAt ?? 0) >= LEASE_TTL_MS)
          ? {
              maxBytes: input.maxBytes,
              consumedBytes: 0,
              requests: 0,
              active: 0,
              windowStartedAt: now,
            }
          : stored;
      if (
        current.maxBytes !== input.maxBytes ||
        current.active >= 8 ||
        current.requests >= 1024 ||
        current.consumedBytes + input.bytes > current.maxBytes
      ) {
        return false;
      }
      const next: BudgetState = {
        ...current,
        consumedBytes: current.consumedBytes + input.bytes,
        requests: current.requests + 1,
        active: current.active + 1,
      };
      await transaction.put("budget", next);
      await transaction.put<LeaseState>(`lease:${id}`, {
        bytes: input.bytes,
        expiresAt: Date.now() + LEASE_TTL_MS,
      });
      return true;
    });
    if (accepted) {
      const alarm = await this.state.storage.getAlarm();
      const expiresAt = Date.now() + LEASE_TTL_MS;
      if (alarm === null || alarm > expiresAt) await this.state.storage.setAlarm(expiresAt);
    }
    return accepted
      ? Response.json({ lease_id: id })
      : Response.json({ error: "budget_exceeded" }, { status: 429 });
  }

  private async settle(id: string): Promise<Response> {
    await this.state.storage.transaction(async (transaction) => {
      const lease = await transaction.get<LeaseState>(`lease:${id}`);
      if (lease === undefined) {
        return;
      }
      const current = await transaction.get<BudgetState>("budget");
      if (current !== undefined) {
        await transaction.put("budget", { ...current, active: Math.max(0, current.active - 1) });
      }
      await transaction.delete(`lease:${id}`);
    });
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextAlarm: number | undefined;
    await this.state.storage.transaction(async (transaction) => {
      const leases = await transaction.list<LeaseState>({ prefix: "lease:" });
      let expired = 0;
      for (const [key, lease] of leases) {
        if (lease.expiresAt <= now) {
          await transaction.delete(key);
          expired += 1;
        } else if (nextAlarm === undefined || lease.expiresAt < nextAlarm) {
          nextAlarm = lease.expiresAt;
        }
      }
      if (expired > 0) {
        const current = await transaction.get<BudgetState>("budget");
        if (current !== undefined) {
          await transaction.put("budget", {
            ...current,
            active: Math.max(0, current.active - expired),
          });
        }
      }
    });
    if (nextAlarm !== undefined) await this.state.storage.setAlarm(nextAlarm);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/leases") {
      const body: unknown = await request.json();
      return validLeaseRequest(body)
        ? this.acquire(body)
        : Response.json({ error: "invalid_budget" }, { status: 400 });
    }
    const match = /^\/leases\/([a-f0-9]{32})\/settle$/u.exec(url.pathname);
    if (request.method === "POST" && match?.[1] !== undefined) {
      return this.settle(match[1]);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const budget = await this.state.storage.get<BudgetState>("budget");
      return Response.json(budget ?? { maxBytes: 0, consumedBytes: 0, requests: 0, active: 0 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
