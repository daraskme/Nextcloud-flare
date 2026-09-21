import type { Env } from "../env.js";

const MAX_HISTORY_PAGES = 100;
const HISTORY_PREFIX = "sys/epoch/";

function epochKey(epoch: number): string {
  return `${HISTORY_PREFIX}${epoch.toString().padStart(20, "0")}.json`;
}

function parseEpochKey(key: string): number | null {
  const match = /^sys\/epoch\/(\d{20})\.json$/u.exec(key);
  if (match?.[1] === undefined) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function operatorFloor(env: Env): number | null {
  if (env.EPOCH_FLOOR === undefined) {
    return null;
  }
  const value = Number(env.EPOCH_FLOOR);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class ControlDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private initialization: Promise<number> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async listMaximumEpoch(): Promise<number | null> {
    let cursor: string | undefined;
    let maximum: number | null = null;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const result = await this.env.BLOBS.list(
        cursor === undefined
          ? { prefix: HISTORY_PREFIX, limit: 1000 }
          : { prefix: HISTORY_PREFIX, cursor, limit: 1000 },
      );
      for (const object of result.objects) {
        const epoch = parseEpochKey(object.key);
        if (epoch !== null && (maximum === null || epoch > maximum)) {
          maximum = epoch;
        }
      }
      if (!result.truncated) {
        return maximum;
      }
      cursor = result.cursor;
    }
    throw new Error("Epoch history exceeds the bounded scan");
  }

  private async recordEpoch(epoch: number, reason: string): Promise<void> {
    const key = epochKey(epoch);
    const body = JSON.stringify({ epoch, at: Date.now(), reason });
    const result = await this.env.BLOBS.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (result === null && (await this.env.BLOBS.head(key)) === null) {
      throw new Error("Epoch history could not be persisted");
    }
  }

  private async d1Epoch(): Promise<number> {
    const control = await this.env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
      epoch: number;
    }>();
    if (control === null) {
      throw new Error("D1 control epoch is unavailable");
    }
    return control.epoch;
  }

  private async replicateEpoch(epoch: number): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE control SET epoch=?1,updated_at=?2 WHERE singleton=1 AND epoch<=?1",
      ).bind(epoch, Date.now()),
      this.env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
  }

  private async initializeEpoch(): Promise<number> {
    const persisted = await this.state.storage.get<number>("epoch");
    if (persisted !== undefined) {
      return persisted;
    }

    const floor = operatorFloor(this.env);
    const databaseEpoch = await this.d1Epoch();
    let maximum: number | null;
    try {
      maximum = await this.listMaximumEpoch();
    } catch (error) {
      if (floor === null) {
        throw new Error("Epoch history is unavailable and EPOCH_FLOOR is not set", {
          cause: error,
        });
      }
      maximum = null;
    }
    if (maximum === null && floor === null) {
      throw new Error("Epoch history is empty and EPOCH_FLOOR is not set");
    }
    const epoch = Math.max(maximum === null ? 0 : maximum + 1, databaseEpoch + 1, floor ?? 0);
    await this.recordEpoch(epoch, maximum === null ? "operator-floor" : "storage-recovery");
    await this.replicateEpoch(epoch);
    await this.state.storage.put("epoch", epoch);
    return epoch;
  }

  private getEpoch(): Promise<number> {
    this.initialization ??= this.initializeEpoch().finally(() => {
      this.initialization = undefined;
    });
    return this.initialization;
  }

  private async controlState(): Promise<{
    epoch: number;
    maintenance: boolean;
    gcPaused: boolean;
  }> {
    const [persistedEpoch, maintenance, gcPaused] = await Promise.all([
      this.state.storage.get<number>("epoch"),
      this.state.storage.get<boolean>("maintenance"),
      this.state.storage.get<boolean>("gc_paused"),
    ]);
    const epoch = persistedEpoch ?? (await this.d1Epoch());
    return { epoch, maintenance: maintenance ?? false, gcPaused: gcPaused ?? false };
  }

  private async setFlag(name: "maintenance" | "gc_paused", enabled: boolean): Promise<Response> {
    await this.state.storage.put(name, enabled);
    return Response.json(await this.controlState());
  }

  private async bumpEpoch(reason: string): Promise<number> {
    const current = await this.getEpoch();
    const next = Math.max(current, await this.d1Epoch()) + 1;
    await this.recordEpoch(next, reason);
    await this.replicateEpoch(next);
    await this.state.storage.put("epoch", next);
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/epoch") {
        return Response.json({ epoch: await this.getEpoch() });
      }
      if (request.method === "GET" && url.pathname === "/state") {
        return Response.json(await this.controlState());
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/maintenance" || url.pathname === "/gc-pause")
      ) {
        const body = await request.json<{ enabled?: unknown }>();
        if (typeof body.enabled !== "boolean") {
          return Response.json({ error: "invalid_control_flag" }, { status: 400 });
        }
        return await this.setFlag(
          url.pathname === "/maintenance" ? "maintenance" : "gc_paused",
          body.enabled,
        );
      }
      if (request.method === "POST" && url.pathname === "/epoch/bump") {
        const body = await request.json<{ reason?: unknown }>();
        if (typeof body.reason !== "string" || body.reason.length < 1 || body.reason.length > 128) {
          return Response.json({ error: "invalid_reason" }, { status: 400 });
        }
        return Response.json({ epoch: await this.bumpEpoch(body.reason) });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch {
      return Response.json({ error: "epoch_unavailable" }, { status: 503 });
    }
  }
}
