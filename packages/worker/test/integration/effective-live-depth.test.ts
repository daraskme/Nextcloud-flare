import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { isEffectiveLive } from "../../src/services/effectiveLive.js";
import { seedFoundation } from "../helpers/foundation.js";

beforeEach(() => seedFoundation());

describe("EffectiveLive depth", () => {
  it("accepts depth 64 and rejects depth 65", async () => {
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (let depth = 1; depth <= 64; depth += 1) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,deleted_at,hidden) VALUES(?1,'space','user',?2,?3,?3,'folder',NULL,1,?4,?4,NULL,0)",
        ).bind(`n${depth}`, depth === 1 ? "root" : `n${depth - 1}`, `n${depth}`, now),
      );
    }
    await env.DB.batch(statements);
    await expect(isEffectiveLive(env, "n64", "root")).resolves.toBe(true);
    await env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,created_at,updated_at,deleted_at,hidden) VALUES('n65','space','user','n64','n65','n65','folder',NULL,1,?1,?1,NULL,0)",
    )
      .bind(now)
      .run();
    await expect(isEffectiveLive(env, "n65", "root")).resolves.toBe(false);
  });
});
