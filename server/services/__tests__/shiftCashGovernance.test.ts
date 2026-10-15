import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountingEntries,
  branches,
  doubleEntrySettings,
  receipts,
  shifts,
  users,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { buildDailyCashEvidenceTx } from "../cashDailyReconciliationService";
import { todayUtcDate } from "../businessDay";

const CASHIER = { userId: 10, branchId: 1, role: "cashier" };
const MANAGER = { userId: 20, branchId: 1, role: "manager" };
const UTC_DAY_BOUNDARIES = [
  ["2026-10-12T20:59:59.000Z", "2026-10-12"],
  ["2026-10-12T21:00:00.000Z", "2026-10-12"],
  ["2026-10-12T23:59:59.000Z", "2026-10-12"],
  ["2026-10-13T00:00:00.000Z", "2026-10-13"],
] as const;

afterEach(() => {
  vi.useRealTimers();
});

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL missing");
  return value;
}

beforeEach(async () => {
  const database = db();
  await ensureFinancialPostingGate(database);
  await database.insert(doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "shift-cash-gov-test",
  });
  await database.insert(branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await database.insert(users).values([
    { id: CASHIER.userId, openId: "cash-governance-cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER.userId, openId: "cash-governance-manager", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await database.insert(receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "1000000.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-SHIFT-CASH-GOVERNANCE",
    createdBy: MANAGER.userId,
  });
});

async function openZeroShift() {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, CASHIER);
}

async function row(id: number) {
  return (await db().select().from(shifts).where(eq(shifts.id, id)).limit(1))[0];
}

describe.sequential("حوكمة فروقات درج النقد", () => {
  it("يمنع سيناريو 750,000 بلا دليل عدّ ولا مصدر ويبقي الوردية مفتوحة", async () => {
    const shift = await openZeroShift();

    await expect(
      closeShift({ shiftId: shift.shiftId, countedCash: "750000", enforceCashGovernance: true }, CASHIER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await row(shift.shiftId)).status).toBe("OPEN");
  });

  it("يمنع الكاشير من اعتماد فرق 750,000 حتى مع العد والتفسير", async () => {
    const shift = await openZeroShift();

    await expect(
      closeShift({
        shiftId: shift.shiftId,
        countedCash: "750000",
        countedBreakdown: { "50000": 15 },
        varianceReasonCode: "UNRECORDED_CASH_IN",
        varianceReason: "مبلغ موجود في الدرج بلا سند مسجّل ويحتاج تحقيقاً",
        enforceCashGovernance: true,
      }, CASHIER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await row(shift.shiftId)).status).toBe("OPEN");
  });

  it("لا يسمح حتى للمدير بإغلاق مال بلا مصدر مسجل", async () => {
    const shift = await openZeroShift();
    await expect(
      closeShift({
        shiftId: shift.shiftId,
        countedCash: "750000",
        countedBreakdown: { "50000": 15 },
        varianceReasonCode: "UNRECORDED_CASH_IN",
        varianceReason: "استلام عهدة نقدية فعلية لم يسجل مصدرها",
        enforceCashGovernance: true,
      }, MANAGER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await row(shift.shiftId)).status).toBe("OPEN");
  });

  it("يرفض عدم تطابق مجموع الفئات مع الرقم المعدود", async () => {
    const shift = await openZeroShift();

    await expect(
      closeShift({
        shiftId: shift.shiftId,
        countedCash: "750000",
        countedBreakdown: { "50000": 1 },
        varianceReasonCode: "COUNT_ERROR",
        varianceReason: "أعيد العد وظهر اختلاف يحتاج إلى مراجعة المدير",
        enforceCashGovernance: true,
      }, MANAGER),
    ).rejects.toThrow(/مجموع عدّ الفئات/);
  });

  it("يمنع الفرق الصغير أيضاً لأن التسامح المالي لا يخلق مصدراً", async () => {
    const shift = await openZeroShift();
    await expect(
      closeShift({
        shiftId: shift.shiftId,
        countedCash: "1000",
        countedBreakdown: { "250": 4 },
        enforceCashGovernance: true,
      }, CASHIER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await row(shift.shiftId)).status).toBe("OPEN");
  });

  it("يطبق المعادلة: افتتاح 100,000 + مبيعات نقدية 200,000 = إغلاق 300,000 فقط", async () => {
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      CASHIER,
    );
    await db().insert(receipts).values({
      branchId: 1,
      shiftId: shift.shiftId,
      direction: "IN",
      amount: "200000",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      createdBy: CASHIER.userId,
    });

    await expect(
      closeShift({
        shiftId: shift.shiftId,
        countedCash: "400000",
        countedBreakdown: { "50000": 8 },
        enforceCashGovernance: true,
      }, MANAGER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const result = await closeShift({
      shiftId: shift.shiftId,
      countedCash: "300000",
      countedBreakdown: { "50000": 6 },
      enforceCashGovernance: true,
    }, CASHIER);

    expect(result.expectedCash).toBe("300000.00");
    expect(result.countedCash).toBe("300000.00");
    expect(result.variance).toBe("0.00");
    expect(result.reconciliationStatus).toBe("MATCHED");
  });

  it("يغلق الوردية المطابقة بلا تفسير ويسجل MATCHED", async () => {
    const shift = await openZeroShift();
    const result = await closeShift({
      shiftId: shift.shiftId,
      countedCash: "0",
      countedBreakdown: {},
      enforceCashGovernance: true,
    }, CASHIER);

    expect(result.reconciliationStatus).toBe("MATCHED");
    const saved = await row(shift.shiftId);
    expect(saved.varianceReasonCode).toBeNull();
    expect(saved.varianceReason).toBeNull();
  });

  it("يغلق الوردية بعجز معتمد من المدير ويرحل العجز إلى ذمة الموظف ويصفر الدرج", async () => {
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      CASHIER,
    );
    await db().insert(receipts).values({
      branchId: 1,
      shiftId: shift.shiftId,
      direction: "IN",
      amount: "50000.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      createdBy: CASHIER.userId,
    });

    // المتوقع: 100,000 + 50,000 = 150,000
    // المعدود: 130,000 (عجز 20,000)
    const result = await closeShift({
      shiftId: shift.shiftId,
      countedCash: "130000",
      countedBreakdown: { "25000": 4, "10000": 3 },
      varianceReasonCode: "COUNT_ERROR",
      varianceReason: "عجز عد بعد الجرد المزدوج",
      managerApprovedByUserId: MANAGER.userId,
      enforceCashGovernance: false,
    }, CASHIER);

    expect(result.expectedCash).toBe("150000.00");
    expect(result.countedCash).toBe("130000.00");
    expect(result.variance).toBe("-20000.00");
    expect(result.reconciliationStatus).toBe("MANAGER_APPROVED");
    expect(result.varianceReasonCode).toBe("COUNT_ERROR");

    // التحقق من صف الوردية
    const saved = await row(shift.shiftId);
    expect(saved.status).toBe("CLOSED");
    expect(saved.varianceReasonCode).toBe("COUNT_ERROR");
    expect(saved.varianceReason).toBe("عجز عد بعد الجرد المزدوج");
    expect(saved.reconciliationStatus).toBe("MANAGER_APPROVED");
    expect(saved.varianceReviewedByUserId).toBe(MANAGER.userId);
    expect(saved.closingDrawerCash).toBe("0.00");

    // التحقق من إيصال العجز OUT بالدرج
    const outReceipt = (
      await db()
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.shiftId, shift.shiftId),
            eq(receipts.direction, "OUT"),
            eq(receipts.cashBucket, "DRAWER"),
            eq(receipts.referenceNumber, `SV-${shift.shiftId}`),
          ),
        )
    )[0];
    expect(outReceipt).toBeDefined();
    expect(outReceipt.amount).toBe("20000.00");
    expect(outReceipt.approvedBy).toBe(MANAGER.userId);

    // التحقق من القيد المحاسبي PAYMENT_OUT
    const [entry] = await db()
      .select()
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.receiptId, Number(outReceipt.id)),
          eq(accountingEntries.entryType, "PAYMENT_OUT"),
        ),
      );
    expect(entry).toBeDefined();
    expect(entry.entryType).toBe("PAYMENT_OUT");
    expect(entry.postingProfile).toBe("PAYMENT_OUT_EMPLOYEE_ADVANCE");
    expect(entry.dedupeKey).toBe(`SHIFT_VARIANCE_SHORTAGE:${shift.shiftId}`);
    expect(entry.amount).toBe("20000.00");

    // التحقق من تصفير رصيد الدرج بالكامل (0.00)
    const finalDrawerBalance = await computeDrawerCashBalance(
      db(),
      shift.shiftId,
      "100000",
    );
    expect(finalDrawerBalance.isZero()).toBe(true);

    // التحقق من إرجاع النقد المعدود 130,000 إلى الخزينة
    expect(result.treasuryReturn).toBeDefined();
    expect(result.treasuryReturn?.handoverNumber).toMatch(/^CH-1-/);
  });

  it("يغلق الوردية بزيادة معتمدة من المدير ويرحل الزيادة إلى أمانات أخرى ويصفر الدرج", async () => {
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      CASHIER,
    );

    // المتوقع: 100,000
    // المعدود: 125,000 (زيادة 25,000)
    const result = await closeShift({
      shiftId: shift.shiftId,
      countedCash: "125000",
      countedBreakdown: { "25000": 5 },
      varianceReasonCode: "OTHER",
      varianceReason: "زيادة نقدية مجهولة المصدر قيد المراجعة",
      managerApprovedByUserId: MANAGER.userId,
      enforceCashGovernance: false,
    }, CASHIER);

    expect(result.expectedCash).toBe("100000.00");
    expect(result.countedCash).toBe("125000.00");
    expect(result.variance).toBe("25000.00");
    expect(result.reconciliationStatus).toBe("MANAGER_APPROVED");
    expect(result.varianceReasonCode).toBe("OTHER");

    // التحقق من صف الوردية
    const saved = await row(shift.shiftId);
    expect(saved.status).toBe("CLOSED");
    expect(saved.varianceReasonCode).toBe("OTHER");
    expect(saved.varianceReason).toBe("زيادة نقدية مجهولة المصدر قيد المراجعة");
    expect(saved.reconciliationStatus).toBe("MANAGER_APPROVED");
    expect(saved.varianceReviewedByUserId).toBe(MANAGER.userId);
    expect(saved.closingDrawerCash).toBe("0.00");

    // التحقق من إيصال الزيادة IN بالدرج
    const inReceipt = (
      await db()
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.shiftId, shift.shiftId),
            eq(receipts.direction, "IN"),
            eq(receipts.cashBucket, "DRAWER"),
            eq(receipts.referenceNumber, `SV-${shift.shiftId}`),
          ),
        )
    )[0];
    expect(inReceipt).toBeDefined();
    expect(inReceipt.amount).toBe("25000.00");
    expect(inReceipt.approvedBy).toBe(MANAGER.userId);

    // التحقق من القيد المحاسبي PAYMENT_IN
    const [entry] = await db()
      .select()
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.receiptId, Number(inReceipt.id)),
          eq(accountingEntries.entryType, "PAYMENT_IN"),
        ),
      );
    expect(entry).toBeDefined();
    expect(entry.entryType).toBe("PAYMENT_IN");
    expect(entry.postingProfile).toBe("PAYMENT_IN_OTHER");
    expect(entry.dedupeKey).toBe(`SHIFT_VARIANCE_SURPLUS:${shift.shiftId}`);
    expect(entry.amount).toBe("25000.00");

    // التحقق من تصفير رصيد الدرج بالكامل (0.00)
    const finalDrawerBalance = await computeDrawerCashBalance(
      db(),
      shift.shiftId,
      "100000",
    );
    expect(finalDrawerBalance.isZero()).toBe(true);

    // التحقق من إرجاع النقد المعدود 125,000 إلى الخزينة بنجاح دون فشل في توفر النقد
    expect(result.treasuryReturn).toBeDefined();
    expect(result.treasuryReturn?.handoverNumber).toMatch(/^CH-1-/);
  });

  it("يشترط تفصيل فئات النقد المعدود عند إغلاق الوردية بفرق نقدي معتمد (P2)", async () => {
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      CASHIER,
    );

    // محاولة إغلاق بفرق معتمد دون تفصيل الفئات عند وجود مبلغ موجب
    await expect(
      closeShift({
        shiftId: shift.shiftId,
        countedCash: "80000",
        // countedBreakdown مفقود
        varianceReasonCode: "COUNT_ERROR",
        varianceReason: "عجز 20 ألف قيد التحقيق",
        enforceCashGovernance: false,
      }, MANAGER),
    ).rejects.toThrow(/تفصيل فئات النقد مطلوب عند وجود فرق نقدي/);
  });

  it.each(UTC_DAY_BOUNDARIES)("يسمح للوردية المعتمدة بفرق نقدي بالتقدم إلى مطابقة اليوم دون حظر UNMATCHED_SHIFT (P1) عند %s", async (now, businessDate) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    expect(todayUtcDate()).toBe(businessDate);
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      CASHIER,
    );
    // MySQL supplies openedAt independently of the JavaScript clock.
    await db().update(shifts).set({ openedAt: new Date(now) }).where(eq(shifts.id, shift.shiftId));

    // إغلاق معتمد بفرق ومعه تفصيل فئات صحيح
    const result = await closeShift({
      shiftId: shift.shiftId,
      countedCash: "80000",
      countedBreakdown: { "25000": 3, "5000": 1 }, // 75000 + 5000 = 80000
      varianceReasonCode: "COUNT_ERROR",
      varianceReason: "عجز 20 ألف معتمد من المدير",
      enforceCashGovernance: false,
    }, MANAGER);

    expect(result.reconciliationStatus).toBe("MANAGER_APPROVED");

    // التحقق من دليل مطابقة اليوم
    const evidence = await db().transaction(async (tx) => {
      return buildDailyCashEvidenceTx(tx, 1, todayUtcDate());
    });

    expect(evidence.shiftCount).toBe(1);
    expect(evidence.openShiftCount).toBe(0);
    expect(evidence.unmatchedShiftCount).toBe(0); // لا يُحظر بـ UNMATCHED_SHIFT
  });

  it.each(UTC_DAY_BOUNDARIES)("يحظر وردية تحمل MANAGER_APPROVED ولكن ينقصها إيصال التسوية SV-<shiftId> (P1 Evidence) عند %s", async (now, businessDate) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    expect(todayUtcDate()).toBe(businessDate);
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000", shiftType: "RETAIL" },
      CASHIER,
    );

    // محاكاة وردية أُغلقت تاريخياً بحالة MANAGER_APPROVED مع فرق، ولكن دون إنشاء إيصال SV
    await db()
      .update(shifts)
      .set({
        openedAt: new Date(now),
        status: "CLOSED",
        closedAt: new Date(),
        countedCash: "80000.00",
        expectedCash: "100000.00",
        variance: "-20000.00",
        reconciliationStatus: "MANAGER_APPROVED",
      })
      .where(eq(shifts.id, shift.shiftId));

    // التحقق من دليل مطابقة اليوم: يجب أن تُعد غير مطابقة (unmatchedShiftCount = 1) لغياب إيصال التسوية
    const evidence = await db().transaction(async (tx) => {
      return buildDailyCashEvidenceTx(tx, 1, todayUtcDate());
    });

    expect(evidence.shiftCount).toBe(1);
    expect(evidence.unmatchedShiftCount).toBe(1); // محظور لعدم وجود إيصال التسوية SV
  });
});
