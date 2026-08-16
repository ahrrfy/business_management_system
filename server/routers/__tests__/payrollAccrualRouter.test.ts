import { describe, expect, it, vi } from "vitest";

const payrollReadMocks = vi.hoisted(() => ({
  listPayrollObligations: vi.fn(async () => [{ employeeId: 10, kind: "SALARY_NET" }]),
  listStatutoryObligationSummary: vi.fn(async () => [
    { kind: "INCOME_TAX", branchIdSnapshot: 2, remainingAmount: "50.00", openCount: 1 },
  ]),
  getPayrollFinancialLedger: vi.fn(async () => [
    { eventId: 1, movementType: "SALARY_PAYMENT" },
  ]),
  approveRun: vi.fn(async () => ({ id: 1, period: "2026-08", replayed: true })),
  payRun: vi.fn(async () => ({ id: 1, period: "2026-08", totalNet: "10.00", replayed: true })),
}));

vi.mock("../../services/payrollService", () => payrollReadMocks);
const advanceMocks = vi.hoisted(() => ({
  listAdvances: vi.fn(async () => [{ id: 1, branchId: 2 }]),
  listAdvanceRepaymentRequests: vi.fn(async () => [{ id: 1, branchId: 2 }]),
  getAdvanceRepaymentRequest: vi.fn(async () => ({ id: 1, branchId: 2 })),
  listAdvanceRepaymentLedger: vi.fn(async () => [{ id: 1, branchId: 2 }]),
  employeeBalance: vi.fn(async () => ({ employeeId: 10, balance: "0.00", activeCount: 0 })),
  approveAdvanceRepaymentRequest: vi.fn(async () => ({ id: 1, replayed: true })),
}));
vi.mock("../../services/advancesService", () => advanceMocks);
import { payrollRouter } from "../payrollRouter";

function blockedCaller() {
  return payrollRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 91,
      role: "cashier",
      branchId: 1,
      permissionsOverride: { hr: "NONE" },
      totpEnabledAt: new Date(),
    },
  } as never);
}

function nonOwnerHrFullCaller() {
  return payrollRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 92,
      role: "manager",
      branchId: 2,
      isOwner: false,
      permissionsOverride: { hr: "FULL" },
      totpEnabledAt: new Date(),
    },
  } as never);
}

function nonOwnerWithoutBranchCaller() {
  return payrollRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 95,
      role: "manager",
      branchId: null,
      isOwner: false,
      permissionsOverride: { hr: "FULL" },
      totpEnabledAt: new Date(),
    },
  } as never);
}

function ownerHrReadCaller() {
  return payrollRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 93,
      role: "manager",
      branchId: 1,
      isOwner: true,
      permissionsOverride: { hr: "READ" },
      totpEnabledAt: new Date(),
    },
  } as never);
}

function ownerHrFullCaller() {
  return payrollRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 94,
      role: "manager",
      branchId: 1,
      isOwner: true,
      permissionsOverride: { hr: "FULL" },
      totpEnabledAt: new Date(),
    },
  } as never);
}

describe("payroll accrual router authority", () => {
  it("does not let branch hr FULL read or mutate the company-wide payroll run", async () => {
    const caller = nonOwnerHrFullCaller();
    await expect(caller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.get({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.summaryReport({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.financialLedger()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.generate({ period: "2026-07" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.updateItem({ itemId: 1, overtime: "1.00" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.approve({ id: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.cancel({ id: 1, reason: "إعادة مراجعة" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.pay({ id: 1, paymentMethod: "CASH" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.returnSalaryPayment({ accountingEventId: 1, reason: "سبب إعادة راتب" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps obligations and remittance evidence behind hr READ", async () => {
    await expect(blockedCaller().obligations()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(blockedCaller().remittances()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("hides detailed salary obligations from branch HR and exposes statutory aggregates only", async () => {
    const branchHr = nonOwnerHrFullCaller();
    await expect(branchHr.obligations()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(branchHr.statutoryObligationSummary()).resolves.toEqual([
      { kind: "INCOME_TAX", branchIdSnapshot: 2, remainingAmount: "50.00", openCount: 1 },
    ]);
    expect(payrollReadMocks.listStatutoryObligationSummary).toHaveBeenLastCalledWith({ branchId: 2 });

    await expect(ownerHrReadCaller().obligations()).resolves.toEqual([
      { employeeId: 10, kind: "SALARY_NET" },
    ]);
    expect(payrollReadMocks.listPayrollObligations).toHaveBeenLastCalledWith(undefined);
    await expect(ownerHrReadCaller().financialLedger({ period: "2026-08" })).resolves.toEqual([
      { eventId: 1, movementType: "SALARY_PAYMENT" },
    ]);
    expect(payrollReadMocks.getPayrollFinancialLedger).toHaveBeenLastCalledWith({ period: "2026-08" });
  });

  it("keeps every materializing/reversal action behind hr FULL", async () => {
    const caller = blockedCaller();
    await expect(
      caller.pay({ id: 1, paymentMethod: "CASH" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.returnSalaryPayment({ accountingEventId: 1, reason: "سبب إعادة راتب" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.createRemittance({
        kind: "INCOME_TAX",
        payingBranchId: 1,
        amount: "100.00",
        authorityName: "الهيئة العامة للضرائب",
        referenceNumber: "TAX-1",
        supportingDocumentUrl: "data:image/png;base64,AA==",
        clientRequestId: "remit-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.approveRemittance({ id: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.payRemittance({ requestId: 1, paymentMethod: "CASH" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.returnRemittance({ requestId: 1, reason: "إعادة فعلية" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("forces advance and repayment reads to the branch while owner approval stays owner-only", async () => {
    const branchHr = nonOwnerHrFullCaller();
    await expect(branchHr.advanceRepaymentRequests({ branchId: 1 })).resolves.toEqual([{ id: 1, branchId: 2 }]);
    expect(advanceMocks.listAdvanceRepaymentRequests).toHaveBeenLastCalledWith({ branchId: 2 });
    await branchHr.advanceBalance({ employeeId: 10 });
    expect(advanceMocks.employeeBalance).toHaveBeenLastCalledWith(10, 2);
    await expect(branchHr.approveAdvanceRepayment({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(ownerHrFullCaller().approveAdvanceRepayment({ id: 1 })).resolves.toMatchObject({ replayed: true });
    expect(advanceMocks.approveAdvanceRepaymentRequest).toHaveBeenCalledWith(1, expect.objectContaining({ userId: 94, isOwner: true }));
  });

  it("fails closed for every advance read when a non-owner has no branch", async () => {
    const caller = nonOwnerWithoutBranchCaller();
    await expect(caller.advancesList()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.advanceBalance({ employeeId: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.advanceRepaymentRequest({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.advanceRepaymentRequests()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.advanceRepaymentLedger()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns lifecycle replays without executing audit or notification side effects", async () => {
    await expect(ownerHrFullCaller().approve({ id: 1 })).resolves.toMatchObject({ replayed: true });
    await expect(ownerHrFullCaller().pay({ id: 1, paymentMethod: "CASH", paymentDate: "2026-08-15" }))
      .resolves.toMatchObject({ replayed: true });
  });
});
