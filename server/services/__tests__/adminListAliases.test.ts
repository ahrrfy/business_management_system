// اختبارات ظهور الباركودات البديلة في قائمة إدارة المنتجات (adminList) — تغذّي تصدير Excel/TSV.
// الثوابت:
//   L1: الوحدة ذات البدائل تعود بها مرتّبةً بترتيب الإدراج، والوحدات الأخرى بمصفوفة فارغة.
//   L2: البدائل لا تضاعف صفوف القائمة ولا العدّ الإجمالي (استعلام دفعي منفصل لا LEFT JOIN).
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { listProductsAdmin } from "../catalog/adminList";
import { addUnitBarcodeAlias } from "../catalog/barcodeAliases";

const TABLES = [
  "productUnitBarcodes", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "branchStock", "auditLogs", "categories", "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values([{ id: 1, name: "قلم أزرق" }, { id: 2, name: "قلم أحمر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "150.00" },
    { id: 2, productId: 2, sku: "PEN-RED", costPrice: "150.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", barcode: "6001000000017", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", barcode: "6001000000024", isBaseUnit: false },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", barcode: "6001000000031", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "500.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 50 },
  ]);
}

describe("adminList — الباركودات البديلة في القائمة/التصدير", () => {
  beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

  it("L1: الوحدة ذات البدائل تعود بها بترتيب الإدراج والبقية بمصفوفة فارغة", async () => {
    await addUnitBarcodeAlias(1, "9990000000001", "شكل ٢", 1);
    await addUnitBarcodeAlias(1, "9990000000002", "دفعة استيراد", 1);
    await addUnitBarcodeAlias(3, "9990000000003", null, 1);

    const { rows } = await listProductsAdmin({ branchId: 1 });
    const unit1 = rows.find((r) => r.productUnitId === 1);
    const unit2 = rows.find((r) => r.productUnitId === 2);
    const unit3 = rows.find((r) => r.productUnitId === 3);

    expect(unit1?.barcodeAliases).toEqual(["9990000000001", "9990000000002"]);
    expect(unit2?.barcodeAliases).toEqual([]);
    expect(unit3?.barcodeAliases).toEqual(["9990000000003"]);
  });

  it("L2: البدائل لا تضاعف الصفوف ولا العدّ الإجمالي", async () => {
    const before = await listProductsAdmin({ branchId: 1 });
    await addUnitBarcodeAlias(1, "9990000000011", null, 1);
    await addUnitBarcodeAlias(1, "9990000000012", null, 1);
    const after = await listProductsAdmin({ branchId: 1 });

    expect(after.rows.length).toBe(before.rows.length);
    expect(after.total).toBe(before.total);
    // الصفّ نفسه (منتج × متغيّر × وحدة) يظهر مرة واحدة حتى مع عدّة بدائل.
    expect(after.rows.filter((r) => r.productUnitId === 1)).toHaveLength(1);
  });

  it("L2ب: البحث لا ينكسر مع وجود بدائل (نفس النتائج + البدائل مرفقة)", async () => {
    await addUnitBarcodeAlias(1, "9990000000021", null, 1);
    const { rows } = await listProductsAdmin({ branchId: 1, q: "قلم أزرق" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.productName === "قلم أزرق")).toBe(true);
    expect(rows.find((r) => r.productUnitId === 1)?.barcodeAliases).toEqual(["9990000000021"]);
  });
});
