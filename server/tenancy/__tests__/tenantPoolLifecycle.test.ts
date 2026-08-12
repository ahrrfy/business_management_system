import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => {
  const pools: Array<{ end: ReturnType<typeof vi.fn> }> = [];
  return {
    pools,
    createPool: vi.fn(() => {
      const pool = {
        end: vi.fn(async () => undefined),
        execute: vi.fn(),
        getConnection: vi.fn(),
        query: vi.fn(),
      };
      pools.push(pool);
      return pool;
    }),
    resolveCompanyById: vi.fn(async (companyId: number) => ({
      id: companyId,
      code: `company-${companyId}`,
      name: `Company ${companyId}`,
      dbName: `company_${companyId}`,
      dbHost: "127.0.0.1",
      dbPort: 3306,
      connectionUrl: `mysql://tenant.invalid/company_${companyId}`,
    })),
  };
});

vi.mock("mysql2/promise", () => ({ default: { createPool: stubs.createPool } }));
vi.mock("../registry", () => ({ resolveCompanyById: stubs.resolveCompanyById }));
vi.mock("../../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

type DbModule = typeof import("../../db");
let acquireTenantDb: DbModule["acquireTenantDb"];
let closeDb: DbModule["closeDb"];

beforeAll(async () => {
  // The full test suite loads db.ts during global setup. Resetting the module
  // graph here makes these hoisted registry/pool mocks authoritative too.
  vi.resetModules();
  ({ acquireTenantDb, closeDb } = await import("../../db"));
});

const ENV_KEYS = [
  "CONTROL_DATABASE_URL",
  "DB_POOL_LIMIT",
  "DB_MAX_TENANT_POOLS_PER_WORKER",
  "WEB_INSTANCES",
  "MYSQL_MAX_CONNECTIONS",
  "DB_CONNECTION_RESERVE",
  "CONTROL_DB_POOL_LIMIT",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnvironment(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(async () => {
  await closeDb();
  stubs.pools.length = 0;
  stubs.createPool.mockClear();
  stubs.resolveCompanyById.mockClear();
  process.env.CONTROL_DATABASE_URL = "mysql://control.invalid/erp_control";
  process.env.DB_POOL_LIMIT = "1";
  process.env.DB_MAX_TENANT_POOLS_PER_WORKER = "1";
  process.env.WEB_INSTANCES = "1";
  process.env.MYSQL_MAX_CONNECTIONS = "30";
  process.env.DB_CONNECTION_RESERVE = "5";
  process.env.CONTROL_DB_POOL_LIMIT = "1";
});

afterEach(async () => {
  await closeDb();
  restoreEnvironment();
});

describe("tenant pool lifecycle", () => {
  it("deduplicates a cold pool and leases it before another acquisition can evict it", async () => {
    const [first, second] = await Promise.all([acquireTenantDb(1), acquireTenantDb(1)]);

    expect(stubs.createPool).toHaveBeenCalledTimes(1);
    expect(first.db).toBe(second.db);

    first.release();
    second.release();
  });

  it("fails at capacity without cold-start pool ping-pong, then admits the next tenant after release", async () => {
    const first = await acquireTenantDb(1);

    await expect(acquireTenantDb(2)).rejects.toThrow(/capacity is busy/);
    expect(stubs.createPool).toHaveBeenCalledTimes(1);

    first.release();
    const second = await acquireTenantDb(2);
    expect(stubs.createPool).toHaveBeenCalledTimes(2);
    expect(stubs.pools[0]?.end).toHaveBeenCalledTimes(1);
    second.release();
  });

  it("waits for active leases before ending pools and can reopen cleanly afterwards", async () => {
    const lease = await acquireTenantDb(1);
    const firstPool = stubs.pools[0]!;
    const closing = closeDb();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstPool.end).not.toHaveBeenCalled();
    await expect(acquireTenantDb(2)).rejects.toThrow(/shutting down/);

    lease.release();
    await closing;
    expect(firstPool.end).toHaveBeenCalledTimes(1);

    const reopened = await acquireTenantDb(1);
    expect(stubs.createPool).toHaveBeenCalledTimes(2);
    reopened.release();
  });

  it("does not publish a pool when shutdown begins during registry resolution", async () => {
    type Company = Awaited<ReturnType<typeof stubs.resolveCompanyById>>;
    let resolveCompany!: (company: Company) => void;
    stubs.resolveCompanyById.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCompany = resolve;
        }),
    );

    const acquiring = acquireTenantDb(9);
    await vi.waitFor(() => expect(stubs.resolveCompanyById).toHaveBeenCalledWith(9));
    const closing = closeDb();
    resolveCompany({
      id: 9,
      code: "company-9",
      name: "Company 9",
      dbName: "company_9",
      dbHost: "127.0.0.1",
      dbPort: 3306,
      connectionUrl: "mysql://tenant.invalid/company_9",
    });

    await expect(acquiring).rejects.toThrow(/shutting down/);
    await closing;
    expect(stubs.createPool).not.toHaveBeenCalled();
  });
});
