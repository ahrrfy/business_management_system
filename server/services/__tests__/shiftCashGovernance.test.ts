import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { branches, receipts, shifts, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";

const CASHIER = { userId: 10, branchId: 1, role: "cashier" };
const MANAGER = { userId: 20, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL missing");
  return value;
}

beforeEach(async () => {
  await db().insert(branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(users).values([
    { id: CASHIER.userId, openId: "cash-governance-cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER.userId, openId: "cash-governance-manager", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
});

async function openZeroShift() {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, CASHIER);
}

async function row(id: number) {
  return (await db().select().from(shifts).where(eq(shifts.id, id)).limit(1))[0];
}

describe("حوكمة فروقات درج النقد", () => {
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
});
