// اختبار توزيع مخزون البدائل (وثيقة «الجرد بالباركود» — حصص البدائل ٢٣/٨).
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listAlternativeStockBreakdown } from "../stocktakeService";

const TABLES = [
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "دفتر ٤٠ ورقة" },
    { id: 2, name: "قلم رصاص" }, // بلا بدائل — مستبعَد
    { id: 9, name: "بكج مدرسيّ", isBundle: true }, // بكج — مستبعَد
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB40", costPrice: "0", variantKind: "VARIANT" },
    { id: 2, productId: 1, sku: "NB40-ALT2", costPrice: "0", variantKind: "ALTERNATIVE", variantName: "ماركة النسر" },
    { id: 3, productId: 1, sku: "NB40-ALT3", costPrice: "0", variantKind: "ALTERNATIVE", variantName: "ماركة الغزال" },
    { id: 4, productId: 2, sku: "PENCIL", costPrice: "0", variantKind: "VARIANT" },
    { id: 9, productId: 9, sku: "BNDL", costPrice: "0", variantKind: "ALTERNATIVE", variantName: "س" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 9, variantId: 9, unitName: "طقم", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 2, branchId: 1, quantity: 30 },
    { variantId: 3, branchId: 1, quantity: 20 },
    { variantId: 4, branchId: 1, quantity: 99 },
    // فرعٌ ثانٍ للأصل فقط — لاختبار المجموع عبر الفروع وعزل الفرع.
    { variantId: 1, branchId: 2, quantity: 10 },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("listAlternativeStockBreakdown", () => {
  it("يجمع الإجماليّ عبر الفروع ويحسب حصص الترميزات، ويستبعد ما لا بديل له والبكج", async () => {
    const all = await listAlternativeStockBreakdown();
    expect(all).toHaveLength(1); // المنتج 1 فقط (2 بلا بدائل، 9 بكج)
    const p = all[0];
    expect(p.productId).toBe(1);
    // الإجماليّ عبر الفروع: v1=50+10، v2=30، v3=20 ⇒ 110.
    expect(p.totalBase).toBe(110);
    // الأصل أولاً ثمّ البدائل.
    expect(p.variants.map((v) => v.variantKind)).toEqual(["VARIANT", "ALTERNATIVE", "ALTERNATIVE"]);
    const byId = new Map(p.variants.map((v) => [v.variantId, v]));
    expect(byId.get(1)!.quantityBase).toBe(60); // 50 + 10
    expect(byId.get(2)!.quantityBase).toBe(30);
    expect(byId.get(3)!.quantityBase).toBe(20);
    // الحصص من 110: 60→54.5٪، 30→27.3٪، 20→18.2٪.
    expect(byId.get(1)!.sharePct).toBeCloseTo(54.5, 1);
    expect(byId.get(2)!.sharePct).toBeCloseTo(27.3, 1);
    expect(byId.get(3)!.sharePct).toBeCloseTo(18.2, 1);
  });

  it("عزل الفرع: branchId يحصر المخزون بفرعٍ واحد", async () => {
    const b1 = await listAlternativeStockBreakdown({ branchId: 1 });
    expect(b1[0].totalBase).toBe(100); // 50+30+20 (بلا فرع 2)
    expect(b1[0].variants.find((v) => v.variantId === 1)!.quantityBase).toBe(50);
    const b2 = await listAlternativeStockBreakdown({ branchId: 2 });
    expect(b2[0].totalBase).toBe(10); // الأصل فقط في فرع 2
    expect(b2[0].variants.find((v) => v.variantId === 1)!.sharePct).toBe(100);
  });

  it("مرشّح productId يعيد منتجاً واحداً", async () => {
    const one = await listAlternativeStockBreakdown({ productId: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].productId).toBe(1);
    const none = await listAlternativeStockBreakdown({ productId: 2 }); // بلا بدائل
    expect(none).toEqual([]);
  });

  it("إجماليّ صفر ⇒ حصص صفر بلا قسمةٍ على صفر", async () => {
    await db().delete(s.branchStock);
    const all = await listAlternativeStockBreakdown();
    expect(all[0].totalBase).toBe(0);
    expect(all[0].variants.every((v) => v.sharePct === 0)).toBe(true);
  });
});
