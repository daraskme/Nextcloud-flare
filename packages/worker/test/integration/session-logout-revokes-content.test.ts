import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { logoutAccessSession } from "../../src/auth/sessions.js";
import { seedFoundation } from "../helpers/foundation.js";

beforeEach(() => seedFoundation());

describe("Access session logout", () => {
  it("revokes the session and every derived content session", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO content_target_sets(id,owner_id,target_hash,targets_json,created_at,expires_at) VALUES('targets','user','hash','[]',?1,?2)",
      ).bind(now, now + 10_000),
      env.DB.prepare(
        "INSERT INTO content_sessions(id,user_id,share_id,share_version,issued_by_credential_id,target_set_id,budget_id,epoch,issued_at,expires_at,revoked_at) VALUES('content','user',NULL,NULL,'session','targets','u:user',1,?1,?2,NULL)",
      ).bind(now, now + 10_000),
    ]);
    await logoutAccessSession(env, "session", "user", now + 1);

    const rows = await env.DB.prepare(
      "SELECT s.revoked_at session_revoked,c.revoked_at content_revoked FROM sessions s JOIN content_sessions c ON c.issued_by_credential_id=s.id WHERE s.id='session'",
    ).first<{ session_revoked: number | null; content_revoked: number | null }>();
    expect(rows?.session_revoked).toBe(now + 1);
    expect(rows?.content_revoked).toBe(now + 1);
  });
});
