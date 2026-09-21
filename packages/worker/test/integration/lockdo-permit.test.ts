import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { seedFoundation } from "../helpers/foundation.js";

describe("LockDO permit publication", () => {
  it("returns a permit only after its D1 open row exists", async () => {
    await seedFoundation();
    const stub = env.LOCKS.get(env.LOCKS.idFromName("space"));
    const response = await stub.fetch("https://lock.invalid/permits", {
      method: "POST",
      body: JSON.stringify({ permitId: "permit", spaceId: "space", epoch: 1, ttlMs: 5000 }),
    });
    expect(response.status).toBe(200);
    await response.json();
    const permit = await env.DB.prepare(
      "SELECT state,epoch,space_id FROM permits WHERE permit_id='permit'",
    ).first<{ state: string; epoch: number; space_id: string }>();
    expect(permit).toEqual({ state: "open", epoch: 1, space_id: "space" });
  });
});
