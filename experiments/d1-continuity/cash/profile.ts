// Authenticated lab-only binding measurements; never changes SQL or results.
export function cashProfiler(env: any) {
  const started = Date.now();
  const statements = new WeakMap<object, { raw: any; sql: string }>();
  const calls: any[] = [];
  async function measure(
    role: string,
    method: string,
    count: number,
    fn: () => Promise<any>,
  ) {
    const begin = Date.now();
    const call = {
      role,
      method,
      statements: count,
      startMs: begin - started,
      ms: 0,
      ok: false,
    };
    calls.push(call);
    try {
      const result = await fn();
      call.ok = true;
      return result;
    } finally {
      call.ms = Date.now() - begin;
    }
  }
  function wrap(raw: any, role: string): any {
    const statement = (item: any, sql: string) => {
      const wrapped: any = {
        bind(...args: any[]) {
          return statement(item.bind(...args), sql);
        },
      };
      for (const method of ["first", "all", "run", "raw"])
        wrapped[method] = (...args: any[]) =>
          measure(role, method, 1, () => item[method](...args));
      statements.set(wrapped, { raw: item, sql });
      return wrapped;
    };
    return {
      ...(raw.withSession
        ? {
            withSession(mode: string) {
              return wrap(raw.withSession(mode), role);
            },
          }
        : {}),
      prepare(sql: string) {
        return statement(raw.prepare(sql), sql);
      },
      batch(items: any[]) {
        const native = items.map((item) => {
          const found = statements.get(item);
          if (!found) throw Error("PROFILE_UNKNOWN_STATEMENT");
          return found.raw;
        });
        return measure(role, "batch", items.length, () => raw.batch(native));
      },
    };
  }
  return {
    env: {
      ...env,
      DB: wrap(env.DB, "primary"),
      ...(env.RECOVERY_LOG
        ? { RECOVERY_LOG: wrap(env.RECOVERY_LOG, "journal") }
        : {}),
    },
    result() {
      return {
        wallMs: Date.now() - started,
        rpcCount: calls.length,
        sqlCount: calls.reduce((sum, call) => sum + call.statements, 0),
        calls,
      };
    },
  };
}
