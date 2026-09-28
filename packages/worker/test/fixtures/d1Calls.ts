/** Count binding calls separately from SQL statements; pass only to the caller being measured. */
export function measureD1(db: D1Database) {
  const counts = { calls: 0, statements: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const charge = (statements: number) => {
    counts.calls++;
    counts.statements += statements;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (["first", "all", "run", "raw"].includes(String(key))) charge(1);
          return value.apply(target, args);
        };
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  return {
    counts,
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
        if (["withSession", "exec", "dump"].includes(String(key)))
          throw new Error("unmeasured_d1_method");
        if (key === "batch")
          return (statements: D1PreparedStatement[]) => {
            charge(statements.length);
            return target.batch(statements.map((s) => originals.get(s) ?? s));
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
