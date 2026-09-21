import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { atomicBatch } from "../../src/db/primary";
import { createProbeSchema, mutationProbe, resetProbe, snapshot } from "../fixtures/d1-probe";

beforeAll(createProbeSchema);
beforeEach(resetProbe);

it.each([
  ["expired-open permit", "UPDATE permits SET expires_at=(strftime('%s','now')*1000)-1"],
  ["revoked permit / old worker", "UPDATE permits SET state='revoked'"],
  ["released permit", "UPDATE permits SET state='released'"],
  ["wrong space", "UPDATE permits SET space_id='other'"],
  ["old epoch", "UPDATE control SET epoch=2"],
  ["revoked credential at commit", "UPDATE sessions SET revoked_at=1"],
  ["expired session", "UPDATE sessions SET expires_at=1"],
  ["disabled actor", "UPDATE users SET disabled_at=1"],
])("rejects %s without changing any ledger", async (_name, sql) => {
  await atomicBatch(env.DB, [{ sql: "INSERT INTO spaces VALUES('other','user',1)" }, { sql }]);
  const before = await snapshot();
  await expect(atomicBatch(env.DB, mutationProbe("changes"))).rejects.toThrow(
    /CHECK constraint failed/,
  );
  expect(await snapshot()).toEqual(before);
});

it("enforces foreign keys and non-negative counters", async () => {
  await expect(env.DB.prepare("UPDATE nodes SET space_id='missing'").run()).rejects.toThrow(
    /FOREIGN KEY/,
  );
  await expect(env.DB.prepare("UPDATE users SET used_bytes=-1").run()).rejects.toThrow(/CHECK/);
});
