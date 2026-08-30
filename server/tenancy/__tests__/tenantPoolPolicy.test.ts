import { afterEach, describe, expect, it } from "vitest";
import { tenantPoolPolicy, validateTenantConnectionBudget } from "../../db";

const KEYS = [
  "DB_POOL_LIMIT",
  "DB_MAX_TENANT_POOLS_PER_WORKER",
  "DB_TENANT_POOL_IDLE_MS",
  "WEB_INSTANCES",
  "MYSQL_MAX_CONNECTIONS",
  "DB_CONNECTION_RESERVE",
  "CONTROL_DB_POOL_LIMIT",
  "CONTROL_DATABASE_URL",
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("tenant DB connection budget", () => {
  it("keeps the default two-worker deployment below MySQL's default capacity", () => {
    for (const key of KEYS) delete process.env[key];
    const policy = tenantPoolPolicy();
    expect(policy).toMatchObject({ connectionLimit: 10, maxPoolsPerWorker: 5, webWorkers: 2 });
    expect(validateTenantConnectionBudget(policy)).toEqual({ projected: 100, available: 131 });
  });

  it("fails closed when an operator configures more possible pools than MySQL can serve", () => {
    expect(() =>
      validateTenantConnectionBudget({
        connectionLimit: 20,
        maxPoolsPerWorker: 4,
        idleMs: 900_000,
        webWorkers: 2,
        mysqlMaxConnections: 151,
        connectionReserve: 20,
        controlPoolPerWorker: 0,
      }),
    ).toThrow(/160 projected > 131 available/);
  });

  it("includes the control-plane pool for every web worker", () => {
    process.env.CONTROL_DATABASE_URL = "mysql://control.invalid/erp_control";
    const policy = tenantPoolPolicy();
    expect(policy.controlPoolPerWorker).toBe(5);
    expect(validateTenantConnectionBudget(policy)).toEqual({ projected: 110, available: 131 });
  });

  it("rejects malformed environment values instead of silently producing an unsafe pool", () => {
    process.env.DB_POOL_LIMIT = "twenty";
    expect(() => tenantPoolPolicy()).toThrow(/DB_POOL_LIMIT must be an integer/);
  });
});
