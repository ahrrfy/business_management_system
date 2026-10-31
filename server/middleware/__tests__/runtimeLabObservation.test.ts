import { EventEmitter } from "node:events";
import mysql from "mysql2";
import { channel } from "node:diagnostics_channel";
import { afterEach, expect, it, vi } from "vitest";
import { WorkDrain } from "../../lib/workDrain";
import { createResourceAdmission } from "../../lib/resourceAdmission";
import { storefrontCacheGet } from "../../lib/storefrontCachePolicy";
import { createTtlCache } from "../../lib/ttlCache";
import {
  createRuntimeLabObservation,
  runtimeLabProcedureLabel,
  validateRuntimeLabObservationFlags,
} from "../../../scripts/storefront-runtime-lab-observation.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function probe(maxRequests = 512) {
  let time = 0;
  const observation = createRuntimeLabObservation({
    now: () => time,
    maxRequests,
  });
  cleanups.push(observation.subscribe());
  return {
    observation,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const request = (url = "/api/trpc/storefront.quoteOrder") => ({
  url,
  headers: { authorization: "secret-token", cookie: "private-cookie" },
});

it("validates isolated lab flags and retains only finite labels", () => {
  expect(validateRuntimeLabObservationFlags({})).toEqual({
    readCacheEnabled: false,
    diagnosticsEnabled: false,
  });
  expect(
    validateRuntimeLabObservationFlags({
      RUNTIME_LAB_READ_CACHE: "1",
      RUNTIME_LAB_DIAGNOSTICS: "1",
    }),
  ).toEqual({ readCacheEnabled: true, diagnosticsEnabled: true });
  for (const key of ["RUNTIME_LAB_READ_CACHE", "RUNTIME_LAB_DIAGNOSTICS"])
    for (const value of ["yes", "true", "2", " 1"])
      expect(() =>
        validateRuntimeLabObservationFlags({ [key]: value }),
      ).toThrow(`Invalid ${key}`);
  expect(
    runtimeLabProcedureLabel(
      request("/api/trpc/storefront.quoteOrder?input=private-payload"),
    ),
  ).toBe("quote");
  expect(
    runtimeLabProcedureLabel({
      url: "/api/trpc/storefront.createOrder",
      headers: { "x-runtime-lab-kind": "replay" },
    }),
  ).toBe("replay");
  expect(runtimeLabProcedureLabel(request("/customer/private-id"))).toBe(
    "other",
  );
});
it("wraps the actual request event without changing listener order, receiver, return or thrown errors", () => {
  const { observation } = probe();
  const prototype = { emit: EventEmitter.prototype.emit };
  cleanups.push(observation.installHttp(prototype));
  const server = new EventEmitter();
  server.emit = prototype.emit;
  const response = new EventEmitter(),
    calls: string[] = [];
  server.on("request", function (this: EventEmitter, _req, res) {
    expect(this).toBe(server);
    calls.push("first");
    res.emit("finish");
  });
  server.on("request", () => calls.push("second"));
  expect(server.emit("request", request(), response)).toBe(true);
  expect(calls).toEqual(["first", "second"]);
  expect(observation.drain().requests).toHaveLength(1);
  const error = new Error("application failure");
  server.on("error", () => {
    throw error;
  });
  expect(() => server.emit("error", error)).toThrow(error);
});
it("keeps deferred non-SQL root and detached child work alive after HTTP disconnect", async () => {
  const { observation, advance } = probe();
  const drain = new WorkDrain();
  const hold = deferred(),
    tail = deferred(),
    response = new EventEmitter();
  let work!: Promise<void>, child!: Promise<void>;
  observation.runRequest(request(), response, () => {
    work = drain.run(async () => {
      await hold.promise;
      child = drain.run(async () => {
        await tail.promise;
      });
    });
  });
  advance(5);
  response.emit("close");
  expect(observation.drain()).toMatchObject({
    requests: [],
    active: [{ ended: false, work: 1 }],
  });
  advance(20);
  hold.resolve();
  await work;
  expect(observation.drain()).toMatchObject({
    requests: [],
    active: [{ work: 1 }],
  });
  advance(30);
  tail.resolve();
  await child;
  expect(observation.drain()).toMatchObject({
    active: [],
    requests: [{ responseEndMs: 5, endMs: 55, workScopes: 2 }],
  });
  await drain.wait(50);
});
it("separates queue admission, acquisition wait and whole transaction hold, counting only physical statements", async () => {
  const { observation, advance } = probe();
  const drain = new WorkDrain();
  const gate = createResourceAdmission({
    mode: "enforce",
    maxActiveCost: 6,
    publicMaxActiveCost: 4,
    readMaxActiveCost: 4,
    orderMaxActiveCost: 2,
    maxQueued: 2,
    maxQueuedCost: 4,
    queueTimeoutMs: 500,
  });
  const active = await gate.acquire("public-order", 2);
  let acquire!: (error: Error | null, connection?: any) => void;
  const release = vi.fn(),
    statements: ((error?: Error) => void)[] = [];
  const query = vi.fn((_sql: string, _params: unknown, cb: any) => {
    statements.push(cb);
    return "command";
  });
  const connection = {
    query,
    execute: query,
    release,
    beginTransaction(cb: any) {
      return this.query("BEGIN private", [], cb);
    },
    rollback(cb: any) {
      return this.query("ROLLBACK private", [], cb);
    },
  };
  const raw = {
    getConnection(cb: any) {
      acquire = cb;
    },
  };
  cleanups.push(observation.instrumentPool(raw));
  const response = new EventEmitter();
  let work!: Promise<void>, caught: Error | undefined;
  observation.runRequest(request(), response, () => {
    work = drain.run(async () => {
      const ticket = await gate.acquire("public-order", 2);
      const c = await new Promise<any>((resolve, reject) =>
        raw.getConnection((e: Error, c: any) => (e ? reject(e) : resolve(c))),
      );
      try {
        await new Promise<void>((resolve, reject) =>
          c.beginTransaction((e: Error) => (e ? reject(e) : resolve())),
        );
        await new Promise<void>((resolve, reject) =>
          c.execute("SELECT secret SQL", ["secret parameter"], (e: Error) =>
            e ? reject(e) : resolve(),
          ),
        );
      } catch (error) {
        caught = error as Error;
        await new Promise<void>((resolve) => c.rollback(resolve));
      } finally {
        c.release();
        ticket.release();
      }
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 12));
  active.release();
  await new Promise(setImmediate);
  advance(20);
  response.emit("close");
  expect(observation.drain().active[0].sql.statements).toBe(0);
  // Callback delivered in a different request context must retain the acquiring owner.
  observation.runRequest(request("/healthz"), new EventEmitter(), () =>
    acquire(null, connection),
  );
  await new Promise(setImmediate);
  advance(30);
  statements.shift()!();
  await new Promise(setImmediate);
  advance(40);
  const failure = new Error("private database failure");
  statements.shift()!(failure);
  await new Promise(setImmediate);
  advance(10);
  statements.shift()!();
  await work;
  const evidence = observation.drain(),
    record = evidence.requests.find(r => r.label === "quote");
  if (!record) throw new Error("Missing quote observation");
  expect(record).toMatchObject({
    responseEndMs: 20,
    endMs: 100,
    sql: {
      acquisitions: 1,
      waitTotalMs: 20,
      holdTotalMs: 80,
      statements: 3,
      statementErrors: 1,
      statementTotalMs: 80,
      leaseSamples: [
        {
          poolId: 1,
          connectionId: 1,
          queuedMs: 0,
          acquiredMs: 20,
          releasedMs: 100,
          statements: 3,
          statementErrors: 1,
        },
      ],
    },
    admission: { starts: 1, grants: 1 },
  });
  expect(record.admission.waitTotalMs).toBeGreaterThanOrEqual(8);
  expect(caught).toBe(failure);
  expect(release).toHaveBeenCalledTimes(1);
  expect(connection.query).toBe(query);
  expect(connection.execute).toBe(query);
  expect(connection.release).toBe(release);
  expect(gate.snapshot().activeCost).toBe(0);
  expect(JSON.stringify(evidence)).not.toMatch(
    /secret|private|SELECT|ROLLBACK|BEGIN|cookie|authorization|parameter/,
  );
});
it("restores a physical connection before its release synchronously grants the next FIFO lease", () => {
  const { observation, advance } = probe();
  let queued!: any;
  const query = vi.fn((_q, cb) => {
    cb(null);
    return "result";
  });
  const connection: any = {
    query,
    release: vi.fn(() => {
      if (queued) {
        const next = queued;
        queued = null;
        next(null, connection);
      }
    }),
  };
  let first = true;
  const raw = {
    getConnection(cb: any) {
      if (first) {
        first = false;
        cb(null, connection);
      } else queued = cb;
    },
  };
  cleanups.push(observation.instrumentPool(raw));
  const a = new EventEmitter(),
    b = new EventEmitter();
  let c!: any;
  observation.runRequest(request(), a, () =>
    raw.getConnection((_e: any, conn: any) => {
      c = conn;
      conn.query("ignored", () => {});
    }),
  );
  advance(5);
  observation.runRequest(request("/api/trpc/storefront.catalog"), b, () =>
    raw.getConnection((_e: any, conn: any) => {
      conn.query("ignored", () => {});
      conn.release();
      b.emit("finish");
    }),
  );
  advance(7);
  c.release();
  a.emit("finish");
  const records = observation.drain().requests;
  const quoteRecord = records.find(r => r.label === "quote");
  const catalogRecord = records.find(r => r.label === "catalog");
  if (!quoteRecord || !catalogRecord) throw new Error("Missing request observations");
  expect(quoteRecord.sql).toMatchObject({
    statements: 1,
    holdTotalMs: 12,
  });
  expect(catalogRecord.sql).toMatchObject({
    statements: 1,
    waitTotalMs: 7,
    holdTotalMs: 0,
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(connection.release).toHaveBeenCalledTimes(2);
});
it("keeps callback and synchronous driver failures intact and never retains SQL or params", () => {
  const { observation } = probe();
  const failure = new Error("secret");
  const release = vi.fn(),
    connection = {
      query: () => {
        throw failure;
      },
      release,
    };
  const raw = { getConnection: (cb: any) => cb(null, connection) };
  cleanups.push(observation.instrumentPool(raw));
  const response = new EventEmitter();
  expect(() =>
    observation.runRequest(request(), response, () =>
      raw.getConnection((_e: any, c: any) => {
        try {
          c.query("secret SQL", ["private"]);
        } finally {
          c.release();
          response.emit("finish");
        }
      }),
    ),
  ).toThrow(failure);
  expect(observation.drain().requests[0].sql).toMatchObject({
    statements: 1,
    statementErrors: 1,
  });
  expect(release).toHaveBeenCalledTimes(1);
  const callbackError = new Error("callback error");
  expect(() =>
    raw.getConnection(() => {
      throw callbackError;
    }),
  ).toThrow(callbackError);
});
it("bounds active and completed records together with explicit truncation and catches malformed diagnostics", () => {
  const { observation } = probe(2);
  for (let n = 0; n < 100; n++)
    observation.runRequest(
      request(`/unknown/${n}?secret=payload`),
      new EventEmitter(),
      () => {},
    );
  expect(observation.drain()).toMatchObject({
    maxRequests: 2,
    truncated: true,
    dropped: 98,
  });
  expect(observation.drain().active).toHaveLength(2);
  channel("erp.storefront.read-cache").publish(null);
  expect(observation.drain().failures).toBe(1);
});
it("counts real cache loader reuse without emitting cache keys, errors or values", async () => {
  const { observation } = probe();
  const cache = createTtlCache<string, string[]>({ ttlMs: 5_000 });
  const load = vi.fn(async () => ["private-value"]);
  await Promise.all([
    storefrontCacheGet(cache, "index", "private-company", load),
    storefrontCacheGet(cache, "index", "private-company", load),
  ]);
  await storefrontCacheGet(cache, "index", "private-company", load);
  const snapshot = observation.drain();
  expect(snapshot.caches.index).toMatchObject({
    gets: 3,
    loads: 1,
    loaded: 1,
    getsWithoutLoaderStart: 2,
    entries: 1,
    inFlight: 0,
  });
  expect(load).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(snapshot)).not.toContain("private");
});

function driverPool(observation: any) {
  // Exercise the installed public Pool.query implementation, without opening a socket.
  const pool = mysql.createPool({});
  let command: any;
  const connection: any = new EventEmitter();
  connection.query = vi.fn((value) => {
    command = value;
    return value;
  });
  connection.release = vi.fn();
  connection.destroy = vi.fn(() => "destroyed");
  pool.getConnection = ((cb: any) => cb(null, connection)) as any;
  cleanups.push(observation.instrumentPool(pool));
  return { pool, connection, command: () => command };
}

it.each([false, true])(
  "observes real mysql2 Pool.query command-object success/error exactly once (%s)",
  (fails) => {
    const { observation, advance } = probe();
    const { pool, connection, command } = driverPool(observation);
    const response = new EventEmitter();
    const failure = Object.assign(new Error("private SQL error"), {
      errno: 1064,
    });
    const callback = vi.fn();
    let returned: any;
    observation.runRequest(request(), response, () => {
      returned = pool.query("private SQL", callback);
    });
    expect(returned).toBe(command());
    advance(7);
    if (fails) {
      // Real Command.execute dispatches onResult(err), then emits end.
      command().execute(
        { isError: () => true, asError: () => failure },
        { _resetSequenceId() {} },
      );
      expect(callback).toHaveBeenCalledWith(failure, undefined, undefined);
    } else {
      command().onResult(null, ["private row"], ["private field"]);
      command().emit("end");
      expect(callback).toHaveBeenCalledWith(
        null,
        ["private row"],
        ["private field"],
      );
    }
    response.emit("finish");
    expect(observation.drain()).toMatchObject({
      active: [],
      requests: [
        {
          sql: {
            statements: 1,
            statementErrors: fails ? 1 : 0,
            statementTotalMs: 7,
            holdTotalMs: 7,
          },
        },
      ],
    });
    expect(connection.release).toHaveBeenCalledTimes(1);
  },
);

it("ends real mysql2 read-only-error destroy leases and reuses bounded records after disconnected work drains", async () => {
  const { observation, advance } = probe(2);
  const { pool, connection, command } = driverPool(observation);
  const drain = new WorkDrain();
  for (let n = 0; n < 5; n++) {
    const response = new EventEmitter(),
      tail = deferred();
    let work!: Promise<void>;
    let seen: unknown;
    observation.runRequest(request(), response, () => {
      work = drain.run(async () => {
        await new Promise<void>((resolve) =>
          pool.query("private", (e) => {
            seen = e;
            resolve();
          }),
        );
        await tail.promise;
      });
    });
    advance(2);
    response.emit("close");
    advance(3);
    const error = Object.assign(new Error("private readonly"), { errno: 1290 });
    command().execute(
      { isError: () => true, asError: () => error },
      { _resetSequenceId() {} },
    );
    expect(seen).toBe(error);
    expect(observation.drain()).toMatchObject({
      requests: [],
      active: [
        {
          leases: 0,
          work: 1,
          sql: {
            statementErrors: 1,
            holdTotalMs: 5,
            leaseSamples: [{ endReason: "destroy", releasedMs: n * 6 + 5 }],
          },
        },
      ],
    });
    advance(1);
    tail.resolve();
    await work;
    await drain.wait(50);
    expect(observation.drain()).toMatchObject({
      truncated: false,
      dropped: 0,
      active: [],
      requests: [{ endMs: (n + 1) * 6 }],
    });
  }
  const response = new EventEmitter();
  observation.runRequest(request("/healthz"), response, () => {});
  response.emit("finish");
  expect(observation.drain()).toMatchObject({
    dropped: 0,
    requests: [{ label: "health" }],
  });
  expect(connection.destroy).toHaveBeenCalledTimes(5);
  expect(connection.release).not.toHaveBeenCalled();
});

it.each(["end", "error", "destroy", "close"])(
  "settles terminal %s once without suppressing native errors",
  (terminal) => {
    const { observation, advance } = probe();
    const c: any = new EventEmitter();
    const originalDestroy = vi.fn(() => "destroy-result");
    c.destroy = originalDestroy;
    c.close = vi.fn(() => "close-result");
    c.release = vi.fn();
    const raw = { getConnection: (cb: any) => cb(null, c) };
    cleanups.push(observation.instrumentPool(raw));
    const response = new EventEmitter();
    observation.runRequest(request(), response, () =>
      raw.getConnection(() => {}),
    );
    response.emit("close");
    advance(9);
    const failure = new Error("private fatal");
    if (terminal === "error")
      expect(() => c.emit("error", failure)).toThrow(failure);
    else if (terminal === "end") c.emit("end");
    else expect(c[terminal]()).toBe(`${terminal}-result`);
    c.emit("end");
    const result = observation.drain();
    expect(result).toMatchObject({
      active: [],
      requests: [
        {
          leases: 0,
          sql: {
            holdTotalMs: 9,
            leaseSamples: [{ releasedMs: 9, endReason: terminal }],
          },
        },
      ],
    });
    expect(c.destroy).toBe(originalDestroy);
  },
);

it("waits for graceful end completion and pending work after disconnect", async () => {
  const { observation, advance } = probe();
  const drain = new WorkDrain(),
    tail = deferred(),
    response = new EventEmitter();
  let complete!: () => void, sqlDone!: () => void, work!: Promise<void>;
  const c: any = new EventEmitter();
  c.query = (_q: any, cb: any) => {
    sqlDone = cb;
    return "query";
  };
  c.release = vi.fn();
  c.end = vi.fn((cb: any) => {
    complete = cb;
    return "ending";
  });
  const raw = { getConnection: (cb: any) => cb(null, c) };
  cleanups.push(observation.instrumentPool(raw));
  observation.runRequest(request(), response, () => {
    work = drain.run(async () => {
      await new Promise<void>((resolve) =>
        raw.getConnection(() => c.query("private", resolve)),
      );
      await tail.promise;
    });
    expect(c.end(() => {})).toBe("ending");
  });
  response.emit("close");
  advance(4);
  expect(observation.drain()).toMatchObject({
    requests: [],
    active: [{ leases: 1, work: 1 }],
  });
  sqlDone();
  advance(3);
  complete();
  expect(observation.drain()).toMatchObject({
    requests: [],
    active: [{ leases: 0, work: 1, sql: { holdTotalMs: 7 } }],
  });
  advance(2);
  tail.resolve();
  await work;
  expect(observation.drain()).toMatchObject({
    active: [],
    requests: [{ endMs: 9, sql: { leaseSamples: [{ endReason: "end" }] } }],
  });
});

it("labels pending-cap rejection as a get without loader start, never warm reuse", async () => {
  const { observation } = probe();
  const cache = createTtlCache<string, void>({ ttlMs: 5_000, maxInFlight: 1 });
  const hold = deferred(),
    rejectedLoader = vi.fn(async () => {});
  const pending = storefrontCacheGet(
    cache,
    "index",
    "private-a",
    () => hold.promise,
  );
  await expect(
    storefrontCacheGet(cache, "index", "private-b", rejectedLoader),
  ).rejects.toMatchObject({ reason: "queue-full" });
  const counts = observation.drain().caches.index;
  expect(counts).toMatchObject({
    gets: 2,
    loads: 1,
    loaded: 0,
    rejected: 1,
    getsWithoutLoaderStart: 1,
  });
  expect(counts).not.toHaveProperty("reuseOrCoalesced");
  expect(rejectedLoader).not.toHaveBeenCalled();
  hold.resolve();
  await pending;
});

it("preserves command onResult receiver, arguments, return and thrown callback errors", () => {
  const { observation } = probe();
  const { pool, command } = driverPool(observation);
  const response = new EventEmitter(),
    failure = new Error("private callback failure");
  const callback = vi.fn(() => {
    throw failure;
  });
  observation.runRequest(request(), response, () =>
    pool.query("private", callback),
  );
  expect(() => command().onResult(null, [], [])).toThrow(failure);
  command().emit("end");
  response.emit("finish");
  expect(callback).toHaveBeenCalledTimes(1);
  expect(observation.drain().requests[0].sql).toMatchObject({
    statements: 1,
    statementErrors: 0,
  });

  const raw: any = { getConnection: (cb: any) => cb(null, c) };
  const c: any = { query: (cmd: any) => cmd, release() {} };
  cleanups.push(observation.instrumentPool(raw));
  const cmd: any = new EventEmitter(),
    receiver = {},
    values = [null, [1], [2]];
  const result = function (this: unknown, ...args: unknown[]) {
    expect(this).toBe(receiver);
    expect(args).toEqual(values);
    return "result";
  };
  cmd.onResult = result;
  const second = new EventEmitter();
  observation.runRequest(request(), second, () =>
    raw.getConnection(() => {
      expect(c.query(cmd)).toBe(cmd);
      expect(cmd.onResult.apply(receiver, values)).toBe("result");
      expect(cmd.onResult).toBe(result);
      c.release();
      second.emit("finish");
    }),
  );
});

it("retains streaming command unhandled-error behavior and counts its error once", () => {
  const { observation } = probe();
  const cmd = new EventEmitter(),
    response = new EventEmitter();
  const c = { query: () => cmd, release() {} };
  const raw = { getConnection: (cb: any) => cb(null, c) };
  cleanups.push(observation.instrumentPool(raw));
  observation.runRequest(request(), response, () =>
    raw.getConnection(() => c.query()),
  );
  const failure = new Error("private stream failure");
  expect(() => cmd.emit("error", failure)).toThrow(failure);
  cmd.emit("end");
  c.release();
  response.emit("finish");
  expect(observation.drain().requests[0].sql).toMatchObject({
    statements: 1,
    statementErrors: 1,
  });
});

it("does not complete disconnected pending SQL merely because graceful end callback fires", () => {
  const { observation, advance } = probe();
  let done!: () => void, end!: () => void;
  const c = {
    query: (_sql: string, cb: () => void) => {
      done = cb;
    },
    end: (cb: () => void) => {
      end = cb;
    },
    release() {},
  };
  const raw = { getConnection: (cb: any) => cb(null, c) };
  const response = new EventEmitter();
  cleanups.push(observation.instrumentPool(raw));
  observation.runRequest(request(), response, () =>
    raw.getConnection(() => {
      c.query("private", () => {});
      c.end(() => {});
    }),
  );
  response.emit("close");
  advance(3);
  end();
  expect(observation.drain()).toMatchObject({
    requests: [],
    active: [{ leases: 0, pendingStatements: 1 }],
  });
  advance(4);
  done();
  expect(observation.drain()).toMatchObject({
    active: [],
    requests: [{ endMs: 7, sql: { statementTotalMs: 7 } }],
  });
});

it("settles rejected non-SQL work scopes only when abort cleanup finishes after disconnect", async () => {
  const { observation, advance } = probe();
  const drain = new WorkDrain(),
    hold = deferred(),
    response = new EventEmitter();
  const failure = new Error("private abort");
  let work!: Promise<void>;
  observation.runRequest(request(), response, () => {
    work = drain.run(async () => {
      await hold.promise;
      throw failure;
    });
  });
  const rejected = expect(work).rejects.toBe(failure);
  response.emit("close");
  advance(11);
  expect(observation.drain()).toMatchObject({
    requests: [],
    active: [{ work: 1 }],
  });
  hold.resolve();
  await rejected;
  await drain.wait(50);
  expect(observation.drain()).toMatchObject({
    active: [],
    requests: [{ endMs: 11, work: 0 }],
  });
});
