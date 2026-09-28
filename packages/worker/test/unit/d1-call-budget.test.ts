import { expect, it, vi } from "vitest";
import { d1CallBudget } from "../../src/db/callBudget";

function fixture() {
  const sent = vi.fn(async (..._args: unknown[]) => ({ success: true }));
  const statement = {
    bind: (..._values: unknown[]) => statement,
    first: sent,
    all: sent,
    run: sent,
    raw: sent,
  } as unknown as D1PreparedStatement;
  const batch = vi.fn(async (_statements: D1PreparedStatement[]) => []);
  const db = {
    prepare: () => statement,
    batch,
    withSession: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
  return { db, statement, sent, batch };
}
it("counts bound statement dispatches and a multi-statement batch without double charging", async () => {
  const f = fixture(),
    budget = d1CallBudget(f.db, 5),
    s = budget.db.prepare("SELECT ?").bind(1);
  expect(budget.calls).toBe(0);
  await s.first("id");
  await s.all();
  await s.run();
  await s.raw({ columnNames: true });
  await budget.db.batch([s, budget.db.prepare("SELECT 2")]);
  expect(budget.calls).toBe(5);
  expect(f.batch).toHaveBeenCalledWith([f.statement, f.statement]);
  expect(() => s.run()).toThrow("d1_call_budget_exhausted");
  expect(() => budget.db.batch([s])).toThrow("d1_call_budget_exhausted");
  expect(f.sent).toHaveBeenCalledTimes(4);
  expect(f.batch).toHaveBeenCalledTimes(1);
});
it("retains charges after ambiguous results, including a failed batch", async () => {
  const f = fixture(),
    budget = d1CallBudget(f.db, 2),
    s = budget.db.prepare("UPDATE example SET value=1");
  f.sent.mockRejectedValueOnce(new Error("lost_statement_ack"));
  f.batch.mockRejectedValueOnce(new Error("lost_batch_ack"));
  await expect(s.run()).rejects.toThrow("lost_statement_ack");
  await expect(budget.db.batch([s])).rejects.toThrow("lost_batch_ack");
  expect(budget.calls).toBe(2);
  expect(() => s.run()).toThrow("d1_call_budget_exhausted");
});
it("shares the same counter and cap when a caller passes its budgeted binding onward", async () => {
  const f = fixture(),
    budget = d1CallBudget(f.db, 2),
    s = budget.db.prepare("SELECT 1");
  await s.run();
  const nested = d1CallBudget(budget.db, 900);
  expect(nested).toBe(budget);
  expect(nested.limit).toBe(2);
  expect(nested.calls).toBe(1);
  await nested.db.batch([s]);
  expect(budget.calls).toBe(2);
  expect(() => s.run()).toThrow("d1_call_budget_exhausted");
  expect(f.sent).toHaveBeenCalledTimes(1);
  expect(f.batch).toHaveBeenCalledTimes(1);
});
it("can tighten an existing cap without forgetting spent calls or later expanding it", async () => {
  const f = fixture(),
    budget = d1CallBudget(f.db, 4),
    s = budget.db.prepare("SELECT 1");
  await s.run();
  await s.run();
  expect(d1CallBudget(budget.db, 1)).toBe(budget);
  expect(d1CallBudget(budget.db, 4).limit).toBe(1);
  expect(budget.calls).toBe(2);
  expect(() => s.run()).toThrow("d1_call_budget_exhausted");
  expect(() => budget.db.batch([s])).toThrow("d1_call_budget_exhausted");
  expect(f.sent).toHaveBeenCalledTimes(2);
  expect(f.batch).not.toHaveBeenCalled();
});
it("rejects escape APIs and statements outside the budget scope without dispatch", () => {
  const f = fixture(),
    budget = d1CallBudget(f.db, 2);
  for (const method of ["withSession", "exec", "dump"] as const)
    expect(() => budget.db[method]).toThrow("unsupported_budgeted_d1_method");
  expect(() => budget.db.batch([f.statement])).toThrow("untracked_d1_statement");
  expect(budget.calls).toBe(0);
  expect(f.batch).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid call budget %s", (limit) => {
  expect(() => d1CallBudget(fixture().db, limit)).toThrow("invalid_d1_call_budget");
});
