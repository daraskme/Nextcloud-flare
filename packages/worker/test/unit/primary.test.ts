import { expect, it, vi } from "vitest";
import { atomicBatch, primary } from "../../src/db/primary";

it("keeps every authority read on direct D1 instead of a first-primary session", async () => {
  const statement = { bind: vi.fn().mockReturnThis() };
  const db = {
    prepare: vi.fn(() => statement),
    batch: vi.fn(async () => []),
    withSession: vi.fn(() => {
      throw new Error("replica session");
    }),
  } as unknown as D1Database;
  primary(db).prepare("SELECT 1");
  primary(db).prepare("SELECT 2");
  await atomicBatch(db, [{ sql: "UPDATE control SET epoch=2" }]);
  expect(db.withSession).not.toHaveBeenCalled();
  expect(db.prepare).toHaveBeenCalledTimes(3);
});
