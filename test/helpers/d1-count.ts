/**
 * Wraps a D1 binding and counts the statements it runs: each `first` / `all` / `run` / `raw`, and every
 * statement inside a `batch`. That is what Cloudflare counts against the per-invocation query limit
 * (50 on Workers Free), which miniflare does not enforce.
 */
export function countingD1(db: D1Database): { db: D1Database; count: () => number } {
  let n = 0;
  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            n++;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (prop === "__inner") return target;
        return Reflect.get(target, prop, receiver);
      },
    });
  const unwrap = (s: D1PreparedStatement): D1PreparedStatement => ((s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s);
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          n += stmts.length;
          return target.batch(stmts.map(unwrap));
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped, count: () => n };
}
