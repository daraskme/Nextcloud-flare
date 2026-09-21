import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { claimOutbox, completeOutbox } from "../../src/jobs/outbox.js";
import { seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES('outbox','operation','fixture','ref','pending',1,?1,?1)",
  )
    .bind(now)
    .run();
});

describe("outbox duplicate and ack loss", () => {
  it("claims once and replays completion with the same token", async () => {
    await expect(claimOutbox(env, "outbox", "token", 1)).resolves.toBe(true);
    await expect(claimOutbox(env, "outbox", "other", 1)).resolves.toBe(false);
    await expect(completeOutbox(env, "outbox", "token")).resolves.toBe(true);
    await expect(completeOutbox(env, "outbox", "token")).resolves.toBe(true);
  });
});
