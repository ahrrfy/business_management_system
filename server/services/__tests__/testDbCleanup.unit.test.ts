import type mysql from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTestTable,
  closeCleanupConn,
  populatedTestTables,
  readSnapshotWithReconnect,
} from "./__setup__";

describe("test database isolation without empty-table DDL", () => {
  afterEach(async () => {
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
      .mockRejectedValueOnce(new Error("Connection lost: The server closed the connection."));
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

    const first = await readSnapshotWithReconnect("mysql://root@127.0.0.1:3310/erp_unit_test", createConnection);
    expect(first.populated).toEqual([]);
    expect(createConnection).toHaveBeenCalledTimes(1);

    const second = await readSnapshotWithReconnect("mysql://root@127.0.0.1:3310/erp_unit_test", createConnection);
    expect(second.populated).toEqual(["customers"]);
    expect(staleEnd).toHaveBeenCalledOnce();
    expect(createConnection).toHaveBeenCalledTimes(2);
  });
});
