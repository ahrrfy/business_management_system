import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { baghdadToday } from "../businessDay";
import { getEmployeeAdvanceCapacity } from "../employeeAdvanceCapacityService";
import {
  cancelEmployeeLoanRequest,
  disburseEmployeeLoan,
  requestEmployeeLoan,
  reviewEmployeeLoanRequest,
} from "../employeeLoanService";
import type { Actor } from "../tx";

const MAKER_ID = 101;
const CHECKER_ID = 102;
const FOREIGN_ID = 201;
const EMPLOYEE_A = 1001;
const EMPLOYEE_B = 1002;
const FOREIGN_EMPLOYEE = 2001;

const maker: Actor = {
  userId: MAKER_ID,
  branchId: 1,
  role: "cashier",
};
const checker: Actor = {
  userId: CHECKER_ID,
  branchId: 1,
  role: "manager",
};
const foreignManager: Actor = {
  userId: FOREIGN_ID,
  branchId: 2,
  role: "manager",
};

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

function requestInput(
  clientRequestId: string,
  employeeId = EMPLOYEE_A,
  overrides: Partial<{
    amount: string;
    reason: string;
  }> = {},
) {
  return {
    employeeId,
    amount: overrides.amount ?? "1000.00",
    reason: overrides.reason ?? "طلب سلفة اختباري",
    clientRequestId,
  };
}

function createRequest(
  clientRequestId: string,
  employeeId = EMPLOYEE_A,
  actor: Actor = maker,
) {
  return requestEmployeeLoan(
    actor,
    requestInput(clientRequestId, employeeId),
    "hrEnterprise.loans.request",
  );
}

async function financialSnapshot() {
  const database = db();
  const [
    receipts,
    accountingEntries,
    employeeAdvances,
    idempotencyKeys,
    journalEntries,
    journalLines,
  ] = await Promise.all([
    database.select().from(s.receipts),
    database.select().from(s.accountingEntries),
    database.select().from(s.employeeAdvances),
    database.select().from(s.idempotencyKeys),
    database.select().from(s.journalEntries),
    database.select().from(s.journalLines),
  ]);
  return {
    receipts: receipts.length,
    accountingEntries: accountingEntries.length,
    employeeAdvances: employeeAdvances.length,
    idempotencyKeys: idempotencyKeys.length,
    journalEntries: journalEntries.length,
    journalLines: journalLines.length,
  };
}

beforeEach(async () => {
  const database = db();
  await database.insert(s.monthCloseSequence).values({
    id: 1,
    status: "NEEDS_BOOTSTRAP",
    version: 0,
  });
  await database.insert(s.branches).values([
    { id: 1, name: "فرع دورة السلف", code: "LOAN-1", type: "MAIN" },
    { id: 2, name: "فرع معزول", code: "LOAN-2", type: "SALES" },
  ]);
  await database.insert(s.users).values([
    {
      id: MAKER_ID,
      openId: "loan-lifecycle-maker",
      name: "منشئ طلب السلفة",
      role: "cashier",
      branchId: 1,
      isActive: true,
      operationPolicy: {
        version: 1,
        grants: {
          "operation.hrEnterprise.loans.request": true,
          "operation.hrEnterprise.loans.review": true,
          "operation.hrEnterprise.loans.cancel": true,
        },
      },
    },
    {
      id: CHECKER_ID,
      openId: "loan-lifecycle-checker",
      name: "مراجع طلب السلفة",
      role: "manager",
      branchId: 1,
      isActive: true,
      operationPolicy: {
        version: 1,
        grants: {
          "operation.hrEnterprise.loans.request": true,
          "operation.hrEnterprise.loans.review": true,
          "operation.hrEnterprise.loans.cancel": true,
          "operation.hrEnterprise.loans.disburse": true,
        },
      },
    },
    {
      id: FOREIGN_ID,
      openId: "loan-lifecycle-foreign",
      name: "مدير الفرع المعزول",
      role: "manager",
      branchId: 2,
      isActive: true,
      operationPolicy: {
        version: 1,
        grants: {
          "operation.hrEnterprise.loans.request": true,
          "operation.hrEnterprise.loans.review": true,
          "operation.hrEnterprise.loans.cancel": true,
          "operation.hrEnterprise.loans.disburse": true,
        },
      },
    },
  ]);
  await database.insert(s.employees).values([
    {
      id: EMPLOYEE_A,
      branchId: 1,
      firstName: "موظف",
      lastName: "أول",
      salary: "3000000.00",
      payType: "monthly",
      employmentStatus: "active",
    },
    {
      id: EMPLOYEE_B,
      branchId: 1,
      firstName: "موظف",
      lastName: "ثان",
      salary: "3000000.00",
      payType: "monthly",
      employmentStatus: "active",
    },
    {
      id: FOREIGN_EMPLOYEE,
      branchId: 2,
      firstName: "موظف",
      lastName: "الفرع الآخر",
      salary: "3000000.00",
      payType: "monthly",
      employmentStatus: "active",
    },
  ]);
});

describe("دورة طلب سلفة الموظف", () => {
  it("يعيد الطلب نفسه بالمفتاح والحمولة نفسيهما دون صف ثان", async () => {
    const input = requestInput("loan-request-stable-1");
    const first = await requestEmployeeLoan(
      maker,
      input,
      "hrEnterprise.loans.request",
    );
    const replay = await requestEmployeeLoan(
      maker,
      input,
      "hrEnterprise.loans.request",
    );

    expect(first).toMatchObject({ status: "PENDING", replayed: false });
    expect(replay).toMatchObject({
      id: first.id,
      status: "PENDING",
      payrollPeriod: first.payrollPeriod,
      replayed: true,
    });
    const rows = await db()
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.clientRequestId, input.clientRequestId));
    expect(rows).toHaveLength(1);
  });

  it("يفشل مغلقاً إذا سُحبت صلاحية HR من الدور المخصص قبل بدء المعاملة", async () => {
    await db()
      .insert(s.roles)
      .values({
        id: 9001,
        key: "loan-request-hr-revoked",
        label: "دور سُحبت منه صلاحية السلف",
        baseRole: "cashier",
        permissions: { hr: "NONE" },
        operationPolicy: null,
        isActive: true,
      });
    await db()
      .update(s.users)
      .set({ customRoleId: 9001, operationPolicy: null })
      .where(eq(s.users.id, MAKER_ID));

    await expect(
      createRequest("loan-request-after-hr-revocation"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.employeeLoanRequests)).toHaveLength(0);
    expect(await financialSnapshot()).toEqual({
      receipts: 0,
      accountingEntries: 0,
      employeeAdvances: 0,
      idempotencyKeys: 0,
      journalEntries: 0,
      journalLines: 0,
    });
  });

  it("يحسم سباق طلبين باردين بالمفتاح نفسه إلى صف واحد و replay واحد", async () => {
    const input = requestInput("loan-request-concurrent-1");
    const [left, right] = await Promise.all([
      requestEmployeeLoan(maker, input, "hrEnterprise.loans.request"),
      requestEmployeeLoan(maker, input, "hrEnterprise.loans.request"),
    ]);

    expect(left.id).toBe(right.id);
    expect([left.replayed, right.replayed].filter(Boolean)).toHaveLength(1);
    const rows = await db()
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.clientRequestId, input.clientRequestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
  });

  it("يسلسل مفتاحين مختلفين ولا يسمح أن يتجاوز مجموع حجزيهما الحد المتاح", async () => {
    const capacity = await getEmployeeAdvanceCapacity({
      employeeId: EMPLOYEE_A,
      scopedBranchId: 1,
    });
    expect(Number(capacity.maxAvailable)).toBeGreaterThan(0);
    const amount = capacity.maxAvailable;

    const results = await Promise.allSettled([
      requestEmployeeLoan(
        maker,
        requestInput("loan-request-capacity-race-a", EMPLOYEE_A, { amount }),
        "hrEnterprise.loans.request",
      ),
      requestEmployeeLoan(
        maker,
        requestInput("loan-request-capacity-race-b", EMPLOYEE_A, { amount }),
        "hrEnterprise.loans.request",
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "PRECONDITION_FAILED" },
    });
    const rows = await db()
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.employeeId, EMPLOYEE_A));
    expect(rows).toHaveLength(1);
    expect(await financialSnapshot()).toEqual({
      receipts: 0,
      accountingEntries: 0,
      employeeAdvances: 0,
      idempotencyKeys: 0,
      journalEntries: 0,
      journalLines: 0,
    });
  });

  it("يرفض إعادة المفتاح نفسه بحمولة مختلفة ويحفظ الطلب الأصلي", async () => {
    const key = "loan-request-payload-conflict-1";
    const original = requestInput(key, EMPLOYEE_A, {
      amount: "1000.00",
      reason: "الحمولة الأصلية",
    });
    const first = await requestEmployeeLoan(
      maker,
      original,
      "hrEnterprise.loans.request",
    );

    await expect(
      requestEmployeeLoan(
        maker,
        { ...original, amount: "2000.00", reason: "حمولة مختلفة" },
        "hrEnterprise.loans.request",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const rows = await db()
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.clientRequestId, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      amount: "1000.00",
      reason: "الحمولة الأصلية",
      status: "PENDING",
    });
  });

  it("يمنع المنشئ من اعتماد طلبه ويسمح لمراجع آخر في الفرع", async () => {
    const request = await createRequest("loan-maker-checker-1");

    await expect(
      reviewEmployeeLoanRequest(maker, {
        id: request.id,
        action: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const approved = await reviewEmployeeLoanRequest(checker, {
      id: request.id,
      action: "APPROVE",
    });
    expect(approved).toEqual({ id: request.id, status: "APPROVED" });

    const [stored] = await db()
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.id, request.id));
    expect(stored).toMatchObject({
      status: "APPROVED",
      createdById: MAKER_ID,
      reviewedById: CHECKER_ID,
    });
    expect(stored?.reviewedAt).toBeInstanceOf(Date);
  });

  it("يعزل الطلب والمراجعة والإلغاء والصرف عن مدير فرع آخر", async () => {
    const request = await createRequest("loan-branch-isolation-1");

    await expect(
      createRequest(
        "loan-branch-isolation-foreign-create",
        EMPLOYEE_A,
        foreignManager,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      reviewEmployeeLoanRequest(foreignManager, {
        id: request.id,
        action: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      cancelEmployeeLoanRequest(foreignManager, { id: request.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      disburseEmployeeLoan(foreignManager, request.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const requests = await db().select().from(s.employeeLoanRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: request.id,
      branchId: 1,
      status: "PENDING",
    });
    expect(await financialSnapshot()).toEqual({
      receipts: 0,
      accountingEntries: 0,
      employeeAdvances: 0,
      idempotencyKeys: 0,
      journalEntries: 0,
      journalLines: 0,
    });
  });

  it("يمنع اعتماد طلب شهر منته وصرف طلب معتمد منه بلا أثر مالي", async () => {
    const period = previousPeriod(baghdadToday().slice(0, 7));
    const database = db();
    const [pending] = await database.insert(s.employeeLoanRequests).values({
      employeeId: EMPLOYEE_A,
      branchId: 1,
      amount: "1000.00",
      installmentsCount: 1,
      monthlyDeduction: "1000.00",
      payrollPeriod: period,
      clientRequestId: "loan-expired-pending-1",
      status: "PENDING",
      createdById: MAKER_ID,
    });
    const [approved] = await database.insert(s.employeeLoanRequests).values({
      employeeId: EMPLOYEE_B,
      branchId: 1,
      amount: "1000.00",
      installmentsCount: 1,
      monthlyDeduction: "1000.00",
      payrollPeriod: period,
      clientRequestId: "loan-expired-approved-1",
      status: "APPROVED",
      createdById: MAKER_ID,
      reviewedById: CHECKER_ID,
      reviewedAt: new Date(),
    });

    await expect(
      reviewEmployeeLoanRequest(checker, {
        id: pending.insertId,
        action: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      disburseEmployeeLoan(checker, approved.insertId),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const rows = await database.select().from(s.employeeLoanRequests);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.insertId, status: "PENDING" }),
        expect.objectContaining({ id: approved.insertId, status: "APPROVED" }),
      ]),
    );
    expect(await financialSnapshot()).toEqual({
      receipts: 0,
      accountingEntries: 0,
      employeeAdvances: 0,
      idempotencyKeys: 0,
      journalEntries: 0,
      journalLines: 0,
    });
  });

  it("يلغي الطلبين المعلق والمعتمد بلا إيصال أو قيد أو سلفة فعالة", async () => {
    const pending = await createRequest("loan-cancel-pending-1", EMPLOYEE_A);
    const approvedRequest = await createRequest(
      "loan-cancel-approved-1",
      EMPLOYEE_B,
    );
    await reviewEmployeeLoanRequest(checker, {
      id: approvedRequest.id,
      action: "APPROVE",
    });
    const before = await financialSnapshot();

    const pendingCancellation = await cancelEmployeeLoanRequest(maker, {
      id: pending.id,
      reason: "تراجع مقدم الطلب",
    });
    const approvedCancellation = await cancelEmployeeLoanRequest(checker, {
      id: approvedRequest.id,
      reason: "أُلغي قبل الصرف",
    });
    const replay = await cancelEmployeeLoanRequest(checker, {
      id: approvedRequest.id,
      reason: "إعادة إرسال الإلغاء",
    });

    expect(pendingCancellation).toEqual({
      id: pending.id,
      status: "CANCELLED",
      replayed: false,
    });
    expect(approvedCancellation).toEqual({
      id: approvedRequest.id,
      status: "CANCELLED",
      replayed: false,
    });
    expect(replay).toEqual({
      id: approvedRequest.id,
      status: "CANCELLED",
      replayed: true,
    });

    const rows = await db().select().from(s.employeeLoanRequests);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pending.id,
          status: "CANCELLED",
          rejectionReason: "تراجع مقدم الطلب",
          advanceId: null,
          receiptId: null,
          disbursedById: null,
        }),
        expect.objectContaining({
          id: approvedRequest.id,
          status: "CANCELLED",
          rejectionReason: "أُلغي قبل الصرف",
          advanceId: null,
          receiptId: null,
          disbursedById: null,
        }),
      ]),
    );
    expect(await financialSnapshot()).toEqual(before);
    expect(before).toEqual({
      receipts: 0,
      accountingEntries: 0,
      employeeAdvances: 0,
      idempotencyKeys: 0,
      journalEntries: 0,
      journalLines: 0,
    });
  });
});
