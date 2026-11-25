import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbPoolPolicy, validateDbConnectionBudget } from "../db";

const ENV_KEYS = [
  "WEB_RUNTIME_MODE",
  "WEB_RUNTIME_ROLE",
  "WEB_INSTANCES",
  "PUBLIC_WEB_INSTANCES",
  "ADMIN_WEB_INSTANCES",
  "DB_POOL_LIMIT",
  "PUBLIC_DB_POOL_LIMIT",
  "ADMIN_DB_POOL_LIMIT",
  "DB_WEB_CONNECTION_BUDGET",
  "DB_AUX_CONNECTION_BUDGET",
  "DB_RUNTIME_EXTRA_WORKERS",
  "MYSQL_MAX_CONNECTIONS",
  "DB_CONNECTION_RESERVE",
] as const;

describe("single-company DB pool policy", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("allocates one pool per web worker with full single-company headroom", () => {
    process.env.WEB_INSTANCES = "2";
    process.env.DB_POOL_LIMIT = "10";
    process.env.MYSQL_MAX_CONNECTIONS = "151";
    process.env.DB_CONNECTION_RESERVE = "20";

    const policy = dbPoolPolicy();
    expect(policy).toEqual({
      connectionLimit: 10,
      webWorkers: 2,
      mysqlMaxConnections: 151,
      connectionReserve: 20,
    });
    expect(validateDbConnectionBudget(policy)).toEqual({
      projected: 20,
      available: 131,
    });
  });

  it("enforces split runtime web and auxiliary connection budgets", () => {
    process.env.WEB_RUNTIME_MODE = "split";
    process.env.WEB_RUNTIME_ROLE = "public";
    process.env.PUBLIC_WEB_INSTANCES = "1";
    process.env.ADMIN_WEB_INSTANCES = "2";
    process.env.WEB_INSTANCES = "3";
    process.env.PUBLIC_DB_POOL_LIMIT = "12";
    process.env.ADMIN_DB_POOL_LIMIT = "15";
    process.env.DB_WEB_CONNECTION_BUDGET = "50";
    process.env.DB_AUX_CONNECTION_BUDGET = "20";
    process.env.MYSQL_MAX_CONNECTIONS = "151";
    process.env.DB_CONNECTION_RESERVE = "20";

    const policy = dbPoolPolicy();
    expect(policy.connectionLimit).toBe(12);
    expect(policy.splitBudget).toEqual({
      webConnections: 42,
      webLimit: 50,
      auxiliary: 20,
    });
    expect(validateDbConnectionBudget(policy)).toEqual({
      projected: 62,
      available: 131,
    });
  });

  it("rejects budgets exceeding MySQL capacity", () => {
    process.env.WEB_INSTANCES = "8";
    process.env.DB_POOL_LIMIT = "25";
    process.env.MYSQL_MAX_CONNECTIONS = "151";
    process.env.DB_CONNECTION_RESERVE = "20";
    expect(() => validateDbConnectionBudget()).toThrow(/exceeds MySQL capacity/);
  });
});
