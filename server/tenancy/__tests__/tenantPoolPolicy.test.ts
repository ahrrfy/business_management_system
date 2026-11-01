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
  "WEB_RUNTIME_MODE", "WEB_RUNTIME_ROLE", "PUBLIC_WEB_INSTANCES", "ADMIN_WEB_INSTANCES",
  "PUBLIC_DB_POOL_LIMIT", "ADMIN_DB_POOL_LIMIT", "DB_WEB_CONNECTION_BUDGET", "DB_AUX_CONNECTION_BUDGET", "DB_RUNTIME_EXTRA_WORKERS",
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
  it("budgets public2 plus two admin5 pools globally, including auxiliary and transient clients", () => {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, { WEB_RUNTIME_MODE: "split", WEB_RUNTIME_ROLE: "public", WEB_INSTANCES: "3", PUBLIC_DB_POOL_LIMIT: "2", ADMIN_DB_POOL_LIMIT: "5", DB_WEB_CONNECTION_BUDGET: "12", DB_AUX_CONNECTION_BUDGET: "0" });
    expect(tenantPoolPolicy().connectionLimit).toBe(2);
    expect(validateTenantConnectionBudget()).toEqual({ projected: 12, available: 131 });
    process.env.WEB_RUNTIME_ROLE = "admin";
    expect(tenantPoolPolicy().connectionLimit).toBe(5);
    expect(validateTenantConnectionBudget()).toEqual({ projected: 12, available: 131 });
    process.env.DB_RUNTIME_EXTRA_WORKERS = "1";
    expect(() => validateTenantConnectionBudget()).toThrow(/web connection budget/i);
    process.env.DB_WEB_CONNECTION_BUDGET = "17";
    process.env.DB_AUX_CONNECTION_BUDGET = "10";
    expect(validateTenantConnectionBudget()).toEqual({ projected: 27, available: 131 });
  });
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

it("accounts no-role auxiliary pool and control/tenant ceilings without weakening HTTP validation", async () => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { WEB_RUNTIME_MODE: "split", WEB_INSTANCES: "3", PUBLIC_DB_POOL_LIMIT: "2", ADMIN_DB_POOL_LIMIT: "5", DB_WEB_CONNECTION_BUDGET: "12", DB_AUX_CONNECTION_BUDGET: "10" });
  expect(tenantPoolPolicy().connectionLimit).toBe(10);
  expect(validateTenantConnectionBudget()).toEqual({ projected: 22, available: 131 });
  const { runtimeWorkerCounts } = await import("../../lib/clusterRole");
  expect(() => runtimeWorkerCounts()).toThrow(/explicit role/);
  process.env.DB_AUX_CONNECTION_BUDGET = "9";
  expect(() => tenantPoolPolicy()).toThrow(/auxiliary/i);
  process.env.CONTROL_DATABASE_URL = "mysql://control.invalid/erp_control";
  process.env.DB_AUX_CONNECTION_BUDGET = "55";
  process.env.DB_WEB_CONNECTION_BUDGET = "75";
  expect(tenantPoolPolicy()).toMatchObject({ connectionLimit: 10, maxPoolsPerWorker: 5, controlPoolPerWorker: 5 });
  expect(validateTenantConnectionBudget()).toEqual({ projected: 130, available: 131 });
});

it("enforces auxiliary budget before opening even the control-only client", async () => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { WEB_RUNTIME_MODE: "split", WEB_INSTANCES: "3", DB_WEB_CONNECTION_BUDGET: "100", DB_AUX_CONNECTION_BUDGET: "0", CONTROL_DATABASE_URL: "mysql://control.invalid/erp_control" });
  const { getControlDb } = await import("../controlDb");
  expect(() => getControlDb()).toThrow(/auxiliary/i);
  process.env.CONTROL_DB_POOL_LIMIT = "bad";
  expect(() => getControlDb()).toThrow(/CONTROL_DB_POOL_LIMIT/);
});
