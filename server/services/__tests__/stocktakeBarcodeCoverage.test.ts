// اختبار تغطية الباركود لنطاق الجرد (وثيقة «الجرد بالباركود» ٢٢/٨، م٢).
import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeBarcodeCoverage } from "../stocktakeService";

const TABLES = [
  "productUnitBarcodes",
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
  await d.insert(s.products).values([{ id: 1, name: "قلم جاف" }]);
  // 4 متغيّرات: (1) وحدة بباركود، (2) وحدة بلا باركود لكن ببديل، (3) بلا باركود إطلاقاً،
  // (4) باركوده على وحدةٍ معطَّلة فقط ⇒ يُعدّ ناقصاً.
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "V1", costPrice: "0" },
    { id: 2, productId: 1, sku: "V2", costPrice: "0" },
    { id: 3, productId: 1, sku: "V3", costPrice: "0" },
    { id: 4, productId: 1, sku: "V4", costPrice: "0" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 11, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-1" },
    { id: 21, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: null },
    { id: 31, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: null },
    { id: 41, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-4", isActive: false },
  ]);
  // بديلٌ للمتغيّر 2 على وحدته النشطة ⇒ يجعله مغطّى.
  await d.insert(s.productUnitBarcodes).values([{ productUnitId: 21, barcode: "ALT-2" }]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("computeBarcodeCoverage (م٢)", () => {
  it("يميّز المغطّى (وحدة بباركود أو بديل) عن الناقص، ويحسب النسبة", async () => {
    const cov = await computeBarcodeCoverage([1, 2, 3, 4]);
    expect(cov.total).toBe(4);
    expect(cov.withBarcode).toBe(2); // 1 (وحدة) + 2 (بديل)
    expect(cov.missing).toBe(2); // 3 (لا شيء) + 4 (باركوده على وحدة معطَّلة)
    expect(cov.coveragePct).toBe(50);
  });

  it("يُعيد وحدات الأساس الناقصة وعيّنة الأسماء", async () => {
    const cov = await computeBarcodeCoverage([1, 2, 3, 4]);
    // المتغيّر 3 له وحدة أساس نشطة (31) تُطبع؛ المتغيّر 4 وحدته الوحيدة معطَّلة ⇒ لا وحدة نشطة
    // له، فيبقى «ناقصاً» في العدّ لكن لا يظهر في missingUnitIds (لا شيء يُطبع له).
    expect(cov.missingUnitIds).toEqual([31]);
    expect(cov.missingSample.map((m) => m.variantId).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("النطاق الفارغ = تغطية 100٪ بلا نواقص", async () => {
    const cov = await computeBarcodeCoverage([]);
    expect(cov).toMatchObject({ total: 0, missing: 0, coveragePct: 100 });
    expect(cov.missingUnitIds).toEqual([]);
  });

  it("كل الأصناف مغطّاة ⇒ 100٪ بلا وحدات ناقصة", async () => {
    const cov = await computeBarcodeCoverage([1, 2]);
    expect(cov).toMatchObject({ total: 2, withBarcode: 2, missing: 0, coveragePct: 100 });
    expect(cov.missingUnitIds).toEqual([]);
  });
});
