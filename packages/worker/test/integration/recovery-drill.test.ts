import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { beginRecovery, finishRecovery } from "../../src/backup/recovery.js";
import { getRuntimeControl } from "../../src/services/control.js";
import { seedFoundation } from "../helpers/foundation.js";

beforeEach(async () => {
  await seedFoundation();
});

describe("recovery drill", () => {
  it("quiesces admission, preserves terminal operations, bumps epoch, and verifies before reopen", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO permits(permit_id,space_id,epoch,expires_at,state) VALUES('terminal-permit','space',1,?1,'released')",
      ).bind(now + 30_000),
      env.DB.prepare(
        "INSERT INTO operations(op_id,principal_kind,principal_id,credential_id,space_id,kind,state,request_digest,epoch,permit_id,permit_expires_at,claimed_expires_at,expected_steps,result_json,created_at,updated_at) VALUES('terminal','user','user','as:session','space','node.create','committed','digest',1,'terminal-permit',?1,?1,0,'{\"ok\":true}',?2,?2)",
      ).bind(now + 30_000, now),
    ]);
    await beginRecovery(env, {
      id: "recovery",
      kind: "time_travel",
      sourceGeneration: "bookmark",
    });
    const paused = await getRuntimeControl(env);
    expect(paused).toMatchObject({ maintenance: true, gcPaused: true });
    const lock = env.LOCKS.get(env.LOCKS.idFromName("space"));
    const permit = await lock.fetch("https://lock.test/permits", {
      method: "POST",
      body: JSON.stringify({ permitId: "blocked", spaceId: "space", epoch: 1, ttlMs: 5000 }),
    });
    expect(permit.status).toBe(503);

    const verification = await finishRecovery(env, "recovery");
    expect(verification).toEqual({
      rootViolations: 0,
      refViolations: 0,
      quotaViolations: 0,
      missingObjects: [],
    });
    const reopened = await getRuntimeControl(env);
    expect(reopened.epoch).toBeGreaterThan(1);
    expect(reopened).toMatchObject({ maintenance: false, gcPaused: false });
    const terminal = await env.DB.prepare(
      "SELECT state,result_json FROM operations WHERE op_id='terminal'",
    ).first();
    expect(terminal).toEqual({ state: "committed", result_json: '{"ok":true}' });
    const run = await env.DB.prepare(
      "SELECT state,epoch_before,epoch_after FROM recovery_runs WHERE id='recovery'",
    ).first<{ state: string; epoch_before: number; epoch_after: number }>();
    expect(run?.state).toBe("verified");
    expect(run?.epoch_after).toBeGreaterThan(run?.epoch_before ?? 0);
  });
});
