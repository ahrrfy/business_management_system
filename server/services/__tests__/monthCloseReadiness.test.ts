/**
 * الشريحة ٥ من خطة الدفتر المزدوج (docs/double-entry-p2-plan-2026-08-11.md):
 * بوّابة الإقفال الشهري — تحويل حزمة الإقفال القارئة إلى بوّابةٍ تُقفِل.
 *
 * تصنيف المالك (١١/٨) هو العقد المُختبَر هنا:
 *   🔴 يحجب: وردياتٌ مفتوحة · سنداتٌ بانتظار الاعتماد.
 *   🟡 تنبيهٌ فقط: جلسات جردٍ نشطة · طلبات تسوية مخزونٍ معلّقة · فجوات الدفتر المزدوج.
 * أيّ اختبارٍ هنا يفشل = خرقٌ لقرار المالك لا مجرّد انحدارٍ تقنيّ.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  baghdadMonthUpperExclusive,
  getMonthCloseReadiness,
} from "../reports/monthCloseReadiness";
import {
  buildDailyCashEvidenceTx,
  closeDailyCashReconciliation,
} from "../cashDailyReconciliationService";
import { truncateTables } from "./__testUtils__";

const MONTH = "2026-07"; // شهرٌ منقضٍ: من 2026-07-01 إلى 2026-07-31

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  await truncateTables([
    "auditLogs",
    "cashVarianceCaseEvents",
    "cashVarianceCases",
    "cashDailyReconciliations",
    "employeeAdvanceRepaymentAllocations",
    "employeeAdvanceRepaymentRequests",
    "employeeTerminations",
    "commissionRunLines",
    "commissionRuns",
    "commissionPlans",
    "payrollAccountingEvents",
    "payrollObligationAllocations",
    "payrollObligations",
    "payrollRemittanceRequests",
    "payrollItems",
    "payrollRuns",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "cashCustodyCounts",
    "stockAdjustmentRequests",
    "stocktakeSessions",
    "receipts",
    "shifts",
    "employees",
    "productVariants",
    "products",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.users).values({
    id: 1,
    openId: "t",
    name: "مدير",
    role: "manager",
    loginMethod: "local",
  });
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  // متغيّرٌ حقيقيّ: طلب تسوية المخزون يشير إليه بمفتاحٍ أجنبيّ.
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
}

/** بندٌ بمفتاحه من النتيجة. */
async function item(key: string, branchId: number | null = 1) {
  const res = await getMonthCloseReadiness({ month: MONTH, branchId });
  const found = res.items.find((i) => i.key === key);
  if (!found) throw new Error(`بندٌ مفقود في نتيجة الجاهزية: ${key}`);
  return { item: found, blocked: res.blocked };
}

async function seedOpenShift(branchId: number, openedAt: Date) {
  await db()
    .insert(s.shifts)
    .values({
      userId: 1,
      branchId,
      status: "OPEN",
      openedAt,
      openGuard: `1:${branchId}:${openedAt.getTime()}`,
      openingBalance: "0",
    });
}

async function seedPendingVoucher(branchId: number, voucherDate: string) {
  await db()
    .insert(s.receipts)
    .values({
      branchId,
      direction: "OUT",
      amount: "100.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      createdBy: 1,
      voucherNumber: `V-${branchId}-${voucherDate}`,
      voucherDate,
      approvalStatus: "PENDING_APPROVAL",
    });
}

beforeEach(reset);

describe("getMonthCloseReadiness — بوّابة الإقفال الشهري (ش٥)", () => {
  it("١) شهرٌ نظيف ⇒ كل البنود OK ولا حجب", async () => {
    const res = await getMonthCloseReadiness({ month: MONTH, branchId: 1 });
    expect(res.month).toBe(MONTH);
    expect(res.blocked).toBe(false);
    expect(res.items.every((i) => i.status === "OK")).toBe(true);
    expect(res.items.map((i) => i.key).sort()).toEqual([
      "ACCRUED_SETTLEMENT_PENDING",
      "activeStocktakes",
      "ledgerGaps",
      "openShifts",
      "payrollAccrual",
      "pendingAdvanceRepayments",
      "pendingCashCustody",
      "pendingStockAdjustments",
      "pendingVouchers",
      "unclosedDailyCashReconciliations",
    ]);
  });

  it("٢) وردية مفتوحة ⇒ حجب (قرار المالك)", async () => {
    await seedOpenShift(1, new Date("2026-07-15T10:00:00Z"));
    const { item: it_, blocked } = await item("openShifts");
    expect(it_.status).toBe("BLOCK");
    expect(it_.count).toBe(1);
    expect(blocked).toBe(true);
  });

  it("عهدة نقد خرجت من الدرج ولم يقبلها المستلم ⇒ تحجب الإقفال الشهري", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "250000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "PENDING",
      approvalStatus: "APPROVED",
      referenceNumber: "CH-20260731-0001",
      createdBy: 1,
      createdAt: new Date("2026-07-31T18:00:00Z"),
    });

    const custody = await item("pendingCashCustody");
    expect(custody.item.status).toBe("BLOCK");
    expect(custody.item.count).toBe(1);
    expect(custody.blocked).toBe(true);
  });

  it("مطابقة نقد يومية بفرق مفتوح ⇒ تحجب الإقفال الشهري", async () => {
    await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: "2026-07-20",
      expectedTreasuryCash: "100000.00",
      countedTreasuryCash: "99000.00",
      variance: "-1000.00",
      status: "VARIANCE_OPEN",
      lastClientRequestId: "month-open-daily-cash",
      evidenceHash: "a".repeat(64),
      countedByUserId: 1,
    });

    const daily = await item("unclosedDailyCashReconciliations");
    expect(daily.item.status).toBe("BLOCK");
    expect(daily.item.count).toBe(1);
    expect(daily.blocked).toBe(true);
  });

  it("مطابقة نقد يومية MATCHED غير مغلقة ⇒ تحجب الإقفال الشهري", async () => {
    await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: "2026-07-19",
      expectedTreasuryCash: "0.00",
      countedTreasuryCash: "0.00",
      variance: "0.00",
      status: "MATCHED",
      lastClientRequestId: "month-matched-not-closed",
      evidenceHash: "e".repeat(64),
      countedByUserId: 1,
    });

    const daily = await item("unclosedDailyCashReconciliations");
    expect(daily.item).toMatchObject({ status: "BLOCK", count: 1 });
    expect(daily.blocked).toBe(true);
  });

  it("المطابقة المحسومة بسند تصحيح تبقى حاجزاً حتى closeDaily ثم تزول بوابة النقد", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "MONTH-RESOLVED-SOURCE",
      createdBy: 1,
      approvedBy: 1,
      createdAt: new Date("2026-07-31T08:00:00.000Z"),
      approvedAt: new Date("2026-07-31T08:00:00.000Z"),
    });
    const evidence = await db().transaction((tx) =>
      buildDailyCashEvidenceTx(tx, 1, "2026-07-31"),
    );
    const dailyId = extractInsertId(await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: "2026-07-31",
      expectedTreasuryCash: "100000.00",
      countedTreasuryCash: "99000.00",
      variance: "-1000.00",
      status: "RESOLVED_WITH_ADJUSTMENT",
      version: 2,
      lastClientRequestId: "month-resolved-count",
      evidenceHash: evidence.evidenceHash,
      countedByUserId: 1,
    }));
    const caseId = extractInsertId(await db().insert(s.cashVarianceCases).values({
      branchId: 1,
      sourceType: "DAILY_TREASURY",
      dailyReconciliationId: dailyId,
      sourceVersion: 1,
      sourceReference: "DAILY:2026-07-31",
      sourceEvidenceHash: evidence.evidenceHash,
      expectedAmount: "100000.00",
      actualAmount: "99000.00",
      variance: "-1000.00",
      reasonCode: "COUNT_ERROR",
      reason: "عجز خزينة يومي مثبت ومعتمد بسند تصحيح",
      evidenceReference: "evidence://month-close/resolved-daily",
      responsibleUserId: null,
      responsibleEmployeeId: null,
      responsibleNameSnapshot: null,
      countedByUserId: 1,
      proposedByUserId: 1,
      proposalClientRequestId: "month-resolved-proposal",
      proposalRequestHash: "b".repeat(64),
    }));
    const adjustmentReceiptId = extractInsertId(await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "1000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: `CV-${caseId}`,
      createdBy: 1,
      approvedBy: 1,
      createdAt: new Date("2026-08-31T08:00:00.000Z"),
      approvedAt: new Date("2026-08-31T08:00:00.000Z"),
    }));
    const accountingEntryId = extractInsertId(await db().insert(s.accountingEntries).values({
      entryType: "ADJUST",
      postingProfile: "CASH_DAILY_SHORTAGE",
      branchId: 1,
      receiptId: adjustmentReceiptId,
      amount: "1000.00",
      entryDate: new Date("2026-08-31T00:00:00.000Z"),
      dedupeKey: `CASH_VARIANCE:${caseId}`,
      createdBy: 1,
    }));
    await db().insert(s.cashVarianceCaseEvents).values({
      caseId,
      version: 1,
      eventType: "PROPOSED",
      clientRequestId: "month-resolved-proposal-event",
      requestHash: "c".repeat(64),
      actorUserId: 1,
    });
    await db().insert(s.cashVarianceCaseEvents).values({
      caseId,
      version: 2,
      eventType: "APPROVED",
      clientRequestId: "month-resolved-approval",
      requestHash: "d".repeat(64),
      actorUserId: 1,
      counterAccountRole: "LOSSES",
      resolvedVariance: "-1000.00",
      adjustmentReceiptId,
      accountingEntryId,
    });

    const beforeClose = await item("unclosedDailyCashReconciliations");
    expect(beforeClose.item).toMatchObject({ status: "BLOCK", count: 1 });
    expect(beforeClose.blocked).toBe(true);

    await db().insert(s.users).values({
      id: 2,
      openId: "month-close-independent-reviewer",
      name: "مراجع إقفال مستقل",
      role: "manager",
      loginMethod: "local",
    });
    await closeDailyCashReconciliation(
      { reconciliationId: dailyId, expectedVersion: 2, clientRequestId: "month-resolved-close" },
      { userId: 2, branchId: 1, role: "manager" },
      { user: { id: 2, branchId: 1, role: "manager", name: "مراجع إقفال مستقل" }, req: { headers: {} } } as never,
    );
    const afterClose = await item("unclosedDailyCashReconciliations");
    expect(afterClose.item).toMatchObject({ status: "OK", count: 0 });
    expect(afterClose.blocked).toBe(false);
  });

  it("يوم نشاط نقدي بلا شهادة مطابقة ⇒ يحجب الإقفال الشهري", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "50000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "MONTH-DAY-WITHOUT-RECONCILIATION",
      createdBy: 1,
      createdAt: new Date("2026-07-31T10:00:00Z"),
    });

    const daily = await item("unclosedDailyCashReconciliations");
    expect(daily.item.status).toBe("BLOCK");
    expect(daily.item.count).toBe(1);
    expect(daily.item.detail).toContain("1 بلا جرد");
    expect(daily.blocked).toBe(true);
  });

  it("رصيد خزينة مرحّل يوجب شهادة لكل يوم لاحق ولو لم توجد حركة جديدة", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "50000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "MONTH-CARRIED-CASH-WITHOUT-DAILY-COUNTS",
      createdBy: 1,
      createdAt: new Date("2026-07-20T10:00:00Z"),
    });

    const daily = await item("unclosedDailyCashReconciliations");
    expect(daily.item).toMatchObject({ status: "BLOCK", count: 12 });
    expect(daily.item.detail).toContain("12 بلا جرد");
    expect(daily.blocked).toBe(true);
  });

  it("اعتماد نقدي متأخر عند حد الشهر يُنسب إلى شهر الاعتماد لا شهر الإنشاء", async () => {
    await db().insert(s.users).values({
      id: 2,
      openId: "month-close-approver",
      name: "معتمد ثانٍ",
      role: "manager",
      loginMethod: "local",
    });
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "IN",
        amount: "50000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "MONTH-DELAYED-APPROVAL",
        createdBy: 1,
        approvedBy: 2,
        createdAt: new Date("2026-07-31T23:30:00.000Z"),
        approvedAt: new Date("2026-08-01T00:30:00.000Z"),
      });
    // تصفير الرصيد في يوم الاعتماد يعزل هذا الاختبار على نسبة الحدّ الشهري:
    // يبقى 1 آب يوم نشاط مطلوباً، ولا تنشأ 30 شهادة إضافية لرصيد مرحّل.
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "50000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "MONTH-DELAYED-APPROVAL-OFFSET",
      createdBy: 1,
      approvedBy: 2,
      createdAt: new Date("2026-08-01T01:00:00.000Z"),
      approvedAt: new Date("2026-08-01T01:00:00.000Z"),
    });

    const july = await getMonthCloseReadiness({
      month: "2026-07",
      branchId: 1,
    });
    const august = await getMonthCloseReadiness({
      month: "2026-08",
      branchId: 1,
    });
    const julyDaily = july.items.find(
      (entry) => entry.key === "unclosedDailyCashReconciliations",
    );
    const augustDaily = august.items.find(
      (entry) => entry.key === "unclosedDailyCashReconciliations",
    );

    expect(julyDaily?.count).toBe(0);
    expect(augustDaily?.count).toBe(1);
    expect(augustDaily?.detail).toContain("1 بلا جرد");
    expect(august.blocked).toBe(true);
  });

  it("٣) سندٌ بانتظار الاعتماد مؤرَّخٌ في الشهر ⇒ حجب (قرار المالك)", async () => {
    await seedPendingVoucher(1, "2026-07-20");
    const { item: it_, blocked } = await item("pendingVouchers");
    expect(it_.status).toBe("BLOCK");
    expect(blocked).toBe(true);
  });

  it("٤) سندٌ معلَّقٌ **قبل** الشهر يحجب أيضاً — اعتمادُه لاحقاً يكتب في فترةٍ ستُقفَل", async () => {
    await seedPendingVoucher(1, "2026-06-10");
    const { item: it_ } = await item("pendingVouchers");
    expect(it_.status).toBe("BLOCK");
  });

  it("٥) سندٌ معلَّقٌ **بعد** الشهر لا يحجب — فترتُه تبقى مفتوحة", async () => {
    await seedPendingVoucher(1, "2026-08-05");
    const { item: it_, blocked } = await item("pendingVouchers");
    expect(it_.status).toBe("OK");
    expect(blocked).toBe(false);
  });

  it("يحجب طلب سداد/إعادة سلفة معلّقاً بتاريخ الحركة، ويزول الحاجز بعد حسمه", async () => {
    await db().insert(s.employees).values({
      id: 40,
      branchId: 1,
      firstName: "موظف",
      lastName: "سلفة",
      employmentStatus: "active",
      isActive: true,
    });
    await db().insert(s.employeeAdvanceRepaymentRequests).values({
      id: 40,
      requestKind: "REPAYMENT",
      status: "PENDING",
      employeeId: 40,
      branchId: 1,
      originalRequestId: null,
      amount: "100.00",
      paymentMethod: "TRANSFER",
      referenceNumber: "ADV-CLOSE-40",
      transactionDate: new Date("2026-07-31T00:00:00.000Z"),
      evidenceNote: "دليل تحويل سداد سلفة قبل إقفال الشهر",
      clientRequestId: "adv-close-40",
      sourceKey: "ADVREP:REPAYMENT:adv-close-40",
      sourceHash: "4".repeat(64),
      evidenceHash: "5".repeat(64),
      createdBy: 1,
    });
    const pending = await item("pendingAdvanceRepayments");
    expect(pending.item).toMatchObject({ status: "BLOCK", count: 1 });
    expect(pending.blocked).toBe(true);

    await db().update(s.employeeAdvanceRepaymentRequests).set({
      status: "REJECTED",
      reviewedBy: 1,
      reviewedAt: new Date("2026-07-31T12:00:00.000Z"),
      rejectionReason: "رُفض بعد المراجعة",
    }).where(eq(s.employeeAdvanceRepaymentRequests.id, 40));
    expect((await item("pendingAdvanceRepayments")).item.status).toBe("OK");

    await db().insert(s.employeeAdvanceRepaymentRequests).values({
      id: 41,
      requestKind: "REPAYMENT",
      status: "PENDING",
      employeeId: 40,
      branchId: 1,
      originalRequestId: null,
      amount: "50.00",
      paymentMethod: "TRANSFER",
      referenceNumber: "ADV-CLOSE-41",
      transactionDate: new Date("2026-08-01T00:00:00.000Z"),
      evidenceNote: "دليل تحويل سداد سلفة للشهر التالي",
      clientRequestId: "adv-close-41",
      sourceKey: "ADVREP:REPAYMENT:adv-close-41",
      sourceHash: "6".repeat(64),
      evidenceHash: "7".repeat(64),
      createdBy: 1,
    });
    expect((await item("pendingAdvanceRepayments")).item.status).toBe("OK");
  });

  it("٦) عزل الفرع: وردية مفتوحة في فرعٍ آخر لا تحجب إقفال فرعي", async () => {
    await seedOpenShift(2, new Date("2026-07-15T10:00:00Z"));
    expect((await item("openShifts", 1)).blocked).toBe(false);
    expect((await item("openShifts", 2)).blocked).toBe(true);
    // وبلا تحديد فرع (كل الفروع) تظهر.
    expect((await item("openShifts", null)).item.status).toBe("BLOCK");
  });

  it("٧) جلسة جردٍ نشطة ⇒ تنبيهٌ فقط، لا حجب (قرار المالك)", async () => {
    await db().insert(s.stocktakeSessions).values({
      code: "ST-001",
      name: "جرد تجريبي",
      branchId: 1,
      scopeType: "FULL",
      sessionType: "NORMAL",
      status: "COUNTING",
      createdBy: 1,
    });
    const { item: it_, blocked } = await item("activeStocktakes");
    expect(it_.status).toBe("WARN");
    expect(it_.count).toBe(1);
    expect(blocked).toBe(false);
  });

  it("٨) طلب تسوية مخزونٍ معلَّق ⇒ تنبيهٌ فقط، لا حجب", async () => {
    await db().insert(s.stockAdjustmentRequests).values({
      branchId: 1,
      variantId: 1,
      targetQuantity: 5,
      expectedQuantity: 3,
      status: "PENDING_APPROVAL",
      createdBy: 1,
    });
    const { item: it_, blocked } = await item("pendingStockAdjustments");
    expect(it_.status).toBe("WARN");
    expect(blocked).toBe(false);
  });

  it("٩) فجوة دفترٍ مزدوج في الشهر ⇒ تنبيهٌ فقط، لا حجب", async () => {
    const er = await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "GIFT_OUT",
        branchId: 1,
        amount: "0.00",
        entryDate: new Date("2026-07-09"),
      });
    await db()
      .insert(s.journalEntries)
      .values({
        entryId: extractInsertId(er),
        entryDate: new Date("2026-07-09"),
        branchId: 1,
        status: "UNMAPPED",
        unmappedReason: "نوعُ قيدٍ غير مُخطَّط بعد: GIFT_OUT",
      });
    const { item: it_, blocked } = await item("ledgerGaps");
    expect(it_.status).toBe("WARN");
    expect(it_.count).toBe(1);
    expect(blocked).toBe(false);
  });

  it("١٠) حاجزٌ واحدٌ يكفي للحجز ولو كان الباقي سليماً", async () => {
    await seedOpenShift(1, new Date("2026-07-15T10:00:00Z"));
    const res = await getMonthCloseReadiness({ month: MONTH, branchId: 1 });
    expect(res.blocked).toBe(true);
    expect(res.items.filter((i) => i.status === "BLOCK").length).toBeGreaterThanOrEqual(1);
    expect(res.items.find((i) => i.key === "openShifts")?.status).toBe("BLOCK");
    expect(res.items.find((i) => i.key === "pendingVouchers")?.status).toBe(
      "OK",
    );
  });

  it("١١) منتصف ليل بغداد هو الحد الحصري للوردية لا منتصف ليل UTC", async () => {
    expect(baghdadMonthUpperExclusive("2026-07-31").toISOString()).toBe(
      "2026-07-31T21:00:00.000Z",
    );
    await seedOpenShift(1, new Date("2026-07-31T20:59:59.000Z"));
    await seedOpenShift(2, new Date("2026-07-31T21:00:00.000Z"));
    const all = await item("openShifts", null);
    expect(all.item.count).toBe(1);
    expect(all.blocked).toBe(true);
  });

  it("١٢) وجود موظف مستحق بلا مسيّر أو بمسيّر مسودة يحجب الشركة كلها", async () => {
    await db().insert(s.employees).values({
      id: 10,
      branchId: 2,
      firstName: "موظف",
      lastName: "اختبار",
      employmentStatus: "active",
      isActive: true,
      hireDate: "2026-01-01",
    });
    expect((await item("payrollAccrual", 1)).item.status).toBe("BLOCK");
    await db().insert(s.payrollRuns).values({
      id: 10,
      period: MONTH,
      status: "draft",
      employeeCount: 1,
      totalNet: "0",
    });
    const draft = await item("payrollAccrual", 1);
    expect(draft.item.status).toBe("BLOCK");
    expect(draft.item.detail).toContain("مسوّدة");
  });

  it.each(["approved", "paid"] as const)(
    "١٣) مسيّر %s بصافي صفر واستحقاق صحيح لا يحجب",
    async (status) => {
      await db().insert(s.employees).values({
        id: 11,
        branchId: 2,
        firstName: "موظف",
        lastName: "صفري",
        employmentStatus: "active",
        isActive: true,
        hireDate: "2026-07-01",
      });
      const runId = status === "approved" ? 11 : 12;
      await db()
        .insert(s.payrollRuns)
        .values({
          id: runId,
          period: MONTH,
          status,
          employeeCount: 1,
          totalGross: "0",
          totalNet: "0",
          accrualDate: "2026-07-31",
          revisionNo: 0,
          legalPolicyHash: "a".repeat(64),
          approvalSnapshotHash: "b".repeat(64),
        });
      await db()
        .insert(s.payrollItems)
        .values({
          runId,
          employeeId: 11,
          revisionNo: 0,
          payType: "monthly",
          snapshotHash: "c".repeat(64),
        });
      const payroll = await item("payrollAccrual", 1);
      expect(payroll.item.status).toBe("OK");
      expect(payroll.blocked).toBe(false);
    },
  );

  it("١٤) اعتماد بحقل استحقاق منحرف لا يفتح بوابة الإقفال", async () => {
    await db().insert(s.employees).values({
      id: 12,
      branchId: 1,
      firstName: "موظف",
      lastName: "منحرف",
      employmentStatus: "active",
      isActive: true,
      hireDate: "2026-01-01",
    });
    await db().insert(s.payrollRuns).values({
      id: 13,
      period: MONTH,
      status: "approved",
      employeeCount: 1,
      totalNet: "0",
      accrualDate: "2026-07-30",
    });
    const payroll = await item("payrollAccrual");
    expect(payroll.item.status).toBe("BLOCK");
    expect(payroll.item.detail).toContain("2026-07-31");
  });

  it("١٥) موظف مستحق أُضيف بعد اعتماد اللقطة يعيد حجب الإقفال حتى إعادة التوليد", async () => {
    await db().insert(s.employees).values({
      id: 20,
      branchId: 1,
      firstName: "الموظف",
      lastName: "الأول",
      employmentStatus: "active",
      isActive: true,
      hireDate: "2026-07-01",
    });
    await db()
      .insert(s.payrollRuns)
      .values({
        id: 20,
        period: MONTH,
        status: "approved",
        employeeCount: 1,
        totalNet: "0",
        accrualDate: "2026-07-31",
        revisionNo: 0,
        legalPolicyHash: "d".repeat(64),
        approvalSnapshotHash: "e".repeat(64),
      });
    await db()
      .insert(s.payrollItems)
      .values({
        runId: 20,
        employeeId: 20,
        revisionNo: 0,
        payType: "monthly",
        snapshotHash: "f".repeat(64),
      });
    expect((await item("payrollAccrual")).item.status).toBe("OK");

    await db().insert(s.employees).values({
      id: 21,
      branchId: 2,
      firstName: "الموظف",
      lastName: "المضاف",
      employmentStatus: "active",
      isActive: true,
      hireDate: "2026-07-15",
    });
    const after = await item("payrollAccrual", 1);
    expect(after.item.status).toBe("BLOCK");
    expect(after.item.detail).toContain("1 غير مشمول");
  });

  it("accepts an approved commission-only employee captured by the payroll snapshot", async () => {
    await db().insert(s.employees).values({
      id: 30,
      branchId: 1,
      firstName: "Commission",
      lastName: "Only",
      employmentStatus: "terminated",
      isActive: false,
      hireDate: "2025-01-01",
      terminationDate: "2026-06-15",
    });
    await db()
      .insert(s.payrollRuns)
      .values({
        id: 30,
        period: MONTH,
        status: "approved",
        employeeCount: 1,
        totalCommission: "100.00",
        totalNet: "100.00",
        accrualDate: "2026-07-31",
        revisionNo: 0,
        legalPolicyHash: "1".repeat(64),
        approvalSnapshotHash: "2".repeat(64),
      });
    await db()
      .insert(s.payrollItems)
      .values({
        runId: 30,
        employeeId: 30,
        revisionNo: 0,
        payType: "monthly",
        commission: "100.00",
        net: "100.00",
        snapshotHash: "3".repeat(64),
      });
    await db()
      .insert(s.commissionPlans)
      .values({ id: 30, name: "Commission close coverage" });
    await db().insert(s.commissionRuns).values({
      id: 30,
      period: MONTH,
      status: "approved",
      employeeCount: 1,
      totalCommission: "100.00",
      payrollRunId: 30,
    });
    await db().insert(s.commissionRunLines).values({
      runId: 30,
      employeeId: 30,
      userId: 1,
      planId: 30,
      commissionAmount: "100.00",
    });

    const payroll = await item("payrollAccrual");
    expect(payroll.item.status).toBe("OK");
    expect(payroll.blocked).toBe(false);
  });

  it("blocks a draft or unlinked commission run even when its amount is zero", async () => {
    await db().insert(s.commissionRuns).values({
      id: 31,
      period: MONTH,
      status: "draft",
      employeeCount: 0,
      totalCommission: "0.00",
    });
    const draft = await item("payrollAccrual");
    expect(draft.item.status).toBe("BLOCK");
    expect(draft.item.count).toBe(1);

    await db().update(s.commissionRuns).set({ status: "approved" });
    const unlinked = await item("payrollAccrual");
    expect(unlinked.item.status).toBe("BLOCK");
  });

  it("treats a sealed zero-value termination as payroll coverage by presence, not amount", async () => {
    await db().insert(s.employees).values({
      id: 32,
      branchId: 1,
      firstName: "Zero",
      lastName: "Termination",
      employmentStatus: "terminated",
      isActive: false,
      hireDate: "2025-01-01",
      terminationDate: "2026-07-15",
    });
    await db()
      .insert(s.employeeTerminations)
      .values({
        id: 32,
        employeeId: 32,
        terminationType: "resignation",
        lastDay: "2026-07-15",
        settlement: "0.00",
        earnedGrossWages: "0.00",
        status: "completed",
        settlementEvidenceNote:
          "All zero settlement components approved by owner",
        zeroAmountsAttested: true,
        settlementSnapshotHash: "8".repeat(64),
        recognizedAt: new Date("2026-07-15T12:00:00.000Z"),
        recognizedBy: 1,
      });

    const payroll = await item("payrollAccrual");
    expect(payroll.item.status).toBe("OK");
    expect(payroll.blocked).toBe(false);
  });

  it("excludes immutable recognized termination wages, but requires them again after recognition reversal", async () => {
    await db()
      .insert(s.employees)
      .values([
        {
          id: 40,
          branchId: 1,
          firstName: "Termination",
          lastName: "Covered",
          employmentStatus: "terminated",
          isActive: false,
          hireDate: "2025-01-01",
          terminationDate: "2026-07-15",
        },
        {
          id: 41,
          branchId: 2,
          firstName: "Payroll",
          lastName: "Expected",
          employmentStatus: "active",
          isActive: true,
          hireDate: "2026-01-01",
        },
      ]);
    await db()
      .insert(s.employeeTerminations)
      .values({
        id: 40,
        employeeId: 40,
        terminationType: "resignation",
        lastDay: "2026-07-15",
        settlement: "500.00",
        earnedGrossWages: "500.00",
        status: "completed",
        settlementEvidenceNote:
          "Approved zero-component evidence for close test",
        zeroAmountsAttested: true,
        settlementSnapshotHash: "7".repeat(64),
        recognizedAt: new Date("2026-07-15T12:00:00.000Z"),
        recognizedBy: 1,
      });
    await db()
      .insert(s.payrollRuns)
      .values({
        id: 40,
        period: MONTH,
        status: "approved",
        employeeCount: 1,
        totalNet: "0",
        accrualDate: "2026-07-31",
        revisionNo: 0,
        legalPolicyHash: "4".repeat(64),
        approvalSnapshotHash: "5".repeat(64),
      });
    await db()
      .insert(s.payrollItems)
      .values({
        runId: 40,
        employeeId: 41,
        revisionNo: 0,
        payType: "monthly",
        snapshotHash: "6".repeat(64),
      });
    expect((await item("payrollAccrual")).item.status).toBe("OK");

    await db()
      .insert(s.commissionPlans)
      .values({ id: 40, name: "Termination commission coverage" });
    await db().insert(s.commissionRuns).values({
      id: 40,
      period: MONTH,
      status: "approved",
      employeeCount: 1,
      totalCommission: "100.00",
      payrollRunId: 40,
    });
    await db().insert(s.commissionRunLines).values({
      runId: 40,
      employeeId: 40,
      userId: 1,
      planId: 40,
      commissionAmount: "100.00",
    });
    expect((await item("payrollAccrual")).item.status).toBe("BLOCK");
    await db().delete(s.commissionRunLines);
    await db().delete(s.commissionRuns);
    await db().delete(s.commissionPlans);

    await db()
      .update(s.employeeTerminations)
      .set({
        recognitionReversedAt: new Date("2026-07-20T12:00:00.000Z"),
        recognitionReversedBy: 1,
        recognitionReversalReason: "Correction after review",
        recognitionReversalEventId: 999,
      });
    const reversed = await item("payrollAccrual");
    expect(reversed.item.status).toBe("BLOCK");
    expect(reversed.item.count).toBe(1);
  });
});
