/**
 * اختبار منطق إهلاك الأصول (computeDepreciation) — دالة نقيّة بلا قاعدة بيانات.
 * يغطّي القسط الثابت (sl) والمتناقص المضاعف (db)، حدّ القيمة التخريدية، والأصل المُستبعَد.
 */
import { describe, expect, it } from "vitest";
import { computeDepreciation } from "../assetsService";

const FAR_FUTURE = new Date("2100-01-01");
const base = { purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5, purchaseDate: "2020-01-01" };

describe("computeDepreciation — القسط الثابت (sl)", () => {
  it("جدول بطول العمر، يبلغ التخريدية في آخر سنة، والقسط = (التكلفة−التخريدية)/العمر", () => {
    const r = computeDepreciation({ ...base, depreciationMethod: "sl", status: "active" }, FAR_FUTURE);
    expect(r.schedule).toHaveLength(5);
    expect(r.annualDep).toBe(180000); // (1,000,000 − 100,000) / 5
    expect(r.schedule[0].dep).toBe(180000);
    expect(r.schedule[4].closing).toBe(100000); // التخريدية بالضبط
    // مجموع الإهلاك = القابل للإهلاك
    const sumDep = r.schedule.reduce((s, x) => s + x.dep, 0);
    expect(sumDep).toBe(900000);
  });

  it("بعد انقضاء العمر: القيمة الدفترية = التخريدية والمتراكم = القابل للإهلاك", () => {
    const r = computeDepreciation({ ...base, depreciationMethod: "sl", status: "active" }, FAR_FUTURE);
    expect(r.bookValue).toBe(100000);
    expect(r.accumulated).toBe(900000);
    expect(r.depPct).toBe(90); // 900,000 / 1,000,000
  });
});

describe("computeDepreciation — القسط المتناقص المضاعف (db)", () => {
  it("السنة الأولى = التكلفة × (2/العمر)، ولا تنزل القيمة عن التخريدية", () => {
    const r = computeDepreciation({ ...base, depreciationMethod: "db", status: "active" }, FAR_FUTURE);
    expect(r.schedule).toHaveLength(5);
    expect(r.schedule[0].dep).toBe(400000); // 1,000,000 × 0.4
    for (const row of r.schedule) expect(row.closing).toBeGreaterThanOrEqual(100000);
    expect(r.schedule[4].closing).toBe(100000); // آخر سنة تنزل للتخريدية
    expect(r.bookValue).toBe(100000);
  });
});

describe("computeDepreciation — ثوابت السلامة", () => {
  it("المُستبعَد قبل نهاية العمر يُحتسب بقيمته الدفترية الحقيقية عند تاريخ الإخراج (تناسبي = نفس الأصل الحيّ عند ذلك التاريخ)", () => {
    const disposedEarly = computeDepreciation({ ...base, depreciationMethod: "sl", status: "disposed", disposalDate: "2022-06-01" }, FAR_FUTURE);
    const liveAtDate = computeDepreciation({ ...base, depreciationMethod: "sl", status: "active" }, new Date("2022-06-01"));
    expect(disposedEarly.bookValue).toBe(liveAtDate.bookValue); // proration متّسقة مع المسار الحيّ (لا إهلاك كامل قسري)
    expect(disposedEarly.bookValue).toBeGreaterThan(100000); // لم يبلغ التخريدية بعد
    expect(disposedEarly.bookValue).toBeLessThan(1000000);
    expect(disposedEarly.accumulated).toBe(1000000 - disposedEarly.bookValue);
  });

  it("المُستبعَد بعد تجاوز عمره يبلغ التخريدية طبيعياً (دفترية = تخريدية)", () => {
    const disposedOld = computeDepreciation({ ...base, depreciationMethod: "sl", status: "disposed", disposalDate: "2030-01-01" }, FAR_FUTURE);
    expect(disposedOld.bookValue).toBe(100000);
    expect(disposedOld.accumulated).toBe(900000);
  });

  it("منتصف العمر: التخريدية ≤ الدفترية ≤ التكلفة، والمتراكم = التكلفة − الدفترية", () => {
    const r = computeDepreciation({ ...base, depreciationMethod: "sl", status: "active" }, new Date("2022-07-01"));
    expect(r.bookValue).toBeGreaterThan(100000);
    expect(r.bookValue).toBeLessThan(1000000);
    expect(r.accumulated).toBe(1000000 - r.bookValue);
    expect(r.depPct).toBeGreaterThan(0);
    expect(r.depPct).toBeLessThan(100);
  });

  it("القيمة الدفترية لا تنزل أبداً تحت التخريدية", () => {
    const r = computeDepreciation({ purchaseValue: "500000", salvageValue: "50000", usefulLifeYears: 3, purchaseDate: "2010-01-01", depreciationMethod: "db", status: "active" }, FAR_FUTURE);
    expect(r.bookValue).toBe(50000);
    for (const row of r.schedule) expect(row.closing).toBeGreaterThanOrEqual(50000);
  });
});

describe("computeDepreciation — الأصول الافتتاحية السابقة للنظام (IAS 16)", () => {
  it("أصل افتتاحي بمجمع إهلاك سابق: القيمة الدفترية عند التسجيل = التكلفة − الإهلاك السابق", () => {
    const openingAsset = {
      purchaseValue: "10000000",
      salvageValue: "0",
      usefulLifeYears: 5,
      depreciationMethod: "sl" as const,
      purchaseDate: "2026-09-01",
      status: "active",
      openingDepreciation: "4000000",
      accumulatedDepreciation: "4000000",
    };
    const atOpening = computeDepreciation(openingAsset, new Date("2026-09-01"));
    expect(atOpening.accumulated).toBe(4000000);
    expect(atOpening.bookValue).toBe(6000000);
  });

  it("أصل افتتاحي: إهلاك شهر إضافي يُضاف تراكمياً فوق الإهلاك الافتتاحي دون تجميد", () => {
    const openingAsset = {
      purchaseValue: "12000000",
      salvageValue: "0",
      usefulLifeYears: 5, // 2.4M سنوياً = 200,000 شهرياً
      depreciationMethod: "sl" as const,
      purchaseDate: "2026-09-01",
      status: "active",
      openingDepreciation: "6000000",
      accumulatedDepreciation: "6000000",
    };
    // بعد شهر واحد (نهاية سبتمبر 2026):
    const oneMonthLater = computeDepreciation(openingAsset, new Date("2026-10-01"));
    expect(oneMonthLater.accumulated).toBeGreaterThan(6000000);
    expect(oneMonthLater.bookValue).toBeLessThan(6000000);
    expect(oneMonthLater.accumulated + oneMonthLater.bookValue).toBe(12000000);
  });

  it("أصل افتتاحي بتاريخ شراء قديم: لا ينزل مجمع الإهلاك أبداً عن الرصيد الافتتاحي المسجل", () => {
    const openingAsset = {
      purchaseValue: "5000000",
      salvageValue: "500000",
      usefulLifeYears: 5,
      depreciationMethod: "sl" as const,
      purchaseDate: "2020-01-01",
      status: "active",
      openingDepreciation: "3000000",
      accumulatedDepreciation: "3000000",
    };
    const r = computeDepreciation(openingAsset, new Date("2026-09-01"));
    expect(r.accumulated).toBeGreaterThanOrEqual(3000000);
    expect(r.bookValue).toBeLessThanOrEqual(2000000);
  });
});

