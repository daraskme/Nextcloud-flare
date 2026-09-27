import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { NativeHistory, nativeIdentity } from "../../src/do/nativeHistory";

it("keeps immutable domain-separated evidence across eviction without private inputs", async () => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName(crypto.randomUUID())),
    identity = await nativeIdentity("kdf", ["invocation", "token", 1]);
  await runInDurableObject(stub, async (_, state) => {
    const history = new NativeHistory(state.storage.sql);
    history.remember(identity, "finished", 5000);
    history.remember(identity, "finished", 5000);
    expect(() => history.remember(identity, "not_started", 5000)).toThrow(/conflict/);
    expect(() => history.remember(identity, "finished", 5001)).toThrow(/conflict/);
    expect(() =>
      state.storage.sql.exec("UPDATE control_native_history SET outcome='not_started'"),
    ).toThrow(/immutable/);
    expect(() => state.storage.sql.exec("DELETE FROM control_native_history")).toThrow(/retained/);
    expect(
      state.storage.sql.exec("SELECT entries FROM control_native_history_usage").one().entries,
    ).toBe(1);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_, state) => {
    const history = new NativeHistory(state.storage.sql);
    expect(history.find(identity)).toEqual({ outcome: "finished", deadline: 5000 });
    expect(history.find(await nativeIdentity("r2", ["invocation", "token", 1]))).toBeUndefined();
    expect(
      Object.keys(state.storage.sql.exec("SELECT * FROM control_native_history").one()).sort(),
    ).toEqual(["archived_at", "deadline", "identity", "outcome"]);
  });
});

it.each([false, true])(
  "bounds old-proof pruning to 32 and pins active restore evidence: %s",
  async (restoring) => {
    const stub = env.CONTROL.get(env.CONTROL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (_, state) => {
      const history = new NativeHistory(state.storage.sql);
      const identities = await Promise.all(
        Array.from({ length: 34 }, (_, n) => nativeIdentity("r2", [n])),
      );
      for (const identity of identities)
        state.storage.sql.exec(
          "INSERT INTO control_native_history VALUES(?,'succeeded',5000,strftime('%s','now')*1000-37*86400000)",
          identity,
        );
      if (restoring)
        state.storage.sql.exec(
          "INSERT INTO control_database_restore(id,epoch,source_json,phase,created_at) VALUES(?,1,'{}','preparing',1)",
          crypto.randomUUID(),
        );
      history.remember(await nativeIdentity("kdf", ["new"]), "not_started", 5000);
      expect(
        state.storage.sql.exec("SELECT entries FROM control_native_history_usage").one().entries,
      ).toBe(restoring ? 35 : 3);
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS n FROM control_native_history").one().n,
      ).toBe(restoring ? 35 : 3);
    });
  },
);
