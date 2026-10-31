import type mysql from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIsolatedActivationTestTarget } from "./activationTestTarget";
import {
  clearTestTable,
  closeCleanupConn,
  populatedTestTables,
  readSnapshotWithReconnect,
  bootstrapEmptyInventoryProjection,
  NonEmptyTestDatabaseError,
  retryLateTestCleanup,
  assertSafeCleanupTarget,
} from "./__setup__";

describe("activation fixture target admission without SQL connections", () => {
  const ci = { CI: "true", GITHUB_ACTIONS: "true", ALLOW_TEST_DB_PORT_3306: "1" };
  it.each(["3306", ""])("admits isolated GitHub CI erp_test on port %s", (port) => {
    const url = `mysql://root@127.0.0.1${port ? `:${port}` : ""}/erp_test`;
    expect(() => assertIsolatedActivationTestTarget(url, ci)).not.toThrow();
  });
  it("retains the isolated local non-default target", () => {
    expect(() => assertIsolatedActivationTestTarget("mysql://root@127.0.0.1:33318/erp_procedures_remediation_20261028_test", {})).not.toThrow();
  });
  const rejectedTargets: Array<[string, string, NodeJS.ProcessEnv]> = [
    ["local explicit default", "mysql://root@127.0.0.1:3306/erp_test", {}],
    ["local implicit default", "mysql://root@127.0.0.1/erp_test", {}],
    ["local opt-in alone", "mysql://root@127.0.0.1:3306/erp_test", { ALLOW_TEST_DB_PORT_3306: "1" }],
    ["CI missing", "mysql://root@127.0.0.1:3306/erp_test", { ...ci, CI: undefined }],
    ["GitHub identity missing", "mysql://root@127.0.0.1:3306/erp_test", { ...ci, GITHUB_ACTIONS: undefined }],
    ["opt-in missing", "mysql://root@127.0.0.1:3306/erp_test", { ...ci, ALLOW_TEST_DB_PORT_3306: undefined }],
    ["opt-in false", "mysql://root@127.0.0.1/erp_test", { ...ci, ALLOW_TEST_DB_PORT_3306: "0" }],
    ["CI false", "mysql://root@127.0.0.1:3306/erp_test", { ...ci, CI: "false" }],
    ["remote host", "mysql://root@remote.test:3306/erp_test", ci],
    ["remote non-default", "mysql://root@remote.test:33318/erp_test", ci],
    ["production database", "mysql://root@127.0.0.1:3306/erp", ci],
    ["other test database on default port", "mysql://root@127.0.0.1:3306/erp_snapshot_test", ci],
    ["non-test local database", "mysql://root@127.0.0.1:33318/erp", ci],
    ["wrong protocol", "http://127.0.0.1:33318/erp_test", ci],
    ["malformed URL", "not a URL", ci],
  ];
  it.each(rejectedTargets)("rejects %s", (_name, url, env) => {
    expect(() => assertIsolatedActivationTestTarget(url, env)).toThrow(/ISOLATED_ACTIVATION_TEST_DATABASE_REQUIRED/);
  });
});

describe("test database isolation without empty-table DDL", () => {
  it("rejects unsafe targets before complete cleanup or bootstrap", () => {
    vi.stubEnv("ALLOW_TEST_DB_PORT_3306", "0");
    for (const url of [
      "mysql://root@remote.test:3310/erp_test",
      "mysql://root@127.0.0.1:3310/erp",
      "mysql://root@127.0.0.1:3306/erp_test",
    ])
      expect(() => assertSafeCleanupTarget(url)).toThrow(/refusing cleanup/);
  });
  it("never bootstraps READY over an existing marker or any populated business table", async () => {
    for (const name of ["inventoryProjectionState", "productVariants"]) {
      const query = vi
        .fn()
        .mockResolvedValueOnce([
          [{ name: "inventoryProjectionState" }, { name: "productVariants" }],
          [],
        ])
        .mockResolvedValueOnce([[{ name }], []]);
      await expect(
        bootstrapEmptyInventoryProjection(
          {
            query,
            escape: (value: string) => `'${value}'`,
          } as unknown as mysql.Connection,
          "mysql://root@127.0.0.1:3310/erp_test",
        ),
      ).rejects.toThrow(/not empty/);
      expect(
        query.mock.calls.some((call) => String(call[0]).startsWith("INSERT")),
      ).toBe(false);
    }
  });
  it("initializes the marker only after exact whole-database emptiness verification", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          { name: "inventoryProjectionState" },
          { name: "productVariants" },
          { name: "receipts" },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{}, []]);
    await bootstrapEmptyInventoryProjection(
      {
        query,
        escape: (value: string) => `'${value}'`,
      } as unknown as mysql.Connection,
      "mysql://root@127.0.0.1:3310/erp_test",
    );
    expect(query.mock.calls[1][0]).toContain("FROM `receipts`");
    expect(query.mock.calls[2][0]).toBe(
      "INSERT INTO inventoryProjectionState (id, readyVersion) VALUES (1, 1)",
    );
    await clearTestTable(
      { query } as unknown as mysql.Connection,
      "inventoryProjectionState",
      false,
    );
    expect(query.mock.calls[3][0]).toBe(
      "DELETE FROM `inventoryProjectionState`",
    );
  });
  it("drains and clears tables that appear after the initial cleanup snapshot", async () => {
    const calls: string[] = [];
    const bootstrap = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        calls.push("bootstrap:late");
        throw new NonEmptyTestDatabaseError([
          "appNotifications",
          "webPushOutbox",
        ]);
      })
      .mockImplementationOnce(async () => {
        calls.push("bootstrap:empty");
      });
    const drain = vi.fn(async () => {
      calls.push("drain");
    });
    const clearLateTables = vi.fn(async (tables: string[]) => {
      calls.push(`clear:${tables.join(",")}`);
    });

    await retryLateTestCleanup({ bootstrap, drain, clearLateTables });

    expect(calls).toEqual([
      "bootstrap:late",
      "drain",
      "clear:appNotifications,webPushOutbox",
      "bootstrap:empty",
    ]);
    expect(clearLateTables).toHaveBeenCalledExactlyOnceWith([
      "appNotifications",
      "webPushOutbox",
    ]);
  });
  it("fails closed when a background writer survives the bounded cleanup retries", async () => {
    const bootstrap = vi.fn(async () => {
      throw new NonEmptyTestDatabaseError(["appNotifications"]);
    });
    const drain = vi.fn(async () => {});
    const clearLateTables = vi.fn(async (_tables: string[]) => {});

    await expect(
      retryLateTestCleanup({ bootstrap, drain, clearLateTables }),
    ).rejects.toThrow(/not empty \(appNotifications\)/);
    expect(bootstrap).toHaveBeenCalledTimes(4);
    expect(drain).toHaveBeenCalledTimes(3);
    expect(clearLateTables).toHaveBeenCalledTimes(3);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeCleanupConn();
  });

  it("selects every populated table in one exact existence query", async () => {
    const query = vi
      .fn()
      .mockResolvedValue([[{ name: "customers" }, { name: "auditLogs" }], []]);
    const escape = vi.fn((value) => `'${value}'`);
    expect(
      await populatedTestTables(
        { query, escape } as unknown as mysql.Connection,
        ["customers", "auditLogs", "empty"],
      ),
    ).toEqual(["customers", "auditLogs"]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain(
      "WHERE EXISTS (SELECT 1 FROM `customers` LIMIT 1) UNION ALL",
    );
    expect(query.mock.calls[0][0]).toContain("FROM `empty` LIMIT 1");
  });
  it("does not infer empty tables from estimates or hide snapshot failures", async () => {
    const query = vi.fn().mockRejectedValue(new Error("snapshot unavailable"));
    const escape = (value: string) => `'${value}'`;
    await expect(
      populatedTestTables({ query, escape } as unknown as mysql.Connection, [
        "customers",
      ]),
    ).rejects.toThrow("snapshot unavailable");
  });
  it("rejects unexpected snapshot rows instead of silently skipping cleanup", async () => {
    const query = vi.fn().mockResolvedValue([[{ name: "unknown" }], []]);
    const escape = (value: string) => `'${value}'`;
    await expect(
      populatedTestTables({ query, escape } as unknown as mysql.Connection, [
        "customers",
      ]),
    ).rejects.toThrow("Unknown table");
  });
  it("handles an empty table list without issuing malformed SQL", async () => {
    const query = vi.fn();
    expect(
      await populatedTestTables({ query } as unknown as mysql.Connection, []),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it("avoids DDL only after proving a protected table has no rows", async () => {
    const query = vi.fn().mockResolvedValue([[], []]);
    await clearTestTable(
      { query } as unknown as mysql.Connection,
      "auditLogs",
      true,
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(
      "SELECT 1 FROM `auditLogs` LIMIT 1",
    );
  });
  it("still truncates a populated protected table", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ value: 1 }], []])
      .mockResolvedValueOnce([{}, []]);
    await clearTestTable(
      { query } as unknown as mysql.Connection,
      "auditLogs",
      true,
    );
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      "SELECT 1 FROM `auditLogs` LIMIT 1",
      "TRUNCATE TABLE `auditLogs`",
    ]);
  });
  it("skips duplicate SELECT 1 probe when snapshot already proved protected table is populated", async () => {
    const query = vi.fn().mockResolvedValue([{}, []]);
    await clearTestTable(
      { query } as unknown as mysql.Connection,
      "auditLogs",
      true,
      true,
    );
    expect(query).toHaveBeenCalledExactlyOnceWith("TRUNCATE TABLE `auditLogs`");
  });
  it("keeps ordinary-table DELETE rather than introducing extra DDL", async () => {
    const query = vi.fn().mockResolvedValue([{}, []]);
    await clearTestTable(
      { query } as unknown as mysql.Connection,
      "customers",
      false,
    );
    expect(query).toHaveBeenCalledExactlyOnceWith("DELETE FROM `customers`");
  });
  it("fails closed when the emptiness probe fails", async () => {
    const query = vi.fn().mockRejectedValue(new Error("probe unavailable"));
    await expect(
      clearTestTable(
        { query } as unknown as mysql.Connection,
        "auditLogs",
        true,
      ),
    ).rejects.toThrow("probe unavailable");
    expect(query).toHaveBeenCalledOnce();
  });
  it("reuses a warm cleanup connection across hooks and reconnects transparently if dropped", async () => {
    const staleEnd = vi.fn().mockResolvedValue(undefined);
    const staleQuery = vi
      .fn()
      .mockResolvedValueOnce([[{ name: "customers" }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockRejectedValueOnce(
        new Error("Connection lost: The server closed the connection."),
      );
    const freshEnd = vi.fn().mockResolvedValue(undefined);
    const freshQuery = vi
      .fn()
      .mockResolvedValueOnce([[{ name: "customers" }], []]);
    const escape = (value: string) => `'${value}'`;

    const createConnection = vi
      .fn()
      .mockResolvedValueOnce({
        query: staleQuery,
        escape,
        end: staleEnd,
      } as unknown as mysql.Connection)
      .mockResolvedValueOnce({
        query: freshQuery,
        escape,
        end: freshEnd,
      } as unknown as mysql.Connection);

    const first = await readSnapshotWithReconnect(
      "mysql://root@127.0.0.1:3310/erp_unit_test",
      createConnection,
    );
    expect(first.populated).toEqual([]);
    expect(createConnection).toHaveBeenCalledTimes(1);

    const second = await readSnapshotWithReconnect(
      "mysql://root@127.0.0.1:3310/erp_unit_test",
      createConnection,
    );
    expect(second.populated).toEqual(["customers"]);
    expect(staleEnd).toHaveBeenCalledOnce();
    expect(createConnection).toHaveBeenCalledTimes(2);
  });
});
