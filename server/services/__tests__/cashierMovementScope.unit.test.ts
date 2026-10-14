import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../db", () => ({ getDb: () => ({ execute: state.execute }) }));

import { getRecentMovements } from "../treasury/movements";

const dialect = new MySqlDialect();
const actor = {
  scopedBranchId: 3,
  actorBranchId: 3,
  userId: 41,
  role: "cashier",
  operationPolicyEnabled: true,
};

beforeEach(() => state.execute.mockReset().mockResolvedValue([[]]));

function query() {
  expect(state.execute).toHaveBeenCalledOnce();
  return dialect.sqlToQuery(state.execute.mock.calls[0][0]);
}

function expectOwnDrawer(expectedOwner: number) {
  const { sql, params } = query();
  // Both sides of the UNION must be isolated, including receipt-free expenses.
  expect(sql).toContain("r.shiftId IN (SELECT s.id FROM shifts s WHERE s.userId = ?)");
  expect(sql).toContain("e.shiftId IN (SELECT s.id FROM shifts s WHERE s.userId = ?)");
  expect(params.filter((value) => value === expectedOwner)).toHaveLength(2);
  expect(sql).toContain("r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL");
  expect(sql).toContain("e.expenseCashBucket = 'DRAWER' OR e.expenseCashBucket IS NULL");
}

describe("cash movement record scope", () => {
  it("retains the cashier's own drawer after canonical conversion", async () => {
    await getRecentMovements({}, { ...actor, scopedOwnerId: 41 });
    expectOwnDrawer(41);
  });

  it("honors OWN for a canonical manager and uses the authoritative scoped identity", async () => {
    await getRecentMovements({}, { ...actor, role: "manager", userId: 99, scopedOwnerId: 41 });
    expectOwnDrawer(41);
  });

  it("keeps the forced branch even when a client asks for another branch", async () => {
    await getRecentMovements({ branchId: 8 }, { ...actor, scopedOwnerId: 41 });
    const { sql, params } = query();
    expect(sql).toContain("AND r.branchId = ?");
    expect(sql).toContain("AND e.branchId = ?");
    expect(params.filter((value) => value === 3)).toHaveLength(2);
    expect(params).not.toContain(8);
    expectOwnDrawer(41);
  });

  it("allows branch movements only with an explicit canonical BRANCH scope", async () => {
    await getRecentMovements({}, { ...actor, scopedOwnerId: null });
    const { sql } = query();
    expect(sql).not.toContain("WHERE s.userId = ?");
    expect(sql).not.toContain("r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL");
    expect(sql).toContain("AND r.branchId = ?");
    expect(sql).toContain("AND e.branchId = ?");
  });

  it("defaults omitted canonical ownership safely to the authenticated user", async () => {
    await getRecentMovements({}, actor);
    expectOwnDrawer(41);
  });

  it("rejects canonical scope with neither an explicit scope nor an authenticated identity", async () => {
    await expect(getRecentMovements({}, { ...actor, userId: undefined }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it.each(["cashier", "warehouse", "print_operator"])("preserves legacy %s own-drawer isolation", async (role) => {
    await getRecentMovements({}, { ...actor, role, operationPolicyEnabled: false });
    expectOwnDrawer(41);
  });

  it("preserves legacy managerial branch visibility", async () => {
    await getRecentMovements({}, { ...actor, role: "manager", operationPolicyEnabled: false });
    expect(query().sql).not.toContain("WHERE s.userId = ?");
  });

  it("retains the blind-count evidence exclusion for a delegated branch receiver", async () => {
    await getRecentMovements({}, { ...actor, scopedOwnerId: null, canAcceptHandover: true });
    const { sql } = query();
    expect(sql).toContain("AND NOT (");
    expect(sql).toContain("FROM cashCustodyCounts firstCount");
    expect(sql).toContain("custodyEvidence.entryType IN ('CASH_TRANSFER_OUT', 'CASH_HANDOVER')");
    expect(sql).toContain("r.createdBy <> ?");
    expect(sql).toContain("s.userId <> ?");
  });
});
