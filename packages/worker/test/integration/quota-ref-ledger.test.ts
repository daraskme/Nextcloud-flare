import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { reserveQuota } from "../../src/services/quota.js";
import { pinBlob } from "../../src/services/refs.js";
import { seedFoundation } from "../helpers/foundation.js";

describe("quota and reference ledger", () => {
  it("reserves atomically and rejects deleting blob pins", async () => {
    await seedFoundation();
    await reserveQuota(env, "user", 100);
    const user = await env.DB.prepare("SELECT reserved_bytes FROM users WHERE id='user'").first<{
      reserved_bytes: number;
    }>();
    expect(user?.reserved_bytes).toBe(100);

    await env.DB.prepare(
      "INSERT INTO blobs(id,owner_id,r2_key,size,content_etag,ref_count,state,created_at) VALUES('blob','user','u/user/b/blob',10,'etag',0,'deleting',?1)",
    )
      .bind(Date.now())
      .run();
    await expect(pinBlob(env, "pin", "blob", "fixture", null)).rejects.toThrow();
    const pins = await env.DB.prepare("SELECT pin_id FROM blob_pins").all();
    expect(pins.results).toEqual([]);
  });
});
