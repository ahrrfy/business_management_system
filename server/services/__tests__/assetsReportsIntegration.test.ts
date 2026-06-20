// تكامل الأصول↔التقارير (تحقيق عدائي ٢٠/٦ كشف فجوتين بعد إغلاق FA-02/FI-01 المحاسبيّين):
//   FA-02: ربح/خسارة التصرّف (قيد ADJUST بمفتاح ASSET_DISP_PL) كان يَغيب عن قائمة الأرباح والخسائر.
//   FI-01: اقتناء أصل على ذمّة المورد (PURCHASE بلا purchaseOrderId) كان يَغيب عن كشف حساب المورد.
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createAsset, disposeAsset } from "../assetsService";
import { getProfitAndLoss } from "../reportsFinancialService";
import { getSupplierStatement } from "../reportsService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const ACTOR = { userId: 1, branchId: 1, role: "admin" as const };

beforeEach(async () => {
  await truncateTables([
    "accountingEntries", "receipts", "assetMaintenance", "assetCustodyLog",
    "assetDocuments", "fixedAssets", "suppliers", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد الأصول" });
});

describe("تكامل الأصول↔التقارير (FA-02 P&L + FI-01 كشف المورد)", () => {
  it("FA-02: ربح بيع أصل يَظهر في قائمة الأرباح والخسائر ويَرفع صافي الربح", async () => {
    // شراء وتصرّف في نفس اليوم ⇒ إهلاك صفر ⇒ NBV = قيمة الشراء ⇒ الربح = المتحصّل − الشراء.
    const a = await createAsset(
      { name: "طابعة", category: "computers", purchaseDate: "2024-06-01", purchaseValue: "1000000", usefulLifeYears: 5 },
      ACTOR,
    );
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-06-01", reason: "بيع", value: "1200000" }, ACTOR);

    const pl = await getProfitAndLoss({ from: "2024-06-01", to: "2024-06-01" });
    const line = pl.current.expenseLines.find((l) => l.key === "ASSET_DISPOSAL_PL");
    expect(line).toBeTruthy();
    expect(line!.amount).toBe("-200000.00"); // ربح ⇒ مصروف سالب (دخل غير تشغيلي)
    expect(pl.current.netProfit).toBe("200000.00"); // صافي الربح يَعكس الربح
  });

  it("FA-02: خسارة شطب أصل (بلا متحصّل) تَظهر مصروفاً وتَخفض صافي الربح", async () => {
    const a = await createAsset(
      { name: "كرسي", category: "computers", purchaseDate: "2024-06-01", purchaseValue: "500000", usefulLifeYears: 5 },
      ACTOR,
    );
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-06-01", reason: "تلف", value: "0" }, ACTOR); // خسارة = −NBV

    const pl = await getProfitAndLoss({ from: "2024-06-01", to: "2024-06-01" });
    const line = pl.current.expenseLines.find((l) => l.key === "ASSET_DISPOSAL_PL");
    expect(line!.amount).toBe("500000.00"); // خسارة ⇒ مصروف موجب
    expect(pl.current.netProfit).toBe("-500000.00");
  });

  it("FI-01: اقتناء أصل على ذمّة المورد يَظهر في كشف الحساب ويتّزن مع الرصيد الحالي", async () => {
    await createAsset(
      { name: "خادم", category: "computers", purchaseDate: "2024-03-01", purchaseValue: "600000", usefulLifeYears: 5, supplierId: 1 },
      ACTOR,
    );

    // بلا فترة: حركة الشراء تَظهر والرصيد الحالي = 600000.
    const stmt = await getSupplierStatement(1);
    const purchaseMove = stmt!.payments.find((p) => p.entryType === "PURCHASE");
    expect(purchaseMove).toBeTruthy();
    expect(purchaseMove!.amount).toBe("600000.00");
    expect(stmt!.summary.currentBalance).toBe("600000.00");

    // فترة تبدأ بعد الشراء ⇒ الرصيد الافتتاحي يَشمل شراء الأصل (إصلاح FI-01).
    const periodStmt = await getSupplierStatement(1, { from: "2024-06-01" });
    expect(periodStmt!.summary.openingBalance).toBe("600000.00");
  });
});
