/**
 * حوكمة الوردية للأوفلاين (الشريحة ٤): إغلاق idempotent + منع الكتابة بأثر رجعي بعد إغلاق الوردية.
 *  - انقطاع منتصف الإغلاق (الالتزام تم والردّ ضاع) ⇒ إعادة المحاولة تعيد اللقطة الملتزمة كما هي
 *    بلا كتابة (countedCash الجديدة تُهمَل — لا تعديل Z بأثر رجعي).
 *  - فاتورة أوفلاينية تصل بعد الإغلاق تُرفض وتنتقل لمسار التسوية اللاحقة، فلا تغيّر لقطة Z.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { replayOfflineSale } from "../offline/replaySale";
import { closeShift, getShiftReport } from "../shiftService";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  await truncateTables(TABLES);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 2, openId: "local_cashier1", name: "كاشير ف١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "قلم" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" }]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "250.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 10 }]);
  await d.insert(s.shifts).values([
    { id: 1, userId: 2, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "2:1", openingBalance: "10000.00" },
  ]);
}

const cashier1 = { userId: 2, branchId: 1, role: "cashier" } as const;

beforeEach(async () => { await reset(); await seed(); });

describe("closeShift — إغلاق idempotent (ش٤)", () => {
  it("الإغلاق الثاني يعيد اللقطة الملتزمة كما هي بلا كتابة (countedCash الجديدة تُهمَل)", async () => {
    const first = await closeShift({ shiftId: 1, countedCash: "10000.00" }, cashier1);
    expect((first as { alreadyClosed?: boolean }).alreadyClosed).toBeUndefined();
    expect(first.countedCash).toBe("10000.00");

    // إعادة محاولة بعد «ضياع الردّ» — بعدٍّ مختلف عمداً: يجب أن يُهمَل.
    const second = await closeShift({ shiftId: 1, countedCash: "999999.00" }, cashier1);
    expect((second as { alreadyClosed?: boolean }).alreadyClosed).toBe(true);
    expect(second.countedCash).toBe("10000.00");
    expect(second.expectedCash).toBe(first.expectedCash);
    expect(second.variance).toBe(first.variance);

    // القاعدة لم تُلمس: countedCash المخزّنة هي الأولى.
    const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, 1)))[0];
    expect(String(sh.countedCash)).toBe("10000.00");
  });

  it("فحوص الملكية تسبق الإرجاع الـidempotent: كاشير آخر لا يقرأ لقطة إغلاق غيره", async () => {
    await db().insert(s.users).values([
      { id: 3, openId: "local_cashier2", name: "كاشير آخر", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    ]);
    await closeShift({ shiftId: 1, countedCash: "10000.00" }, cashier1);
    await expect(
      closeShift({ shiftId: 1, countedCash: "0.00" }, { userId: 3, branchId: 1, role: "cashier" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("getShiftReport — منع الترحيل الأوفلايني بعد الإغلاق (ش٤)", () => {
  it("فاتورة أوفلاينية تصل بعد الإغلاق تُرفض ولا تغيّر الفواتير أو لقطة الوردية", async () => {
    await closeShift({ shiftId: 1, countedCash: "10250.00" }, cashier1);
    await expect(
      replayOfflineSale(
        {
          branchId: 1,
          shiftId: 1,
          priceTier: "RETAIL",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "250.00" }],
          payment: { amount: "250.00", method: "CASH" },
          clientRequestId: "late-1",
          capturedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          offlineReceiptNumber: "OFF-1-zz99-1",
        },
        cashier1,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    const report = await getShiftReport(1);
    expect(report).not.toBeNull();
    expect(report!.lateSyncedCount).toBe(0);
    expect(report!.lateSyncedTotal).toBe("0.00");
    expect(report!.invoiceCount).toBe(0);
  });

  it("وردية مفتوحة أو بلا فواتير متأخرة ⇒ lateSynced صفر", async () => {
    const openReport = await getShiftReport(1);
    expect(openReport!.lateSyncedCount).toBe(0);
    await closeShift({ shiftId: 1, countedCash: "10000.00" }, cashier1);
    const closedReport = await getShiftReport(1);
    expect(closedReport!.lateSyncedCount).toBe(0);
    expect(closedReport!.lateSyncedTotal).toBe("0.00");
  });
});
