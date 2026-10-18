// Only imported by the isolated integration test entry, never by the Worker.
export function cashTestBindings(env: any, request: Request, state: any) {
  const entries = new WeakMap<object, { raw: any; sql: string }>();
  const fault = request.headers.get("x-cash-fault");
  let queries = 0,
    droppedPrimaryReply = false;
  const wait = async (ready: () => boolean, code: string) => {
    for (let i = 0; !ready(); i++) {
      if (i >= 500) throw Error(code);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const before = async (sql: string[], isLog: boolean) => {
    if (
      isLog &&
      fault === "hold-journal" &&
      sql.some((s) => s.startsWith("INSERT INTO cashJournalCommitted"))
    ) {
      state.waiting = true;
      await wait(() => state.released, "TEST_ACK_HOLD_TIMEOUT");
    }
    if (
      isLog &&
      fault === "old-primary-new-journal" &&
      sql.some((s) => s.includes("COUNT(*) AS count"))
    )
      await wait(() => state.preflightReleased, "TEST_PREFLIGHT_HOLD_TIMEOUT");
  };
  const after = async (sql: string[], isLog: boolean) => {
    if (
      !isLog &&
      fault === "writer-reset-after-primary" &&
      sql.some((s) => s.startsWith("INSERT INTO cashCommands"))
    ) {
      state.restartWaiting = true;
      await wait(
        () => state.restartReleased,
        "TEST_WRITER_RESTART_HOLD_TIMEOUT",
      );
      state.abort(); // Native DurableObjectState.abort; test module only.
    }
    if (
      isLog &&
      fault === "delay-prefix" &&
      sql.some((s) => s.includes("COUNT(*) AS count"))
    ) {
      state.prefixReaders++;
      await wait(() => state.prefixReaders >= 2, "TEST_PREFIX_BARRIER_TIMEOUT");
    }
    if (
      !isLog &&
      fault === "old-primary-new-journal" &&
      sql.some((s) => s === "SELECT epoch FROM cashEpoch WHERE id=1")
    ) {
      state.preflightWaiting = true;
      await wait(
        () => state.preflightReleased,
        "TEST_PRIMARY_PREFLIGHT_TIMEOUT",
      );
    }
    if (
      !isLog &&
      fault === "drop-response" &&
      !droppedPrimaryReply &&
      sql.some((s) => s.startsWith("INSERT INTO cashCommands"))
    ) {
      droppedPrimaryReply = true;
      throw Error("SIMULATED_PRIMARY_BATCH_RESPONSE_LOST");
    }
  };
  const wrap = (raw: any, isLog = false, session: any = {}): any => {
    const statement = (item: any, sql: string) => {
      const out: any = {
        bind(...args: any[]) {
          return statement(item.bind(...args), sql);
        },
      };
      for (const method of ["first", "all", "run", "raw"])
        out[method] = async (...args: any[]) => {
          // A reused session may read its earlier epoch from a replica.
          if (
            !isLog &&
            fault === "old-primary-new-journal" &&
            method === "first" &&
            sql === "SELECT epoch FROM cashEpoch WHERE id=1" &&
            session.capturedEpoch !== undefined
          )
            return { epoch: session.capturedEpoch };
          await before([sql], isLog);
          const result = await item[method](...args);
          await after([sql], isLog);
          return result;
        };
      entries.set(out, { raw: item, sql });
      return out;
    };
    return {
      ...(raw.withSession
        ? {
            withSession(mode: string) {
              return wrap(raw.withSession(mode), isLog);
            },
          }
        : {}),
      prepare(sql: string) {
        queries++;
        return statement(raw.prepare(sql), sql);
      },
      async batch(items: any[]) {
        const found = items.map((item) => {
          const entry = entries.get(item);
          if (!entry) throw Error("TEST_UNKNOWN_BATCH_STATEMENT");
          return entry;
        });
        const sql = found.map((item) => item.sql);
        await before(sql, isLog);
        const result = await raw.batch(found.map((item) => item.raw));
        const epochIndex = sql.indexOf(
          "SELECT epoch FROM cashEpoch WHERE id=1",
        );
        if (epochIndex >= 0)
          session.capturedEpoch = result[epochIndex].results[0].epoch;
        await after(sql, isLog);
        return result;
      },
    };
  };
  return {
    env: {
      ...env,
      DB: wrap(env.DB),
      ...(env.RECOVERY_LOG
        ? { RECOVERY_LOG: wrap(env.RECOVERY_LOG, true) }
        : {}),
    },
    counts: () => ({ queries, droppedPrimaryReply }),
  };
}
