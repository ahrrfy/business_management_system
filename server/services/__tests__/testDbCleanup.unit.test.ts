import type mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { clearTestTable } from "./__setup__";

describe("test database isolation without empty-table DDL", () => {
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
});
