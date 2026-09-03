import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(async () => []),
  getRun: vi.fn(async () => null),
  compute: vi.fn(async (period: string) => ({
    runId: 10,
    period,
    employeeCount: 1,
    totalCommission: "100.00",
    recomputed: false,
  })),
  approve: vi.fn(async () => ({
    id: 10,
    period: "2026-08",
    status: "approved" as const,
    requiresPayrollRegeneration: false,
  })),
  requestApproval: vi.fn(async () => ({ id: 31, status: "PENDING" as const })),
  approveRequest: vi.fn(async () => ({ request: { id: 31 }, runApproval: null })),
  saveTargets: vi.fn(async () => ({ saved: 1, removed: 0 })),
  createPlan: vi.fn(async () => ({ planId: 20 })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("../../services/commissions/engine", () => ({ computeCommissionRun: mocks.compute }));
vi.mock("../../services/commissions/runs", () => ({
  listRuns: mocks.listRuns,
  getRun: mocks.getRun,
  approveRun: mocks.approve,
  unapproveRun: vi.fn(),
  deleteDraft: vi.fn(),
}));
vi.mock("../../services/commissions/runApprovals", () => ({
  requestCommissionRunApproval: mocks.requestApproval,
  approveCommissionRunRequest: mocks.approveRequest,
  rejectCommissionRunRequest: vi.fn(),
  listCommissionRunApprovalRequests: vi.fn(async () => []),
}));
vi.mock("../../services/commissions/plans", () => ({
  listPlans: vi.fn(async () => []),
  listAssignmentBoard: vi.fn(async () => []),
  createPlan: mocks.createPlan,
  updatePlan: vi.fn(),
  setPlanActive: vi.fn(),
  assignPlan: vi.fn(),
  endAssignment: vi.fn(),
}));
vi.mock("../../services/commissions/targets", () => ({
  getTargetsGrid: vi.fn(async () => []),
  saveTargets: mocks.saveTargets,
  copyTargetsFromPrevious: vi.fn(),
}));
vi.mock("../../services/commissions/performance", () => ({
  getLeaderboard: vi.fn(),
  getMyStatus: vi.fn(),
}));
vi.mock("../../services/auditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/auditService")>()),
  logAudit: mocks.audit,
}));

import { commissionsRouter } from "../commissionsRouter";

function caller(user: { id: number; role: string; branchId: number | null; permissionsOverride?: unknown }) {
  return commissionsRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: { ...user, totpEnabledAt: new Date() },
  } as never);
}

describe("commissionsRouter — company/branch authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("يثبت مدير الفرع على فرعه ويتيح له طلب اعتماد الفرع دون اعتماد الشركة", async () => {
    const manager = caller({ id: 7, role: "manager", branchId: 3 });
    await manager.runs.list();
    await manager.runs.compute({ period: "2026-08" });
    await manager.targets.saveAll({ period: "2026-08", rows: [{ employeeId: 8, target: "1000" }] });
    await manager.runs.approve({ id: 10, requestKey: "commission-manager-1", reason: "كشف الفرع جاهز" });
    await expect(manager.runs.approveRequest({
      id: 31,
      expectedVersion: 1,
      decisionKey: "commission-manager-decision",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(manager.plans.create({
      name: "خطة",
      tierMode: "AMOUNT_SLAB",
      tiers: [{ threshold: "0", ratePct: "1", fixedBonus: "0" }],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.listRuns).toHaveBeenCalledWith(3);
    expect(mocks.compute).toHaveBeenCalledWith("2026-08", expect.objectContaining({ userId: 7 }), 3);
    expect(mocks.saveTargets).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 7 }), 3);
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 10, scopeBranchId: 3 }),
      expect.objectContaining({ userId: 7 }),
      3,
    );
    expect(mocks.approveRequest).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.createPlan).not.toHaveBeenCalled();
  });

  it("يفتح الشركة للأدمن والمالية المركزية ذات منح FULL مع بقاء maker-checker في الخدمة", async () => {
    const admin = caller({ id: 1, role: "admin", branchId: null });
    await admin.runs.compute({ period: "2026-08" });
    await admin.runs.approve({ id: 10, requestKey: "commission-admin-1", reason: "كشف الشركة جاهز" });
    expect(mocks.compute).toHaveBeenLastCalledWith("2026-08", expect.objectContaining({ userId: 1 }), null);
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 10, scopeBranchId: null }),
      expect.objectContaining({ userId: 1 }),
      null,
    );
    expect(mocks.approve).not.toHaveBeenCalled();

    const centralFinance = caller({
      id: 2,
      role: "accountant",
      branchId: null,
      permissionsOverride: { commissions: "FULL" },
    });
    await centralFinance.runs.compute({ period: "2026-09" });
    await centralFinance.runs.approve({ id: 10, requestKey: "commission-finance-1", reason: "مراجعة مالية مكتملة" });
    expect(mocks.compute).toHaveBeenLastCalledWith("2026-09", expect.objectContaining({ userId: 2 }), null);
  });

  it("لا يحول منح FULL لدور تشغيلي إلى سلطة عمولات", async () => {
    const cashier = caller({
      id: 9,
      role: "cashier",
      branchId: 1,
      permissionsOverride: { commissions: "FULL" },
    });
    await expect(cashier.runs.compute({ period: "2026-08" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.compute).not.toHaveBeenCalled();
  });
});
