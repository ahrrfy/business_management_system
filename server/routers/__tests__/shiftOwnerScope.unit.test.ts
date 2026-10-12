import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  where: [] as unknown[],
  report: vi.fn(),
}));
vi.mock("../../trpc", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<any>().create();
  return {
    router: t.router,
    ownerProcedure: t.procedure,
    selfServiceProcedure: t.procedure,
    treasuryCashierProcedure: t.procedure,
    treasuryHandoverRecipientsProcedure: t.procedure,
    treasuryReadProcedure: t.procedure,
  };
});
vi.mock("../../db", () => ({
  getDb: () => ({
    select: (fields: Record<string, unknown>) => {
      const result = fields.n ? [{ n: 0 }] : [];
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const key of ["from", "leftJoin", "orderBy", "limit", "offset"]) {
        chain[key] = () => chain;
      }
      chain.where = (condition: unknown) => { state.where.push(condition); return chain; };
      return chain;
    },
  }),
}));
vi.mock("../../services/shiftService", () => ({
  getShiftReport: state.report,
  enrichShiftListProvenance: (rows: unknown[]) => rows,
  getOpenShift: vi.fn(), openShift: vi.fn(), closeShift: vi.fn(),
}));
vi.mock("../../services/auditService", () => ({ logAudit: vi.fn() }));
vi.mock("../../services/legacyNegativeShiftService", () => ({ remediateAndCloseLegacyNegativeShifts: vi.fn() }));
vi.mock("../../services/cashDropService", () => ({ createCashDrop: vi.fn() }));
vi.mock("../../services/shiftFundingService", () => ({
  cancelShiftFundingRequest: vi.fn(), listMyPendingShiftFunding: vi.fn(),
  listEligibleShiftFundingSources: vi.fn(), listPendingShiftFundingForOwners: vi.fn(),
  requestAdditionalShiftFunding: vi.fn(), respondToShiftFundingRequest: vi.fn(),
}));

import { shiftRouter } from "../shiftRouter";

const dialect = new MySqlDialect();
function caller(owner: number | null, branch: number | null = 3, role = "cashier") {
  // Middleware is deliberately excluded: these tests verify handlers consume its scope.
  return shiftRouter.createCaller({
    user: { id: 41, role, branchId: 3 }, scopedOwnerId: owner, scopedBranchId: branch,
  } as any);
}

beforeEach(() => {
  state.where.length = 0;
  state.report.mockReset().mockResolvedValue({ shift: { id: 9, branchId: 3, userId: 41 } });
});

describe("shift read handlers consume record ownership", () => {
  it("applies own-user and branch predicates to both list rows and its total", async () => {
    await caller(41).list({ branchId: 8, offset: 1 });
    expect(state.where).toHaveLength(2);
    for (const condition of state.where) {
      const { sql, params } = dialect.sqlToQuery(condition as any);
      expect(sql).toContain("`shifts`.`userId` = ?");
      expect(sql).toContain("`shifts`.`branchId` = ?");
      expect(params).toContain(41);
      expect(params).toContain(3);
      expect(params).not.toContain(8);
    }
  });

  it("keeps OWN isolation with a keyset cursor", async () => {
    await caller(41).list({ cursor: 900 });
    expect(state.where).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(state.where[0] as any);
    expect(sql).toContain("`shifts`.`userId` = ?");
    expect(params).toContain(41);
    expect(params).toContain(900);
  });

  it("does not derive broader list scope from a managerial base role", async () => {
    await caller(41, 3, "manager").list();
    expect(dialect.sqlToQuery(state.where[0] as any).params).toContain(41);
  });

  it("permits deliberately scoped branch supervision without ownership filtering", async () => {
    await caller(null, 3, "manager").list();
    const { sql, params } = dialect.sqlToQuery(state.where[0] as any);
    expect(sql).not.toContain("`shifts`.`userId` = ?");
    expect(params).toEqual([3]);
  });

  it("rejects another employee's report inside the same branch", async () => {
    state.report.mockResolvedValue({ shift: { id: 9, branchId: 3, userId: 42 } });
    await expect(caller(41).report({ shiftId: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a cross-branch report even if the employee owns it", async () => {
    state.report.mockResolvedValue({ shift: { id: 9, branchId: 8, userId: 41 } });
    await expect(caller(41).report({ shiftId: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed when a scoped report has no branch identity", async () => {
    state.report.mockResolvedValue({ shift: { id: 9, branchId: null, userId: 41 } });
    await expect(caller(41).report({ shiftId: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns the user's own shift report", async () => {
    expect(await caller(41).report({ shiftId: 9 })).toEqual({ shift: { id: 9, branchId: 3, userId: 41 } });
  });

  it("retains deliberate branch supervision and administrator cross-branch access", async () => {
    state.report.mockResolvedValue({ shift: { id: 9, branchId: 3, userId: 42 } });
    expect(await caller(null, 3, "manager").report({ shiftId: 9 })).not.toBeNull();
    state.report.mockResolvedValue({ shift: { id: 10, branchId: 8, userId: 42 } });
    expect(await caller(null, null, "admin").report({ shiftId: 10 })).not.toBeNull();
  });

  it("preserves a missing report response", async () => {
    state.report.mockResolvedValue(null);
    expect(await caller(41).report({ shiftId: 999 })).toBeNull();
  });
});
