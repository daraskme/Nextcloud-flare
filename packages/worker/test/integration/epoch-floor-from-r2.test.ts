import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { applyFoundationMigration } from "../helpers/foundation.js";

describe("ControlDO epoch recovery", () => {
  it("publishes max R2 history plus one before serving", async () => {
    await applyFoundationMigration();
    await env.BLOBS.put(
      "sys/epoch/00000000000000000005.json",
      JSON.stringify({ epoch: 5, at: 1, reason: "fixture" }),
    );
    const stub = env.CONTROL.get(env.CONTROL.idFromName("epoch-floor-from-r2"));
    const response = await stub.fetch("https://control.invalid/epoch");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ epoch: 6 });
    await expect(env.BLOBS.head("sys/epoch/00000000000000000006.json")).resolves.not.toBeNull();
  });
});
