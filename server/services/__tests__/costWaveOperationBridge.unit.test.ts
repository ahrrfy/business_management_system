import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import type { OperationPolicy } from "@shared/operationPermissions";

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock("../tx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tx")>(),
  withTx: async (fn: (tx: Tx) => Promise<unknown>) => fn(state.tx!),
}));

import { getCostWave, listCostWaves, previewCostWave } from "../inventory/costWaveService";

const actor: Actor = { userId: 4, role: "warehouse", branchId: 3 };
const operations: Array<[string, () => Promise<unknown>]> = [
  ["inventory.previewCostWave", () => previewCostWave({ purpose: "CORRECTION", ruleType: "INCREASE_PERCENT", changeValue: "5", filters: { scope: "ALL" } }, actor)],
  ["inventory.costWaves", () => listCostWaves({}, actor)],
  ["inventory.costWave", () => getCostWave(42, actor)],
];

function transaction(path?: string, businessRows: unknown[][] = [], canSeeCost = true) {
  const operationPolicy: OperationPolicy = { version: 1, grants: path ? { [`operation.${path}`]: true } : {}, dataVisibility: { purchaseCost: canSeeCost, profitMargin: canSeeCost } };
  const rows: unknown[][] = [[{ customRoleId: null }], [{ id: 4, role: "warehouse", branchId: 3, isActive: true, isOwner: false,
    customRoleId: null, permissionsOverride: null, operationPolicy }], ...businessRows];
  let offset = 0;
  const select = vi.fn(() => {
    const result = rows[offset++] ?? [];
    const query: Record<string, unknown> = {
      from: () => query, where: () => query, for: () => query, limit: () => query,
      orderBy: () => query, leftJoin: () => query,
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
  });
  const insert = vi.fn(() => { throw new Error("Unexpected cost write"); });
  const update = vi.fn(() => { throw new Error("Unexpected cost write"); });
  state.tx = { select, insert, update } as unknown as Tx;
  return { select, insert, update };
}

describe("cost wave reads use exact current operation authority", () => {
  it.each(operations)("rejects a revoked %s before reading valuations", async (_path, execute) => {
    const tx = transaction();
    await expect(execute()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each(operations)("requires cost visibility alongside %s", async (path, execute) => {
    const tx = transaction(path, [], false);
    await expect(execute()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it("lets the delegated warehouse reader list its branch", async () => {
    transaction("inventory.costWaves", [[]]);
    await expect(listCostWaves({}, actor)).resolves.toEqual({ rows: [], hasMore: false, nextCursor: null });
  });

  it("does not let a list grant authorize individual wave details", async () => {
    transaction("inventory.costWaves");
    await expect(getCostWave(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retains branch and cross-branch wave isolation after delegation", async () => {
    transaction("inventory.costWave", [[{ id: 42, branchId: 8, isCrossBranch: false }]]);
    await expect(getCostWave(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    transaction("inventory.costWave", [[{ id: 42, branchId: 3, isCrossBranch: true }]]);
    await expect(getCostWave(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
