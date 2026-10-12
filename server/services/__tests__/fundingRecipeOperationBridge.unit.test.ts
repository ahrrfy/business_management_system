import { describe, expect, it, vi } from "vitest";
import type { OperationPolicy } from "@shared/operationPermissions";
import type { Tx } from "../../db";
import type { Actor } from "../tx";

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock("../tx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tx")>(),
  withTx: async (fn: (tx: Tx) => Promise<unknown>) => fn(state.tx!),
}));

import { fundTreasury } from "../treasuryFundingService";
import { substituteRecipeMaterial } from "../recipeService";

const actor: Actor = { userId: 4, role: "warehouse", branchId: 3 };
const funding = { branchId: 3, amount: "100.00", description: "رأس مال", clientRequestId: "fund-4" };
const substitution = { recipeId: 42, originalVariantId: 10, substituteVariantId: 11 };
const fundingPath = "treasury.fundTreasury";
const substitutionPath = "production.recipes.substituteMaterial";

function policy(path: string, allowed = true): OperationPolicy {
  return { version: 1, grants: { [`operation.${path}`]: allowed } };
}

function transaction(operationPolicy: OperationPolicy | null, options: {
  role?: string;
  accessExpiresAt?: Date;
  businessRows?: unknown[][];
} = {}) {
  const rows: unknown[][] = [[{ customRoleId: null }], [{
    id: 4, role: options.role ?? "warehouse", branchId: 3, isActive: true, isOwner: false,
    customRoleId: null, permissionsOverride: null, operationPolicy, accessExpiresAt: options.accessExpiresAt,
  }], ...(options.businessRows ?? [])];
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
  const insert = vi.fn(() => { throw new Error("Unexpected financial write"); });
  const update = vi.fn(() => { throw new Error("Unexpected cost write"); });
  const execute = vi.fn(() => { throw new Error("Unexpected financial lock or write"); });
  state.tx = { select, insert, update, execute } as unknown as Tx;
  return { select, insert, update, execute };
}

describe("funding and permanent recipe substitution use fresh exact authority", () => {
  it("lets a delegated warehouse funder reach the ordinary input checks", async () => {
    const tx = transaction(policy(fundingPath));
    await expect(fundTreasury({ ...funding, clientRequestId: "" }, actor)).rejects.toMatchObject({
      code: "BAD_REQUEST", message: "مفتاح idempotency إلزامي لتمويل الخزينة",
    });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("retains the contracted legacy funding role denial", async () => {
    const tx = transaction(null);
    await expect(fundTreasury(funding, actor)).rejects.toMatchObject({
      code: "FORBIDDEN", message: "تمويل الخزينة للمدير فأعلى",
    });
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it("keeps a delegated funder within its own branch", async () => {
    const tx = transaction(policy(fundingPath));
    await expect(fundTreasury({ ...funding, branchId: 8 }, actor)).rejects.toMatchObject({
      code: "FORBIDDEN", message: "لا يمكنك تمويل خزينة فرعٍ غير فرعك",
    });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("rechecks a manager's revoked funding grant before idempotency or any money write", async () => {
    const tx = transaction(policy(fundingPath, false), { role: "manager" });
    await expect(fundTreasury(funding, { ...actor, role: "manager" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("does not turn movement visibility into funding authority", async () => {
    const tx = transaction(policy("treasury.getRecentMovements"));
    await expect(fundTreasury(funding, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it("lets an exact substitution grant reach the recipe existence check", async () => {
    const tx = transaction(policy(substitutionPath), { businessRows: [[]] });
    await expect(substituteRecipeMaterial(substitution, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.select).toHaveBeenCalledTimes(3);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("retains the contracted legacy permanent substitution denial", async () => {
    const tx = transaction(null);
    await expect(substituteRecipeMaterial(substitution, actor)).rejects.toMatchObject({
      code: "FORBIDDEN", message: expect.stringContaining("غير مصرح باعتماد تعديل الوصفة الدائم"),
    });
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it("rejects an unrelated funding grant before reading or changing the recipe", async () => {
    const tx = transaction(policy(fundingPath));
    await expect(substituteRecipeMaterial(substitution, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects an expired account despite its saved substitution grant", async () => {
    const tx = transaction(policy(substitutionPath), { accessExpiresAt: new Date(0) });
    await expect(substituteRecipeMaterial(substitution, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it("rejects stale role identity before an otherwise granted substitution", async () => {
    const tx = transaction(policy(substitutionPath), { role: "cashier" });
    await expect(substituteRecipeMaterial(substitution, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
