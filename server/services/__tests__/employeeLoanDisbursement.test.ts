/**
 * اختبارات صرف سلف الموظفين والحوكمة النقدية والمحاسبية الذرية (GAP-02):
 *  1) الصرف مع وردية مفتوحة: ينشئ إيصال صرف نقدي OUT مع ربط shiftId و DRAWER، وينشئ سلفة ACTIVE مع receiptId، ويسجل قيد PAYMENT_OUT.
 *  2) الصرف بدون وردية مفتوحة: ينشئ إيصال صرف نقدي OUT بدلو TREASURY و shiftId = null.
 *  3) سجل السلفة في employeeAdvances يحمل receiptId وحالة ACTIVE والمتبقي يطابق مبلغ السلفة.
 *  4) تسجيل قيد محاسبي PAYMENT_OUT مع receiptId والمبلغ والفرع ورمز عدم التكرار dedupeKey.
 *  5) التراجع الذري الكامل (Atomic Rollback): عند حدوث أي خطأ أثناء الصرف يتراجع كل شيء (لا إيصال، لا سلفة، لا قيد، وبقاء الطلب APPROVED).
 *  6) حظر إعادة صرف سلفة مصروفة مسبقاً (DISBURSED).
 *  7) حظر صرف سلفة غير معتمدة (PENDING / REJECTED / CANCELLED).
 *  8) معالجة عدم وجود طلب السلفة (NOT_FOUND).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { Actor } from "../tx";
import {
  disburseEmployeeLoan,
  disburseLoan,
  requestEmployeeLoan,
  reviewEmployeeLoanRequest,
} from "../employeeLoanService";
import * as ledgerSvc from "../ledgerService";

const TABLES = [
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "receipts",
  "employeeAdvances",
  "employeeLoanRequests",
  "shifts",
  "employees",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function resetDb() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    await d.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const adminActor: Actor = { userId: 1, branchId: 1, role: "admin" };
const cashierActor: Actor = { userId: 2, branchId: 1, role: "cashier" };

async function seedBaseData() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);

  await d.insert(s.users).values([
    { id: 1, openId: "test-loan-admin", name: "أحمد الإداري", role: "admin", branchId: 1 },
    { id: 2, openId: "test-loan-cashier", name: "محمد الكاشير", role: "cashier", branchId: 1 },
  ]);

  await d.insert(s.employees).values([
    {
      id: 10,
      branchId: 1,
      firstName: "علي",
      fatherName: "حسين",
      grandfatherName: "محمد",
      lastName: "الساعدي",
      salary: "1500000.00",
      payType: "monthly",
      employmentStatus: "active",
    },
    {
      id: 11,
      branchId: 1,
      firstName: "زينب",
      fatherName: "كاظم",
      grandfatherName: "جواد",
      lastName: "الشمري",
      salary: "1200000.00",
      payType: "monthly",
      employmentStatus: "active",
    },
  ]);

  // وردية مفتوحة للكاشير (userId: 2) في الفرع 1
  await d.insert(s.shifts).values({
    id: 101,
    branchId: 1,
    userId: 2,
    openingBalance: "1000000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:2:RETAIL",
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await seedBaseData();
});

describe("GAP-02: صرف سلف الموظفين والحوكمة النقدية والمحاسبية الذرية", () => {
  it("الصرف مع وردية مفتوحة: ينشئ إيصال OUT في DRAWER ويربط shiftId والسلفة الفعالة والقيد المحاسبي", async () => {
    const d = db();

    // 1. إنشاء طلب سلفة معتمد
    const [loanReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "300000.00",
      installmentsCount: 6,
      monthlyDeduction: "50000.00",
      reason: "سلفة طارئة للعملية",
      status: "APPROVED",
      createdById: 1,
      reviewedById: 1,
    });
    const loanId = loanReq.insertId;

    // 2. صرف السلفة بواسطة الكاشير (صاحب الوردية المفتوحة 101)
    const res = await disburseEmployeeLoan(cashierActor, loanId);

    expect(res).toEqual({
      id: loanId,
      advanceId: expect.any(Number),
      receiptId: expect.any(Number),
      status: "DISBURSED",
    });

    // 3. التحقق من إيصال الصرف النقدي
    const [receipt] = await d.select().from(s.receipts).where(eq(s.receipts.id, res.receiptId));
    expect(receipt).toBeDefined();
    expect(receipt.branchId).toBe(1);
    expect(receipt.shiftId).toBe(101);
    expect(receipt.cashBucket).toBe("DRAWER");
    expect(receipt.direction).toBe("OUT");
    expect(receipt.amount).toBe("300000.00");
    expect(receipt.paymentMethod).toBe("CASH");
    expect(receipt.referenceNumber).toBe(`EMP-LOAN:${loanId}`);
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.approvalStatus).toBe("APPROVED");
    expect(receipt.partyType).toBe("OTHER");
    expect(receipt.counterpartyName).toBe("علي حسين محمد الساعدي");
    expect(receipt.description).toContain(`صرف سلفة موظف #${loanId}`);

    // 4. التحقق من القيد المحاسبي
    const [entry] = await d
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, res.receiptId));
    expect(entry).toBeDefined();
    expect(entry.entryType).toBe("PAYMENT_OUT");
    expect(entry.branchId).toBe(1);
    expect(entry.amount).toBe("300000.00");
    expect(entry.dedupeKey).toBe(`EMPLOYEE_LOAN_DISBURSEMENT:${loanId}`);
    expect(entry.notes).toContain(`صرف سلفة موظف #${loanId}`);

    // 5. التحقق من سجل السلفة الفعالة في employeeAdvances
    const [advance] = await d
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, res.advanceId));
    expect(advance).toBeDefined();
    expect(advance.employeeId).toBe(10);
    expect(advance.branchId).toBe(1);
    expect(advance.amount).toBe("300000.00");
    expect(advance.remaining).toBe("300000.00");
    expect(advance.monthlyDeduction).toBe("50000.00");
    expect(advance.status).toBe("ACTIVE");
    expect(advance.receiptId).toBe(res.receiptId);

    // 6. التحقق من تحديث طلب السلفة
    const [updatedReq] = await d
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.id, loanId));
    expect(updatedReq.status).toBe("DISBURSED");
    expect(updatedReq.advanceId).toBe(res.advanceId);
  });

  it("الصرف بدون وردية مفتوحة: ينشئ إيصال OUT في TREASURY مع shiftId = null", async () => {
    const d = db();

    // إنشاء طلب سلفة معتمد للموظفة زينب
    const [loanReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 11,
      branchId: 1,
      amount: "200000.00",
      installmentsCount: 4,
      monthlyDeduction: "50000.00",
      reason: "سلفة من الإدارة العامة",
      status: "APPROVED",
      createdById: 1,
      reviewedById: 1,
    });
    const loanId = loanReq.insertId;

    // الصرف بواسطة adminActor (لا يملك أي وردية مفتوحة)
    const res = await disburseEmployeeLoan(adminActor, loanId);

    expect(res.status).toBe("DISBURSED");

    // التحقق من إيصال الصرف النقدي بدلو الخزينة
    const [receipt] = await d.select().from(s.receipts).where(eq(s.receipts.id, res.receiptId));
    expect(receipt).toBeDefined();
    expect(receipt.branchId).toBe(1);
    expect(receipt.shiftId).toBeNull();
    expect(receipt.cashBucket).toBe("TREASURY");
    expect(receipt.direction).toBe("OUT");
    expect(receipt.amount).toBe("200000.00");
    expect(receipt.paymentMethod).toBe("CASH");
    expect(receipt.referenceNumber).toBe(`EMP-LOAN:${loanId}`);
    expect(receipt.counterpartyName).toBe("زينب كاظم جواد الشمري");
  });

  it("الاسم المستعار disburseLoan يعمل بشكل مطابق لـ disburseEmployeeLoan", async () => {
    const d = db();

    const [loanReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "100000.00",
      installmentsCount: 2,
      monthlyDeduction: "50000.00",
      status: "APPROVED",
      createdById: 1,
    });
    const loanId = loanReq.insertId;

    const res = await disburseLoan(cashierActor, loanId);
    expect(res.status).toBe("DISBURSED");
    expect(res.advanceId).toBeGreaterThan(0);
    expect(res.receiptId).toBeGreaterThan(0);
  });

  it("التراجع الذري (Atomic Rollback): فشل القيد المحاسبي يلغي الإيصال والسلفة ويبقي الطلب معتمداً", async () => {
    const d = db();

    const [loanReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "450000.00",
      installmentsCount: 9,
      monthlyDeduction: "50000.00",
      status: "APPROVED",
      createdById: 1,
    });
    const loanId = loanReq.insertId;

    // محاكاة عطل فادح أثناء تسجيل القيد المحاسبي
    vi.spyOn(ledgerSvc, "postEntry").mockRejectedValueOnce(
      new Error("خطأ اتصال مفاجئ في دفتر اليومية المزدوج"),
    );

    // التحقق من رمي الخطأ
    await expect(disburseEmployeeLoan(cashierActor, loanId)).rejects.toThrow(
      "خطأ اتصال مفاجئ في دفتر اليومية المزدوج",
    );

    // التحقق من التراجع التام (Atomic Rollback):
    // 1. لا إيصال مالي تم إنشاؤه
    const receiptsList = await d
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `EMP-LOAN:${loanId}`));
    expect(receiptsList).toHaveLength(0);

    // 2. لا قيد محاسبي تم تسجيله
    const entriesList = await d
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `EMPLOYEE_LOAN_DISBURSEMENT:${loanId}`));
    expect(entriesList).toHaveLength(0);

    // 3. لا سلفة فعالة تم إدراجها للموظف عن هذا الطلب
    const advancesList = await d
      .select()
      .from(s.employeeAdvances)
      .where(and(eq(s.employeeAdvances.employeeId, 10), eq(s.employeeAdvances.amount, "450000.00")));
    expect(advancesList).toHaveLength(0);

    // 4. بقاء طلب السلفة بحالة APPROVED مع advanceId فارغ (لم يتشوه)
    const [loanAfter] = await d
      .select()
      .from(s.employeeLoanRequests)
      .where(eq(s.employeeLoanRequests.id, loanId));
    expect(loanAfter.status).toBe("APPROVED");
    expect(loanAfter.advanceId).toBeNull();
  });

  it("حظر الصرف المتكرر: محاولة إعادة صرف سلفة مصروفة مسبقاً تُرفض مع الحفاظ على البيانات", async () => {
    const d = db();

    const [loanReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "150000.00",
      installmentsCount: 3,
      monthlyDeduction: "50000.00",
      status: "APPROVED",
      createdById: 1,
    });
    const loanId = loanReq.insertId;

    // الصرف الأول ينجح
    const firstRes = await disburseEmployeeLoan(cashierActor, loanId);
    expect(firstRes.status).toBe("DISBURSED");

    // محاولة الصرف الثانية تُرفض
    await expect(disburseEmployeeLoan(cashierActor, loanId)).rejects.toThrow(
      /تم صرف طلب السلفة مسبقاً/,
    );
  });

  it("حظر صرف سلفة غير معتمدة: رفض حالات PENDING و REJECTED و CANCELLED", async () => {
    const d = db();

    // 1. حالة PENDING
    const [pendingReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "100000.00",
      monthlyDeduction: "50000.00",
      status: "PENDING",
      createdById: 1,
    });
    await expect(disburseEmployeeLoan(cashierActor, pendingReq.insertId)).rejects.toThrow(
      /حالة السلفة الحالية هي \(PENDING\) ولم تعتمدها الإدارة بعد/,
    );

    // 2. حالة REJECTED
    const [rejectedReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "100000.00",
      monthlyDeduction: "50000.00",
      status: "REJECTED",
      createdById: 1,
    });
    await expect(disburseEmployeeLoan(cashierActor, rejectedReq.insertId)).rejects.toThrow(
      /حالة السلفة الحالية هي \(REJECTED\) ولم تعتمدها الإدارة بعد/,
    );

    // 3. حالة CANCELLED
    const [cancelledReq] = await d.insert(s.employeeLoanRequests).values({
      employeeId: 10,
      branchId: 1,
      amount: "100000.00",
      monthlyDeduction: "50000.00",
      status: "CANCELLED",
      createdById: 1,
    });
    await expect(disburseEmployeeLoan(cashierActor, cancelledReq.insertId)).rejects.toThrow(
      /حالة السلفة الحالية هي \(CANCELLED\) ولم تعتمدها الإدارة بعد/,
    );
  });

  it("رفض صرف طلب سلفة غير موجود بالمعرّف المحدد", async () => {
    await expect(disburseEmployeeLoan(cashierActor, 999999)).rejects.toThrow(
      /طلب السلفة المطلوب غير موجود في النظام/,
    );
  });

  it("دورة الحياة المتكاملة: من تقديم الطلب إلى الاعتماد ثم الصرف النقدي", async () => {
    const d = db();

    // 1. تقديم الطلب بواسطة الموظف
    const requestRes = await requestEmployeeLoan(cashierActor, {
      employeeId: 10,
      amount: "240000.00",
      installmentsCount: 4,
      monthlyDeduction: "60000.00",
      reason: "شراء قرطاسية ومستلزمات دراسية",
    });
    expect(requestRes.status).toBe("PENDING");

    // 2. اعتماد الطلب من قبل الإدارة
    const reviewRes = await reviewEmployeeLoanRequest(adminActor, {
      id: requestRes.id,
      action: "APPROVE",
    });
    expect(reviewRes.status).toBe("APPROVED");

    // 3. الصرف النقدي عبر الكاشير بالوردية
    const disburseRes = await disburseEmployeeLoan(cashierActor, requestRes.id);
    expect(disburseRes.status).toBe("DISBURSED");

    // 4. التأكد من انعكاس السلفة في employeeAdvances بالكامل
    const [adv] = await d
      .select()
      .from(s.employeeAdvances)
      .where(eq(s.employeeAdvances.id, disburseRes.advanceId));
    expect(adv.amount).toBe("240000.00");
    expect(adv.remaining).toBe("240000.00");
    expect(adv.monthlyDeduction).toBe("60000.00");
    expect(adv.status).toBe("ACTIVE");
    expect(adv.receiptId).toBe(disburseRes.receiptId);
  });
});
