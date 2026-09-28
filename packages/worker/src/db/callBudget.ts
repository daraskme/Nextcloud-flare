/** Count D1 binding dispatches, including failed/ambiguous calls, before sending them.
 * A batch is one binding call; its individual SQL limits still apply separately.
 * This scope covers the caller's binding, not D1 calls made inside another DO invocation.
 */
export function d1CallBudget(db: D1Database, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_d1_call_budget");
  let calls = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const charge = () => {
    if (calls >= limit) throw new Error("d1_call_budget_exhausted");
    calls++;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (!["first", "all", "run", "raw"].includes(String(key)))
          throw new Error("unsupported_budgeted_d1_method");
        return (...args: unknown[]) => {
          charge();
          return value.apply(target, args);
        };
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  return {
    get calls() {
      return calls;
    },
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
        if (key === "batch")
          return (statements: D1PreparedStatement[]) => {
            const unwrapped = statements.map((s) => {
              const original = originals.get(s);
              if (!original) throw new Error("untracked_d1_statement");
              return original;
            });
            charge();
            return target.batch(unwrapped);
          };
        const value = Reflect.get(target, key);
        if (typeof value === "function") throw new Error("unsupported_budgeted_d1_method");
        return value;
      },
    }),
  };
}
