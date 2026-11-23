import { beforeEach, describe, expect, it, vi } from "vitest";

const selectQueue: unknown[][] = [];

vi.mock("../../db", () => ({
  getDb: () => ({
    select: () => {
      const rows = selectQueue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), {
        limit: async () => rows,
      });
      chain.limit = async () => rows;
      return chain;
    },
  }),
}));

import { reconcileEmployeeAdvances } from "../reconcileService";

describe("reconcileEmployeeAdvances", () => {
  beforeEach(() => {
    selectQueue.length = 0;
  });

  it("returns empty when double-entry mode is OFF or shadowCycleId is missing", async () => {
    selectQueue.push([{ mode: "OFF", cycleId: null }]);
    await expect(reconcileEmployeeAdvances()).resolves.toEqual([]);
  });

  it("returns empty when operational remaining matches active cycle journal net", async () => {
    selectQueue.push(
      [{ mode: "ACTIVE", cycleId: "cycle-2026-11" }],
      [{ total: "125000.00" }],
      [{ net: "125000.00", count: 3 }],
    );
    await expect(reconcileEmployeeAdvances()).resolves.toEqual([]);
  });

  it("reports positive magnitude drift scoped to active shadowCycleId when mismatch exists", async () => {
    selectQueue.push(
      [{ mode: "SHADOW", cycleId: "cycle-2026-11" }],
      [{ total: "100000.00" }],
      [{ net: "75000.00", count: 2 }],
    );
    const res = await reconcileEmployeeAdvances();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      entity: "employeeAdvancesLedger",
      id: 0,
      expected: "100000.00",
      actual: "75000.00",
      drift: "25000.00",
    });
    expect(res[0]?.note).toContain("cycle-2026-11");
    expect(res[0]?.note).toContain("-25000.00");
  });
});
