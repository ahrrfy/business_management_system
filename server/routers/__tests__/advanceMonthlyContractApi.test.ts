import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";
import {
  getMobilePayslip,
  getMobileToday,
} from "../../services/mobileTodayService";

const USER_ID = 700;
const EMPLOYEE_ID = 701;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function caller() {
  return appRouter.createCaller({
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    sessionId: null,
    nativeClientId: null,
    platformAdmin: null,
    user: {
      id: USER_ID,
      openId: "advance-monthly-owner",
      name: "مالك اختبار السلفة الشهرية",
      email: "advance-monthly@test.local",
      role: "admin",
      branchId: 1,
      isOwner: true,
      isActive: true,
    } as TrpcContext["user"],
  });
}

function asMillis(value: Date | string | null): number | null {
  if (value == null) return null;
  return value instanceof Date
    ? value.getTime()
    : new Date(value).getTime();
}

beforeEach(async () => {
  await truncateTables([
    "payrollObligationAllocations",
    "payrollAccountingEvents",
    "payrollObligations",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "receipts",
    "auditLogs",
    "idempotencyKeys",
    "employeeLoanRequests",
    "payrollItems",
    "payrollRuns",
    "employees",
    "monthCloseSequence",
    "branches",
    "users",
  ]);
  await db().insert(s.monthCloseSequence).values({
    id: 1,
    status: "NEEDS_BOOTSTRAP",
    version: 0,
  });
  await db().insert(s.branches).values([
    { id: 1, name: "فرع الموظف", code: "ADV-MONTH-1", type: "MAIN" },
    { id: 2, name: "فرع قديم خاطئ", code: "ADV-MONTH-2", type: "SALES" },
  ]);
  await db().insert(s.users).values({
    id: USER_ID,
    openId: "advance-monthly-owner",
    name: "مالك اختبار السلفة الشهرية",
    role: "admin",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
  await db().insert(s.employees).values({
    id: EMPLOYEE_ID,
    userId: USER_ID,
    branchId: 1,
    firstName: "موظف",
    lastName: "شهري",
    salary: "3000000.00",
    payType: "monthly",
    employmentStatus: "active",
    isActive: true,
  });
});

describe("عقد السلفة الشهرية عبر API", () => {
  it("لا يتجاهل payroll.advanceGrant الفرع أو الخصم القديمين", async () => {
    const api = caller();
    await expect(
      api.payroll.advanceGrant({
        employeeId: EMPLOYEE_ID,
        branchId: 2,
        amount: "1000.00",
        monthlyDeduction: "1000.00",
        clientRequestId: "api-wrong-branch",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.payroll.advanceGrant({
        employeeId: EMPLOYEE_ID,
        branchId: 1,
        amount: "1000.00",
        installmentsCount: 2,
        monthlyDeduction: "1000.00",
        clientRequestId: "api-wrong-installments",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.payroll.advanceGrant({
        employeeId: EMPLOYEE_ID,
        branchId: 1,
        amount: "1000.00",
        monthlyDeduction: "500.00",
        clientRequestId: "api-wrong-monthly",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);

    await api.payroll.advanceGrant({
      employeeId: EMPLOYEE_ID,
      branchId: 1,
      amount: "1000.00",
      monthlyDeduction: "1000.00",
      clientRequestId: "api-valid-monthly",
    });
    const [stored] = await db()
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.clientRequestId, "api-valid-monthly"));
    expect(stored).toMatchObject({
      branchId: 1,
      amount: "1000.00",
      installmentsCount: 1,
      monthlyDeduction: "1000.00",
      status: "PENDING",
    });
  });

  it("يرفض hrEnterprise.loans.request التقسيط القديم غير الشهري", async () => {
    const api = caller();
    await expect(
      api.hrEnterprise.loans.request({
        employeeId: EMPLOYEE_ID,
        branchId: 2,
        amount: "1000.00",
        installmentsCount: 1,
        monthlyDeduction: "1000.00",
        reason: "فرع قديم لا يطابق فرع الموظف",
        clientRequestId: "hr-invalid-branch",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.hrEnterprise.loans.request({
        employeeId: EMPLOYEE_ID,
        amount: "1000.00",
        installmentsCount: 2,
        monthlyDeduction: "500.00",
        reason: "طلب مخالف لعقد الشهر الواحد",
        clientRequestId: "hr-invalid-installments",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      api.hrEnterprise.loans.request({
        employeeId: EMPLOYEE_ID,
        amount: "1000.00",
        installmentsCount: 1,
        monthlyDeduction: "999.00",
        reason: "خصم لا يساوي مبلغ السلفة",
        clientRequestId: "hr-invalid-monthly",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
  });
});

describe("دليل دفع قسيمة الموظف", () => {
  it("يعرض حدث الدفع الفعال ويخفي الدفع المعكوس رغم paidAt العام للمسيّر", async () => {
    const activePaidAt = new Date("2026-09-28T09:30:00.000Z");
    const globalPaidAt = new Date("2026-09-30T15:00:00.000Z");
    await db().insert(s.payrollRuns).values([
      {
        id: 800,
        period: "2026-09",
        status: "paid",
        employeeCount: 1,
        revisionNo: 0,
        paidAt: globalPaidAt,
      },
      {
        id: 801,
        period: "2026-10",
        status: "paid",
        employeeCount: 1,
        revisionNo: 0,
        paidAt: new Date("2026-10-31T15:00:00.000Z"),
      },
    ]);
    await db().insert(s.payrollItems).values([
      {
        id: 810,
        runId: 800,
        employeeId: EMPLOYEE_ID,
        payType: "monthly",
        gross: "1000.00",
        deductions: "100.00",
        net: "900.00",
      },
      {
        id: 811,
        runId: 801,
        employeeId: EMPLOYEE_ID,
        payType: "monthly",
        gross: "1000.00",
        deductions: "100.00",
        net: "900.00",
      },
    ]);
    await db().insert(s.payrollObligations).values([
      {
        id: 820,
        runId: 800,
        itemId: 810,
        employeeId: EMPLOYEE_ID,
        branchIdSnapshot: 1,
        revisionNo: 0,
        kind: "SALARY_NET",
        originalAmount: "900.00",
        remainingAmount: "0.00",
        status: "SETTLED",
        sourceType: "PAYROLL_APPROVAL",
        sourceKey: "test:payslip:obligation:active",
      },
      {
        id: 821,
        runId: 801,
        itemId: 811,
        employeeId: EMPLOYEE_ID,
        branchIdSnapshot: 1,
        revisionNo: 0,
        kind: "SALARY_NET",
        originalAmount: "900.00",
        remainingAmount: "900.00",
        status: "OPEN",
        sourceType: "PAYROLL_APPROVAL",
        sourceKey: "test:payslip:obligation:reversed",
      },
    ]);
    await db().insert(s.receipts).values([
      {
        id: 830,
        branchId: 1,
        direction: "OUT",
        amount: "900.00",
        paymentMethod: "TRANSFER",
        status: "COMPLETED",
        createdBy: USER_ID,
      },
      {
        id: 831,
        branchId: 1,
        direction: "OUT",
        amount: "900.00",
        paymentMethod: "TRANSFER",
        status: "COMPLETED",
        createdBy: USER_ID,
      },
    ]);
    await db().insert(s.accountingEntries).values([
      {
        id: 840,
        entryType: "PAYMENT_OUT",
        branchId: 1,
        receiptId: 830,
        amount: "900.00",
        entryDate: new Date("2026-09-28T00:00:00.000Z"),
      },
      {
        id: 841,
        entryType: "PAYMENT_OUT",
        branchId: 1,
        receiptId: 831,
        amount: "900.00",
        entryDate: new Date("2026-10-28T00:00:00.000Z"),
      },
      {
        id: 842,
        entryType: "PAYMENT_IN",
        branchId: 1,
        amount: "900.00",
        entryDate: new Date("2026-10-29T00:00:00.000Z"),
      },
    ]);
    await db().insert(s.payrollAccountingEvents).values([
      {
        id: 850,
        runId: 800,
        obligationId: 820,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: "SALARY_PAYMENT",
        accountingEntryId: 840,
        receiptId: 830,
        sourceKey: "test:payslip:payment:active",
        sourceHash: "a".repeat(64),
        occurredAt: activePaidAt,
        createdBy: USER_ID,
      },
      {
        id: 851,
        runId: 801,
        obligationId: 821,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: "SALARY_PAYMENT",
        accountingEntryId: 841,
        receiptId: 831,
        sourceKey: "test:payslip:payment:reversed",
        sourceHash: "b".repeat(64),
        occurredAt: new Date("2026-10-28T09:30:00.000Z"),
        createdBy: USER_ID,
      },
      {
        id: 852,
        runId: 801,
        obligationId: 821,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: "SALARY_PAYMENT_RETURN",
        accountingEntryId: 842,
        reversalOfId: 851,
        sourceKey: "test:payslip:payment:return",
        sourceHash: "c".repeat(64),
        occurredAt: new Date("2026-10-29T09:30:00.000Z"),
        createdBy: USER_ID,
      },
    ]);

    const api = caller();
    const active = await api.payroll.myPayslip({ runId: 800 });
    const reversed = await api.payroll.myPayslip({ runId: 801 });
    expect(asMillis(active.item.paidAt)).toBe(activePaidAt.getTime());
    expect(asMillis(active.item.paidAt)).not.toBe(globalPaidAt.getTime());
    expect(reversed.item.paidAt).toBeNull();

    const history = await api.superApp.payrollHistory({ limit: 12 });
    expect(
      history.find((row) => row.runId === 800)?.paidAt,
    ).not.toBeNull();
    expect(history.find((row) => row.runId === 800)?.status).toBe("paid");
    expect(history.find((row) => row.runId === 801)?.paidAt).toBeNull();
    expect(history.find((row) => row.runId === 801)?.status).toBe("approved");

    const activeDetail = await api.superApp.payslipDetail({ payrollItemId: 810 });
    const reversedDetail = await api.superApp.payslipDetail({ payrollItemId: 811 });
    expect(asMillis(activeDetail.paidAt)).toBe(activePaidAt.getTime());
    expect(activeDetail.status).toBe("paid");
    expect(reversedDetail.paidAt).toBeNull();
    expect(reversedDetail.status).toBe("approved");

    const mobileActor = {
      userId: USER_ID,
      role: "admin",
      isOwner: true,
      branchId: 1,
    };
    const reversedToday = await getMobileToday({
      actor: mobileActor,
      date: "2026-11-01",
      db: db(),
    });
    const reversedMobileSlip = await getMobilePayslip({
      actor: mobileActor,
      db: db(),
    });
    expect(reversedToday.personal.payroll?.status).toBe("approved");
    expect(reversedMobileSlip.personal.payslip).toMatchObject({
      period: "2026-10",
      status: "approved",
      paidAt: null,
    });

    await db()
      .update(s.payrollRuns)
      .set({ status: "cancelled" })
      .where(eq(s.payrollRuns.id, 801));
    const activeToday = await getMobileToday({
      actor: mobileActor,
      date: "2026-11-01",
      db: db(),
    });
    const activeMobileSlip = await getMobilePayslip({
      actor: mobileActor,
      db: db(),
    });
    expect(activeToday.personal.payroll?.status).toBe("paid");
    expect(activeMobileSlip.personal.payslip?.status).toBe("paid");
    expect(asMillis(activeMobileSlip.personal.payslip?.paidAt ?? null)).toBe(
      activePaidAt.getTime(),
    );

    await db()
      .update(s.payrollAccountingEvents)
      .set({ receiptId: null, settlementEvidence: {} })
      .where(eq(s.payrollAccountingEvents.id, 850));
    const malformedEvidence = await api.payroll.myPayslip({ runId: 800 });
    const malformedMobileSlip = await getMobilePayslip({
      actor: mobileActor,
      db: db(),
    });
    expect(malformedEvidence.item.paidAt).toBeNull();
    expect(malformedMobileSlip.personal.payslip).toMatchObject({
      period: "2026-09",
      status: "approved",
      paidAt: null,
    });
  });
});
