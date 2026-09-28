import { applyD1Migrations, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { CONTROL_NAME } from "../../src/do/controlName";
import { ControlShareUnlock, type ShareUnlockAttempt } from "../../src/do/controlShareUnlock";
import { EPOCH_PREFIX } from "../../src/do/epochHistory";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

function fixture() {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(`unlock-rate-${crypto.randomUUID()}`));
  let now = 1800000000000,
    open = true,
    epoch = 1,
    initialized = false;
  const invoke = async (request: ShareUnlockAttempt) =>
    runInDurableObject(stub, async (_, state) => {
      if (!initialized) {
        state.storage.sql.exec("DELETE FROM share_unlock_clock");
        state.storage.sql.exec("DELETE FROM share_unlock_rates");
        initialized = true;
      }
      const rates = new ControlShareUnlock(
        state.storage,
        (e) => {
          if (!open || e !== epoch) throw new Error("closed");
        },
        () => now,
      );
      try {
        return await rates.admit(request);
      } catch {
        return { error: true };
      }
    });
  return {
    stub,
    setTime: (time: number) => {
      now = time;
    },
    close: () => {
      open = false;
    },
    newEpoch: () => {
      epoch++;
    },
    warm: async () => {
      await invoke({ shareId: "warmup", clientIp: "192.0.2.1", epoch, deadline: now + 5000 });
      now += 60000;
    },
    admit: (shareId = "share", clientIp = "192.0.2.1", options: Partial<ShareUnlockAttempt> = {}) =>
      invoke({ shareId, clientIp, epoch: 1, deadline: now + 5000, ...options }),
  };
}
it("enforces a rolling ten-attempt share window across IP changes, restarts and exact boundaries", async () => {
  const f = fixture();
  expect(await f.admit()).toEqual({ allowed: false, retryAfter: 60 });
  f.setTime(1800000060000);
  for (let n = 0; n < 10; n++)
    expect(await f.admit("share", `192.0.2.${n}`)).toEqual({ allowed: true });
  await evictDurableObject(f.stub);
  expect(await f.admit("share", "198.51.100.1")).toEqual({ allowed: false, retryAfter: 60 });
  f.setTime(1800000119999);
  expect(await f.admit()).toEqual({ allowed: false, retryAfter: 1 });
  f.setTime(1800000120000);
  expect(await f.admit()).toEqual({ allowed: true });
});
it("limits one canonical IP to thirty attempts across different shares", async () => {
  const f = fixture();
  await f.warm();
  for (let n = 0; n < 30; n++)
    expect(await f.admit(`share${n}`, "2001:0DB8:0:0:0:0:0:1")).toEqual({ allowed: true });
  expect(await f.admit("other", "2001:db8::1")).toEqual({ allowed: false, retryAfter: 60 });
  expect(await f.admit("other", "2001:db8::2")).toEqual({ allowed: true });
  const stored = await runInDurableObject(f.stub, (_, state) =>
    state.storage.sql.exec("SELECT * FROM share_unlock_rates").toArray(),
  );
  expect(JSON.stringify(stored)).not.toContain("2001:");
});
it("serializes simultaneous attempts and does not reset counts on an epoch change", async () => {
  const f = fixture();
  await f.warm();
  const results = await Promise.all(Array.from({ length: 15 }, () => f.admit()));
  expect(results.filter((r) => "allowed" in r && r.allowed)).toHaveLength(10);
  f.newEpoch();
  expect(await f.admit()).toEqual({ error: true });
  expect(await f.admit("share", "192.0.2.2", { epoch: 2 })).toEqual({
    allowed: false,
    retryAfter: 60,
  });
});
it("refuses closed admission, expired RPCs and clock rollback without refunding attempts", async () => {
  const f = fixture();
  await f.warm();
  expect(await f.admit()).toEqual({ allowed: true });
  f.setTime(1800000059999);
  expect(await f.admit()).toEqual({ error: true });
  f.setTime(1800000060000);
  expect(await f.admit("share", "192.0.2.1", { deadline: 1800000060000 })).toEqual({ error: true });
  f.close();
  expect(await f.admit()).toEqual({ error: true });
});
it("holds a full window after complete ledger loss and bounds the persisted key count", async () => {
  const f = fixture();
  await f.warm();
  await runInDurableObject(f.stub, (_, state) => {
    state.storage.sql.exec("DELETE FROM share_unlock_clock");
    state.storage.sql.exec("DELETE FROM share_unlock_rates");
  });
  expect(await f.admit()).toEqual({ allowed: false, retryAfter: 60 });
  f.setTime(1800000120000);
  await runInDurableObject(f.stub, (_, state) =>
    state.storage.sql.exec(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<4096) INSERT INTO share_unlock_rates SELECT 'full:'||i,'[1800000120000]',1800000180000 FROM n`,
    ),
  );
  expect(await f.admit()).toEqual({ allowed: false, retryAfter: 60 });
  f.setTime(1800000180000);
  expect(await f.admit()).toEqual({ allowed: true });
});
it("uses the actual singleton RPC and rejects a changed D1 maintenance mirror", async () => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.BACKUPS.put(
    `${EPOCH_PREFIX}1.json`,
    JSON.stringify({ epoch: 1, at: 1, reason: "operator" }),
  );
  const { epoch } = await stub.recover();
  await stub.beginRecoveryAudit(epoch);
  let done = false;
  for (let i = 0; i < 20 && !done; i++) done = (await stub.nextRecoveryAuditPage(epoch)).completed;
  expect(done).toBe(true);
  await stub.resumeAdmission(epoch);
  // Simulate expiry of the fresh-ledger cooldown without weakening production admission.
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("UPDATE share_unlock_clock SET not_before=0"),
  );
  const request = () => ({
    shareId: "share",
    clientIp: "192.0.2.1",
    epoch,
    deadline: Date.now() + 5000,
  });
  for (let n = 0; n < 10; n++)
    expect(await stub.admitShareUnlock(request())).toEqual({ allowed: true });
  await evictDurableObject(stub);
  expect(await stub.admitShareUnlock(request())).toMatchObject({ allowed: false });
  await env.DB.prepare("UPDATE control SET maintenance=1").run();
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.admitShareUnlock(request())).rejects.toThrow("control_mirror_conflict");
  });
});
