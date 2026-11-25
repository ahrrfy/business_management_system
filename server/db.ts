import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema";
import { logger } from "./logger";
import { runtimeWorkerCounts, webRuntimeRole } from "./lib/clusterRole";

function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export interface DbPoolPolicy {
  connectionLimit: number;
  webWorkers: number;
  mysqlMaxConnections: number;
  connectionReserve: number;
  splitBudget?: { webConnections: number; webLimit: number; auxiliary: number };
}

/**
 * A bounded, explicit connection budget under MySQL's default 151 connections,
 * retaining a healthy reserve for single-company multi-branch operation.
 */
export function dbPoolPolicy(): DbPoolPolicy {
  const topology = runtimeWorkerCounts(process.env, "database");
  const auxiliary = topology.split && !process.env.WEB_RUNTIME_ROLE;
  const defaultPool = boundedIntEnv("DB_POOL_LIMIT", 10, 1, 50);
  let connectionLimit = defaultPool;
  let splitBudget: DbPoolPolicy["splitBudget"];
  if (topology.split) {
    for (const key of ["DB_WEB_CONNECTION_BUDGET", "DB_AUX_CONNECTION_BUDGET"]) {
      if (!process.env[key]?.trim()) throw new Error(`Split runtime requires explicit ${key}`);
    }
    const publicLimit = boundedIntEnv("PUBLIC_DB_POOL_LIMIT", defaultPool, 1, 50);
    const adminLimit = boundedIntEnv("ADMIN_DB_POOL_LIMIT", defaultPool, 1, 50);
    const extraWorkers = boundedIntEnv("DB_RUNTIME_EXTRA_WORKERS", 0, 0, 32);
    connectionLimit = auxiliary
      ? defaultPool
      : webRuntimeRole() === "public"
        ? publicLimit
        : adminLimit;
    splitBudget = {
      webConnections:
        topology.publicWorkers * publicLimit +
        topology.adminWorkers * adminLimit +
        extraWorkers * Math.max(publicLimit, adminLimit),
      webLimit: boundedIntEnv("DB_WEB_CONNECTION_BUDGET", 1, 1, 100_000),
      auxiliary: boundedIntEnv("DB_AUX_CONNECTION_BUDGET", 0, 0, 100_000),
    };
  }
  if (auxiliary && splitBudget && connectionLimit > splitBudget.auxiliary) {
    throw new Error("Auxiliary process pool ceiling exceeds declared auxiliary connection budget");
  }
  return {
    connectionLimit,
    webWorkers: topology.total,
    mysqlMaxConnections: boundedIntEnv("MYSQL_MAX_CONNECTIONS", 151, 20, 100_000),
    connectionReserve: boundedIntEnv("DB_CONNECTION_RESERVE", 20, 5, 10_000),
    ...(splitBudget ? { splitBudget } : {}),
  };
}

export function validateDbConnectionBudget(policy = dbPoolPolicy()): {
  projected: number;
  available: number;
} {
  const available = policy.mysqlMaxConnections - policy.connectionReserve;
  if (policy.splitBudget && policy.splitBudget.webConnections > policy.splitBudget.webLimit) {
    throw new Error(
      `Split web connection budget exceeded: ${policy.splitBudget.webConnections} > ${policy.splitBudget.webLimit}`,
    );
  }
  const projected = policy.splitBudget
    ? policy.splitBudget.webConnections + policy.splitBudget.auxiliary
    : policy.connectionLimit * policy.webWorkers;
  if (available < 1 || projected > available) {
    throw new Error(
      `DB connection budget exceeds MySQL capacity: ${projected} projected > ${available} available. ` +
        "Reduce DB_POOL_LIMIT or WEB_INSTANCES; " +
        "or set verified MYSQL_MAX_CONNECTIONS/DB_CONNECTION_RESERVE values.",
    );
  }
  return { projected, available };
}

function createDb(url: string) {
  if (process.env.WEB_RUNTIME_MODE === "split") validateDbConnectionBudget();
  const { connectionLimit } = dbPoolPolicy();
  const pool = mysql.createPool({
    uri: url,
    timezone: "Z",
    connectionLimit,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 100,
  });
  return { pool, db: drizzle(pool, { schema, mode: "default" }) };
}

export type DB = ReturnType<typeof createDb>["db"];
/** Transaction handle as passed to `db.transaction(async (tx) => { ... })`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

let _single: ReturnType<typeof createDb> | null = null;
let _closeDbPromise: Promise<void> | null = null;

/** إغلاق رشيق لتجمع اتصالات قاعدة البيانات الوحيدة — يُستدعى عند SIGTERM/SIGINT. */
export function closeDb(): Promise<void> {
  if (_closeDbPromise) return _closeDbPromise;
  const closing = (async () => {
    try {
      if (_single) {
        const single = _single;
        await single.pool.end();
        if (_single === single) _single = null;
      }
    } finally {
      _closeDbPromise = null;
    }
  })();
  _closeDbPromise = closing;
  return closing;
}

let _singleBudgetWarned = false;
function warnSingleDbBudgetOnce(): void {
  if (_singleBudgetWarned) return;
  _singleBudgetWarned = true;
  try {
    const policy = dbPoolPolicy();
    const projected = policy.connectionLimit * policy.webWorkers;
    const available = policy.mysqlMaxConnections - policy.connectionReserve;
    if (projected > available) {
      logger.warn(
        {
          projected,
          available,
          connectionLimit: policy.connectionLimit,
          webWorkers: policy.webWorkers,
        },
        "ميزانية اتصالات القاعدة تتجاوز السعة: خفّض DB_POOL_LIMIT أو WEB_INSTANCES، أو ارفع MYSQL_MAX_CONNECTIONS بعد التحقّق من إعداد الخادم",
      );
    }
  } catch {
    // فشل قراءة السياسة (env غير صالح) سيظهر في مساره الأصلي — لا نكسر الإقلاع من هنا.
  }
}

/** Lazily create/return the single-company DB instance from `DATABASE_URL`. */
export function getDb(): DB | null {
  if (!_single) {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    _single = createDb(url);
    warnSingleDbBudgetOnce();
  }
  return _single.db;
}

/** Raw pool for test helpers that need a dedicated connection (e.g. TRUNCATE with FK_CHECKS). */
export function getPool(): mysql.Pool {
  if (!_single) throw new Error("DB pool not initialized — call getDb() first");
  return _single.pool;
}
