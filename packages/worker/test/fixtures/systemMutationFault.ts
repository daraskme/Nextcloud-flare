import { env } from "cloudflare:workers";

/** Inject only the domain envelope, leaving coordinator admission and unrelated batches intact. */
export function systemMutationFault(
  prefix: string,
  mode: "ack" | "rollback" | "reads",
  nth = 1,
  base = env.DB,
) {
  const parameters = new WeakMap<object, unknown[]>();
  let hits = 0,
    fired = false,
    reads = 0;
  const db = {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind")
              return (...values: unknown[]) => {
                const bound = wrap(target.bind(...values));
                parameters.set(bound, values);
                return bound;
              };
            if (key === "first")
              return (...args: unknown[]) => {
                if (sql.includes("committed_at IS NOT NULL")) {
                  reads++;
                  if (mode === "reads") throw new Error("receipt_unavailable");
                }
                return Reflect.apply(target.first, target, args);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(base.prepare(sql));
    },
    async batch(statements: D1PreparedStatement[]) {
      const matches = statements.some((s) =>
        parameters.get(s)?.some((v) => typeof v === "string" && v.startsWith(prefix)),
      );
      const hit = matches && ++hits === nth;
      if (hit) fired = true;
      const result = await base.batch(
        hit && mode === "rollback"
          ? [...statements, base.prepare("INSERT INTO _assert(v) VALUES(1)")]
          : statements,
      );
      if (hit) throw new Error("domain_ack_lost");
      return result;
    },
  } as unknown as D1Database;
  return { db, fired: () => fired, reads: () => reads };
}
