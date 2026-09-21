import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { isLiveJobCredential } from "../../src/auth/sessions.js";
import { seedClaimedOperation, seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
  await seedClaimedOperation();
});

describe("job credential fence", () => {
  it("stops the next chunk after its Access session is revoked", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO job_leases(job_id,operation_id,credential_id,claim_token,claim_expires_at,epoch,state,checkpoint,updated_at) VALUES('job','operation','session','token',?1,1,'claimed',NULL,?2)",
    )
      .bind(now + 10_000, now)
      .run();
    await expect(isLiveJobCredential(env, "job", now)).resolves.toBe(true);
    await env.DB.prepare("UPDATE sessions SET revoked_at=?1 WHERE id='session'")
      .bind(now + 1)
      .run();
    await expect(isLiveJobCredential(env, "job", now + 2)).resolves.toBe(false);
  });
});
