// تكامل الأصول↔التقارير (تحقيق عدائي ٢٠/٦ كشف فجوتين بعد إغلاق FA-02/FI-01 المحاسبيّين):
//   FA-02: ربح/خسارة التصرّف (قيد ADJUST بمفتاح ASSET_DISP_PL) كان يَغيب عن قائمة الأرباح والخسائر.
//   FI-01: اقتناء أصل على ذمّة المورد (PURCHASE بلا purchaseOrderId) كان يَغيب عن كشف حساب المورد.
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeDepreciation, createAsset, disposeAsset, postMonthlyDepreciation } from "../assetsService";
import { getFinancialPosition, getProfitAndLoss } from "../reportsFinancialService";
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

  it("FI-02: الإهلاك الشهري يُرحّل مصروفاً + يُحدّث المتراكم + P&L + ميزانية NBV + idempotent", async () => {
    const a = await createAsset(
      { name: "آلة", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1200000", salvageValue: "0", usefulLifeYears: 5, depreciationMethod: "sl" },
      ACTOR,
    );
    // المتوقَّع التحليليّ حتى نهاية يونيو ٢٠٢٤ (نفس asOf الذي تَستعمله الخدمة: أوّل التالي).
    const asOf = new Date(Date.UTC(2024, 6, 1));
    const expected = computeDepreciation(
      { purchaseValue: "1200000", salvageValue: "0", usefulLifeYears: 5, depreciationMethod: "sl", purchaseDate: "2023-01-01", status: "active" },
      asOf,
    ).accumulated;
    expect(expected).toBeGreaterThan(0);

    const run = await postMonthlyDepreciation(2024, 6, ACTOR);
    expect(run.assetsPosted).toBe(1);
    expect(Number(run.totalDepreciation)).toBe(expected);

    // قيد DEPR مُرحَّل بقيمة الإهلاك (cost) — مصروف غير نقديّ.
    const [entry] = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "ADJUST"), eq(s.accountingEntries.dedupeKey, `DEPR:${a!.id}:2024-06`)));
    expect(entry).toBeTruthy();
    expect(Number(entry.cost)).toBe(expected);

    // المتراكم على الأصل = المتوقَّع التحليليّ (catch-up).
    const [asset] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, a!.id));
    expect(Number(asset.accumulatedDepreciation)).toBe(expected);

    // P&L: سطر الإهلاك = المصروف، وصافي الربح سالب بقدره (لا إيراد).
    const pl = await getProfitAndLoss({ from: "2024-06-01", to: "2024-06-30" });
    const depLine = pl.current.expenseLines.find((l) => l.key === "DEPRECIATION");
    expect(depLine).toBeTruthy();
    expect(Number(depLine!.amount)).toBe(expected);
    expect(Number(pl.current.netProfit)).toBe(-expected);

    // الميزانية: الأصول بـNBV = التكلفة − المتراكم.
    const pos = await getFinancialPosition();
    expect(Number(pos.fixedAssets)).toBe(1200000 - expected);

    // idempotent: إعادة نفس الشهر ⇒ لا ترحيل ولا تغيّر في المتراكم.
    const rerun = await postMonthlyDepreciation(2024, 6, ACTOR);
    expect(rerun.assetsPosted).toBe(0);
    const [asset2] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, a!.id));
    expect(Number(asset2.accumulatedDepreciation)).toBe(expected);
  });

  it("FI-02: التصرّف بلا ترحيل شهري يُرحّل إهلاك catch-up حتى التاريخ (لا تسرّب من حقوق الملكية)", async () => {
    const a = await createAsset(
      { name: "معدّة", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5, depreciationMethod: "sl" },
      ACTOR,
    );
    // لم يُشغَّل postMonthlyDepreciation ⇒ المتراكم المخزَّن 0. التصرّف عند 2024-01-01.
    const expectedAccum = computeDepreciation(
      { purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5, depreciationMethod: "sl", purchaseDate: "2023-01-01", status: "active", disposalDate: "2024-01-01" },
      new Date("2024-01-01"),
    ).accumulated;
    expect(expectedAccum).toBeGreaterThan(0);

    await disposeAsset(a!.id, { kind: "disposed", date: "2024-01-01", reason: "بيع", value: "700000" }, ACTOR);

    // قيد catch-up DEPR:id:DISP بقيمة الإهلاك غير المُرحَّل ⇒ يُعترَف به مصروفاً.
    const [dep] = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "ADJUST"), eq(s.accountingEntries.dedupeKey, `DEPR:${a!.id}:DISP`)));
    expect(dep).toBeTruthy();
    expect(Number(dep.cost)).toBe(expectedAccum);
    // المتراكم على الأصل صار = المتوقَّع التحليليّ ⇒ القيمة الدفترية تُطابق NBV عند التصرّف.
    const [asset] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, a!.id));
    expect(Number(asset.accumulatedDepreciation)).toBe(expectedAccum);
  });
});
