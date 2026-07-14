/**
 * منطق سلة التحويل (١٤/٧/٢٠٢٦) — الثوابت الحرجة قبل الوصول للخادم:
 *
 *  T1: التجميع بالوحدة الأساس لكل متغيّر — الخادم يرفض تكرار المتغيّر في السند الواحد، ووحدات
 *      مختلفة لنفس الصنف (درزن+قطعة) تتقاسم رصيداً واحداً ⇒ تُدمَج في بندٍ واحد.
 *  T2: حالة النقص تُحسب بالطلب **المجمَّع** لا بالسطر (كرتونان من صنفٍ رصيده كرتون واحد = نقص
 *      حتى لو بدا كل سطر مقبولاً وحده) — نفس منطق ProductTable في الفاتورة.
 *  T3: كمية أساس كسرية (معامل تحويل كسري) تُعلَّم fractional ⇒ تُحجب قبل الإرسال (§٥: الكمية
 *      الأساس عدد صحيح دائماً).
 */
import { describe, it, expect } from "vitest";
import { computeLineStates, type TransferCartLine } from "../TransferCart";
import { aggregateByVariant } from "@/pages/Transfers";

function line(p: Partial<TransferCartLine> & { variantId: number; productUnitId: number }): TransferCartLine {
  return {
    productId: p.productId ?? p.variantId,
    variantId: p.variantId,
    productUnitId: p.productUnitId,
    name: p.name ?? `صنف ${p.variantId}`,
    sku: p.sku ?? `SKU-${p.variantId}`,
    barcode: p.barcode ?? null,
    unit: p.unit ?? "قطعة",
    qty: p.qty ?? 1,
    conversionFactor: p.conversionFactor ?? "1",
    stockBase: p.stockBase ?? 100,
  };
}

describe("T1: التجميع بالوحدة الأساس", () => {
  it("يدمج وحدتين لنفس المتغيّر في بندٍ واحد (درزن ١٢ + قطعة ٣ = ١٥)", () => {
    const rows = aggregateByVariant([
      line({ variantId: 7, productUnitId: 71, unit: "درزن", conversionFactor: "12", qty: 1, stockBase: 50 }),
      line({ variantId: 7, productUnitId: 70, unit: "قطعة", conversionFactor: "1", qty: 3, stockBase: 50 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ variantId: 7, baseQuantity: 15, stockBase: 50 });
  });

  it("يبقي المتغيّرات المختلفة بنوداً منفصلة ويضرب المعامل بالكمية", () => {
    const rows = aggregateByVariant([
      line({ variantId: 1, productUnitId: 10, conversionFactor: "1", qty: 4 }),
      line({ variantId: 2, productUnitId: 20, unit: "كرتون", conversionFactor: "24", qty: 2 }),
    ]);
    expect(rows.map((r) => [r.variantId, r.baseQuantity])).toEqual([
      [1, 4],
      [2, 48],
    ]);
  });
});

describe("T2: حالة المخزون بالطلب المجمَّع", () => {
  it("سطران لنفس المتغيّر يتجاوزان الرصيد معاً ⇒ كلاهما «لا يكفي» (وإن بدا كلٌّ وحده مقبولاً)", () => {
    const lines = [
      line({ variantId: 5, productUnitId: 51, unit: "كرتون", conversionFactor: "10", qty: 1, stockBase: 15 }),
      line({ variantId: 5, productUnitId: 50, unit: "قطعة", conversionFactor: "1", qty: 8, stockBase: 15 }),
    ];
    const st = computeLineStates(lines); // الطلب المجمَّع = 10 + 8 = 18 > 15
    expect(st[0].isShort).toBe(true);
    expect(st[1].isShort).toBe(true);
    expect(st[0].isOut).toBe(false);
  });

  it("رصيد صفر ⇒ نافذ (isOut) لا مجرّد نقص", () => {
    const st = computeLineStates([line({ variantId: 9, productUnitId: 90, qty: 1, stockBase: 0 })]);
    expect(st[0].isOut).toBe(true);
    expect(st[0].availInUnit).toBe(0);
  });

  it("المتاح بالوحدة = تقريب لأسفل (رصيد ٢٥ قطعة ⇒ درزنان فقط)", () => {
    const st = computeLineStates([line({ variantId: 3, productUnitId: 31, unit: "درزن", conversionFactor: "12", qty: 2, stockBase: 25 })]);
    expect(st[0].availInUnit).toBe(2);
    expect(st[0].baseQty).toBe(24);
    expect(st[0].isShort).toBe(false);
  });
});

describe("T3: الكمية الأساس عدد صحيح", () => {
  it("معامل كسري ⇒ fractional=true (يُحجب الإرسال)", () => {
    const st = computeLineStates([line({ variantId: 4, productUnitId: 41, conversionFactor: "1.5", qty: 1, stockBase: 10 })]);
    expect(st[0].fractional).toBe(true);
  });

  it("كمية صفر ⇒ fractional=true (لا سطر بلا كمية)", () => {
    const st = computeLineStates([line({ variantId: 4, productUnitId: 41, qty: 0, stockBase: 10 })]);
    expect(st[0].fractional).toBe(true);
  });
});
