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
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { getMonthCloseReadiness } from "../reports/monthCloseReadiness";
import { truncateTables } from "./__testUtils__";

const MONTH = "2026-07"; // شهرٌ منقضٍ: من 2026-07-01 إلى 2026-07-31

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "stockAdjustmentRequests",
    "stocktakeSessions",
    "receipts",
    "shifts",
    "productVariants",
    "products",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.users).values({ id: 1, openId: "t", name: "مدير", role: "manager", loginMethod: "local" });
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  // متغيّرٌ حقيقيّ: طلب تسوية المخزون يشير إليه بمفتاحٍ أجنبيّ.
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
}

/** بندٌ بمفتاحه من النتيجة. */
async function item(key: string, branchId: number | null = 1) {
  const res = await getMonthCloseReadiness({ month: MONTH, branchId });
  const found = res.items.find((i) => i.key === key);
  if (!found) throw new Error(`بندٌ مفقود في نتيجة الجاهزية: ${key}`);
  return { item: found, blocked: res.blocked };
}

async function seedOpenShift(branchId: number, openedAt: Date) {
  await db().insert(s.shifts).values({
    userId: 1, branchId, status: "OPEN", openedAt,
    openGuard: `1:${branchId}:${openedAt.getTime()}`, openingBalance: "0",
  });
}

async function seedPendingVoucher(branchId: number, voucherDate: string) {
  await db().insert(s.receipts).values({
    branchId, direction: "OUT", amount: "100.00", paymentMethod: "CASH",
    status: "COMPLETED", createdBy: 1,
    voucherNumber: `V-${branchId}-${voucherDate}`, voucherDate,
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
    expect(res.items.map((i) => i.key).sort()).toEqual(
      ["activeStocktakes", "ledgerGaps", "openShifts", "pendingStockAdjustments", "pendingVouchers"],
    );
  });

  it("٢) وردية مفتوحة ⇒ حجب (قرار المالك)", async () => {
    await seedOpenShift(1, new Date("2026-07-15T10:00:00Z"));
    const { item: it_, blocked } = await item("openShifts");
    expect(it_.status).toBe("BLOCK");
    expect(it_.count).toBe(1);
    expect(blocked).toBe(true);
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

  it("٦) عزل الفرع: وردية مفتوحة في فرعٍ آخر لا تحجب إقفال فرعي", async () => {
    await seedOpenShift(2, new Date("2026-07-15T10:00:00Z"));
    expect((await item("openShifts", 1)).blocked).toBe(false);
    expect((await item("openShifts", 2)).blocked).toBe(true);
    // وبلا تحديد فرع (كل الفروع) تظهر.
    expect((await item("openShifts", null)).item.status).toBe("BLOCK");
  });

  it("٧) جلسة جردٍ نشطة ⇒ تنبيهٌ فقط، لا حجب (قرار المالك)", async () => {
    await db().insert(s.stocktakeSessions).values({
      code: "ST-001", name: "جرد تجريبي",
      branchId: 1, scopeType: "FULL", sessionType: "NORMAL", status: "COUNTING", createdBy: 1,
    });
    const { item: it_, blocked } = await item("activeStocktakes");
    expect(it_.status).toBe("WARN");
    expect(it_.count).toBe(1);
    expect(blocked).toBe(false);
  });

  it("٨) طلب تسوية مخزونٍ معلَّق ⇒ تنبيهٌ فقط، لا حجب", async () => {
    await db().insert(s.stockAdjustmentRequests).values({
      branchId: 1, variantId: 1, targetQuantity: 5, expectedQuantity: 3,
      status: "PENDING_APPROVAL", createdBy: 1,
    });
    const { item: it_, blocked } = await item("pendingStockAdjustments");
    expect(it_.status).toBe("WARN");
    expect(blocked).toBe(false);
  });

  it("٩) فجوة دفترٍ مزدوج في الشهر ⇒ تنبيهٌ فقط، لا حجب", async () => {
    const er = await db().insert(s.accountingEntries).values({
      entryType: "GIFT_OUT", branchId: 1, amount: "0.00", entryDate: new Date("2026-07-09"),
    });
    await db().insert(s.journalEntries).values({
      entryId: extractInsertId(er), entryDate: new Date("2026-07-09"), branchId: 1,
      status: "UNMAPPED", unmappedReason: "نوعُ قيدٍ غير مُخطَّط بعد: GIFT_OUT",
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
    expect(res.items.filter((i) => i.status === "BLOCK")).toHaveLength(1);
    expect(res.items.find((i) => i.key === "pendingVouchers")?.status).toBe("OK");
  });
});
