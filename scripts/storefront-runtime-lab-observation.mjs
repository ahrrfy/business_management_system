/** Opt-in isolated-lab probes. Only public HTTP/mysql2 methods are wrapped. */
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { Server } from "node:http";
import { performance } from "node:perf_hooks";

const labels = new Set([
  "catalog",
  "quote",
  "create",
  "replay",
  "staff",
  "health",
  "other",
]);
const cacheLabels = new Set([
  "index",
  "suggestions",
  "candidates",
  "search",
  "sold",
  "categories",
]);
const reasons = new Set([
  "quota",
  "queue-full",
  "timeout",
  "aborted",
  "batch",
  "shutdown",
  "invalid",
]);
export function validateRuntimeLabObservationFlags(env) {
  for (const name of ["RUNTIME_LAB_READ_CACHE", "RUNTIME_LAB_DIAGNOSTICS"])
    if (
      env[name] !== undefined &&
      env[name] !== "" &&
      env[name] !== "0" &&
      env[name] !== "1"
    )
      throw new Error(`Invalid ${name}`);
  return {
    readCacheEnabled: env.RUNTIME_LAB_READ_CACHE === "1",
    diagnosticsEnabled: env.RUNTIME_LAB_DIAGNOSTICS === "1",
  };
}
export function runtimeLabProcedureLabel(request) {
  // No URL/query/header value is retained. Parsing is bounded even for malformed input.
  const route = String(request.url ?? "")
    .slice(0, 4096)
    .split("?", 1)[0];
  if (route === "/healthz") return "health";
  if (
    route === "/api/trpc/storefront.quoteOrder" ||
    route === "/api/trpc/storefront.quoteOrderPrivate"
  )
    return "quote";
  if (route === "/api/trpc/storefront.createOrder")
    return request.headers?.["x-runtime-lab-kind"] === "replay"
      ? "replay"
      : "create";
  if (
    [
      "storefront.catalog",
      "storefront.product",
      "storefront.searchSuggestions",
    ].some((p) => route === `/api/trpc/${p}`)
  )
    return "catalog";
  if (route === "/api/trpc/catalog.posList" || route === "/api/realtime/stream")
    return "staff";
  return "other";
}

export function createRuntimeLabObservation({
  now = () => performance.now(),
  maxRequests = 512,
} = {}) {
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 512
  )
    throw new Error("Invalid observation bound");
  const context = new AsyncLocalStorage();
  const active = new Map(),
    completed = [],
    caches = {};
  let sequence = 0,
    dropped = 0,
    failures = 0,
    truncated = false,
    poolSequence = 0;
  const safe = (work) => {
    try {
      return work();
    } catch {
      failures++;
      return undefined;
    }
  };
  const finish = (record) => {
    if (
      !record ||
      record.ended ||
      record.dispatching ||
      record.responseEndMs === null ||
      record.work ||
      record.leases ||
      record.pendingStatements ||
      record.acquiring ||
      record.admitting
    )
      return;
    record.ended = true;
    record.endMs = now();
    active.delete(record.sequence);
    completed.push(record);
  };
  const fresh = (label) => {
    if (active.size + completed.length >= maxRequests) {
      dropped++;
      truncated = true;
      return undefined;
    }
    const record = {
      sequence: ++sequence,
      label: labels.has(label) ? label : "other",
      startMs: now(),
      responseEndMs: null,
      endMs: null,
      ended: false,
      dispatching: true,
      work: 0,
      leases: 0,
      pendingStatements: 0,
      acquiring: 0,
      admitting: 0,
      workScopes: 0,
      sql: {
        acquisitions: 0,
        acquisitionErrors: 0,
        waitTotalMs: 0,
        waitMaxMs: 0,
        holdTotalMs: 0,
        holdMaxMs: 0,
        statements: 0,
        statementErrors: 0,
        statementTotalMs: 0,
        statementMaxMs: 0,
        leaseSamples: [],
        leaseSamplesTruncated: false,
      },
      admission: {
        starts: 0,
        grants: 0,
        rejects: 0,
        waitTotalMs: 0,
        waitMaxMs: 0,
        reason: null,
      },
    };
    active.set(record.sequence, record);
    return record;
  };
  const runRequest = (request, response, invoke) => {
    const record = safe(() => fresh(runtimeLabProcedureLabel(request)));
    if (!record) return context.run(undefined, invoke);
    const end = () =>
      safe(() => {
        if (record.responseEndMs === null) record.responseEndMs = now();
        response.off("finish", end);
        response.off("close", end);
        finish(record);
      });
    safe(() => {
      response.once("finish", end);
      response.once("close", end);
    });
    // Invoke outside safe(): application exceptions and EventEmitter's boolean return are unchanged.
    try {
      return context.run(record, invoke);
    } finally {
      safe(() => {
        record.dispatching = false;
        finish(record);
      });
    }
  };
  const installHttp = (prototype = Server.prototype) => {
    const original = prototype.emit;
    function observedEmit(event, ...args) {
      return event === "request"
        ? runRequest(args[0], args[1], () =>
            original.call(this, event, ...args),
          )
        : original.call(this, event, ...args);
    }
    prototype.emit = observedEmit;
    return () => {
      if (prototype.emit === observedEmit) prototype.emit = original;
    };
  };
  const subscribe = () => {
    const admissions = channel("erp.storefront.admission"),
      cache = channel("erp.storefront.read-cache"),
      work = channel("erp.runtime.work");
    const onAdmission = (message) =>
      safe(() => {
        const record = context.getStore();
        if (
          !record ||
          record.ended ||
          !["public-read", "public-order", "staff"].includes(message.lane)
        )
          return;
        const a = record.admission;
        if (message.phase === "start") {
          a.starts++;
          record.admitting++;
        } else if (message.phase === "grant" || message.phase === "reject") {
          record.admitting = Math.max(0, record.admitting - 1);
          if (message.phase === "grant") a.grants++;
          else a.rejects++;
          const duration = Number.isFinite(message.durationMs)
            ? Math.max(0, message.durationMs)
            : 0;
          a.waitTotalMs += duration;
          a.waitMaxMs = Math.max(a.waitMaxMs, duration);
          a.reason = reasons.has(message.reason) ? message.reason : null;
          finish(record);
        }
      });
    const onCache = (message) =>
      safe(() => {
        if (!cacheLabels.has(message.label)) return;
        const c = (caches[message.label] ??= {
          gets: 0,
          loads: 0,
          loaded: 0,
          failed: 0,
          loadTotalMs: 0,
          entries: 0,
          inFlight: 0,
          rejected: 0,
        });
        if (message.phase === "get") c.gets++;
        if (message.phase === "load-start") c.loads++;
        if (message.phase === "load-end") c.loaded++;
        if (message.phase === "load-error") c.failed++;
        if (
          ["load-end", "load-error"].includes(message.phase) &&
          Number.isFinite(message.durationMs)
        )
          c.loadTotalMs += Math.max(0, message.durationMs);
        for (const key of ["entries", "inFlight", "rejected"])
          if (Number.isSafeInteger(message[key]) && message[key] >= 0)
            c[key] = message[key];
      });
    const onWork = (message) =>
      safe(() => {
        const record = context.getStore();
        if (!record || record.ended) return;
        if (message.phase === "start") {
          record.work++;
          record.workScopes++;
        } else if (message.phase === "end") {
          record.work = Math.max(0, record.work - 1);
          finish(record);
        }
      });
    admissions.subscribe(onAdmission);
    cache.subscribe(onCache);
    work.subscribe(onWork);
    return () => {
      admissions.unsubscribe(onAdmission);
      cache.unsubscribe(onCache);
      work.unsubscribe(onWork);
    };
  };
  const instrumentPool = (raw) => {
    const get = raw.getConnection;
    const poolId = ++poolSequence,
      connectionIds = new WeakMap();
    let connectionSequence = 0;
    function observedGet(callback) {
      const owner = context.getStore(),
        start = now();
      safe(() => {
        if (owner && !owner.ended) owner.acquiring++;
      });
      let arrived = false;
      const acquired = (error, connection) => {
        arrived = true;
        safe(() => {
          if (owner && !owner.ended) {
            owner.acquiring--;
            owner.sql.acquisitions++;
            const wait = now() - start;
            owner.sql.waitTotalMs += wait;
            owner.sql.waitMaxMs = Math.max(owner.sql.waitMaxMs, wait);
            if (error) owner.sql.acquisitionErrors++;
          }
          if (!error && connection) {
            if (!connectionIds.has(connection))
              connectionIds.set(connection, ++connectionSequence);
            instrumentLease(connection, owner, {
              poolId,
              connectionId: connectionIds.get(connection),
              queuedMs: start,
              acquiredMs: now(),
            });
          }
          finish(owner);
        });
        // Pool FIFO callbacks can execute inside a releasing request's ALS.
        return context.run(owner, () => callback(error, connection));
      };
      try {
        return get.call(this, acquired);
      } catch (error) {
        if (!arrived)
          safe(() => {
            if (owner && !owner.ended) {
              owner.acquiring--;
              owner.sql.acquisitionErrors++;
              finish(owner);
            }
          });
        throw error;
      }
    }
    raw.getConnection = observedGet;
    return () => {
      if (raw.getConnection === observedGet) raw.getConnection = get;
    };
  };
  const instrumentLease = (connection, owner, lease) => {
    if (!owner || owner.ended) return;
    owner.leases++;
    Object.assign(lease, {
      releasedMs: null,
      endReason: null,
      statements: 0,
      statementErrors: 0,
      statementTotalMs: 0,
    });
    if (owner.sql.leaseSamples.length < 32) owner.sql.leaseSamples.push(lease);
    else owner.sql.leaseSamplesTruncated = true;
    const start = now(),
      originals = {},
      wrappers = {};
    const pending = new Set();
    let leaseEnded = false;
    const finalize = (reason, terminal = false) => {
      if (leaseEnded) return;
      leaseEnded = true;
      // Restore before invoking driver lifecycle methods: release/removal may hand off FIFO waiters.
      for (const method of Object.keys(originals))
        if (connection[method] === wrappers[method])
          connection[method] = originals[method];
      connection.off?.("end", onEnd);
      connection.off?.(errorMonitor, onError);
      safe(() => {
        lease.releasedMs = now();
        lease.endReason = reason;
        const hold = now() - start;
        owner.leases--;
        owner.sql.holdTotalMs += hold;
        owner.sql.holdMaxMs = Math.max(owner.sql.holdMaxMs, hold);
        // An irreversible transport termination ends any outstanding physical statement.
        // WorkDrain still tracks application promises, including disconnected work.
        if (terminal) for (const done of [...pending]) done(true);
        finish(owner);
      });
    };
    const onEnd = () => finalize("end", true);
    const onError = () => finalize("error", true);
    connection.once?.("end", onEnd);
    connection.once?.(errorMonitor, onError);
    for (const method of ["query", "execute"]) {
      if (typeof connection[method] !== "function") continue;
      originals[method] = connection[method];
      wrappers[method] = function (...args) {
        const began = now();
        let settled = false;
        let cleanup = () => {};
        safe(() => {
          owner.sql.statements++;
          owner.pendingStatements++;
          lease.statements++;
        });
        const done = (error) =>
          safe(() => {
            if (settled) return;
            settled = true;
            cleanup();
            pending.delete(done);
            owner.pendingStatements--;
            const elapsed = now() - began;
            owner.sql.statementTotalMs += elapsed;
            owner.sql.statementMaxMs = Math.max(
              owner.sql.statementMaxMs,
              elapsed,
            );
            lease.statementTotalMs += elapsed;
            if (error) {
              owner.sql.statementErrors++;
              lease.statementErrors++;
            }
            finish(owner);
          });
        pending.add(done);
        const watch = (command) => {
          if (!command?.once || settled) return;
          const end = () => done();
          const error = (err) => done(err);
          const result = command.onResult;
          const observedResult =
            typeof result === "function"
              ? function (...values) {
                  done(values[0]);
                  return result.apply(this, values);
                }
              : undefined;
          cleanup = () => {
            command.off?.("end", end);
            command.off?.(errorMonitor, error);
            if (observedResult && command.onResult === observedResult)
              command.onResult = result;
          };
          if (observedResult) command.onResult = observedResult;
          command.once("end", end);
          command.once(errorMonitor, error);
        };
        const callbackIndex = args.length - 1;
        if (typeof args[callbackIndex] === "function") {
          const callback = args[callbackIndex];
          args[callbackIndex] = function (...values) {
            done(values[0]);
            return callback.apply(this, values);
          };
        }
        // Pool.query passes a Query command, whose onResult receives errors before end.
        const command = args[0]?.once ? args[0] : undefined;
        if (command) watch(command);
        try {
          const result = originals[method].apply(this, args);
          // Streaming users retain their existing error listener/throw semantics.
          if (!command && typeof args[callbackIndex] !== "function")
            watch(result);
          return result;
        } catch (error) {
          done(error);
          throw error;
        }
      };
      connection[method] = wrappers[method];
    }
    for (const method of ["release", "destroy", "close"]) {
      if (typeof connection[method] !== "function") continue;
      originals[method] = connection[method];
      wrappers[method] = function (...args) {
        finalize(method, method !== "release");
        return originals[method].apply(this, args);
      };
      connection[method] = wrappers[method];
    }
    if (typeof connection.end === "function") {
      originals.end = connection.end;
      wrappers.end = function (...args) {
        const callbackIndex = args.length - 1;
        if (typeof args[callbackIndex] === "function") {
          const callback = args[callbackIndex];
          args[callbackIndex] = function (...values) {
            finalize("end");
            return callback.apply(this, values);
          };
        }
        const result = originals.end.apply(this, args);
        // Graceful end queues QUIT after current work. Calling end alone is not completion.
        result?.once?.("end", () => finalize("end"));
        return result;
      };
      connection.end = wrappers.end;
    }
  };
  return {
    runRequest,
    installHttp,
    subscribe,
    instrumentPool,
    drain: () =>
      safe(() => ({
        truncated,
        dropped,
        failures,
        maxRequests,
        active: [...active.values()].map((r) => structuredClone(r)),
        requests: completed.splice(0),
        caches: Object.fromEntries(
          Object.entries(caches).map(([label, value]) => [
            label,
            // Includes warm hits, coalesced gets AND misses rejected before loader start.
            { ...value, getsWithoutLoaderStart: value.gets - value.loads },
          ]),
        ),
      })),
  };
}
