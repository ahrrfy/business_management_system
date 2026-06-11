// اختبارات قائمة إدارة المنتجات (listProductsAdmin) — LEFT JOIN يُظهر الناقص،
// includeInactive يُظهر المعطّل، البحث الذكي NULL-safe، تقسيم صفحات حتمي،
// + تفعيل/تعطيل المنتج (setProductActive) وانعكاسه على POS.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listForPos, listProductsAdmin, setProductActive } from "../catalogService";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["branchStock", "productPrices", "productUnits", "productVariants", "products", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const actor = { userId: 1, branchId: 1 };

/** بذرة: P1/P2 كاملان، P3 ناقص (منتج بلا متغيّرات/وحدات)، P4 كامل لكنه معطّل. */
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق فاخر" },
    { id: 2, name: "مكتبة خشبية صغيرة" },
    { id: 3, name: "منتج ناقص بلا وحدات" },
    { id: 4, name: "منتج معطّل", isActive: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "SHELF-S", costPrice: "0.00" },
    { id: 4, productId: 4, sku: "OFF-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500213" },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500220" },
    { id: 4, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "15000.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "1000.00" },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

const names = (rows: Array<{ productName: string }>) => rows.map((r) => r.productName);
const rowKey = (r: { productId: number; variantId: number | null; productUnitId: number | null }) =>
  `${r.productId}-${r.variantId ?? 0}-${r.productUnitId ?? 0}`;

describe("listProductsAdmin — LEFT JOIN يُظهر المنتجات الناقصة", () => {
  it("منتج بلا متغيّرات/وحدات يظهر في قائمة الإدارة (NULL) ولا يظهر في POS", async () => {
    const { rows } = await listProductsAdmin({ branchId: 1 });
    const incomplete = rows.find((r) => r.productName === "منتج ناقص بلا وحدات");
    expect(incomplete).toBeTruthy();
    expect(incomplete?.variantId).toBeNull();
    expect(incomplete?.productUnitId).toBeNull();
    expect(incomplete?.stockBase).toBe(0);

    const pos = await listForPos(1, "RETAIL");
    expect(names(pos)).not.toContain("منتج ناقص بلا وحدات");
  });
});

describe("listProductsAdmin — includeInactive", () => {
  it("المنتج المعطّل مخفيّ افتراضياً ويظهر مع includeInactive بعلَم productIsActive=false", async () => {
    const def = await listProductsAdmin({ branchId: 1 });
    expect(names(def.rows)).not.toContain("منتج معطّل");

    const all = await listProductsAdmin({ branchId: 1, includeInactive: true });
    const off = all.rows.find((r) => r.productName === "منتج معطّل");
    expect(off).toBeTruthy();
    expect(off?.productIsActive).toBe(false);
    expect(all.total).toBe(def.total + 1);
  });
});

describe("listProductsAdmin — البحث الذكي NULL-safe فوق LEFT JOIN", () => {
  it("«مكتبه» (هاء بدل تاء مربوطة) تجد «مكتبة خشبية صغيرة»", async () => {
    const { rows } = await listProductsAdmin({ branchId: 1, q: "مكتبه" });
    expect(names(rows)).toContain("مكتبة خشبية صغيرة");
  });

  it("«ناقص» تجد المنتج الناقص رغم أعمدة SKU/باركود NULL (coalesce)", async () => {
    const { rows } = await listProductsAdmin({ branchId: 1, q: "ناقص" });
    expect(names(rows)).toContain("منتج ناقص بلا وحدات");
  });
});

describe("listProductsAdmin — تقسيم صفحات حتمي", () => {
  it("total ثابت بين الصفحات، والصفوف لا تتكرّر بينها، والمجموع = العدّ الكامل", async () => {
    const p1 = await listProductsAdmin({ branchId: 1, limit: 2, offset: 0 });
    const p2 = await listProductsAdmin({ branchId: 1, limit: 2, offset: 2 });
    expect(p1.total).toBe(p2.total);

    const keys1 = p1.rows.map(rowKey);
    const keys2 = p2.rows.map(rowKey);
    for (const k of keys2) expect(keys1).not.toContain(k);

    const full = await listProductsAdmin({ branchId: 1, limit: 500, offset: 0 });
    expect(full.total).toBe(full.rows.length);
    expect(p1.total).toBe(full.total);
    expect(keys1.length + keys2.length).toBeLessThanOrEqual(full.total);
  });
});

describe("setProductActive — التعطيل يخفي من POS والقائمة الافتراضية", () => {
  it("تعطيل P1 يخفيه، includeInactive يكشفه بعلَم false، والتفعيل يعيده، وغير الموجود NOT_FOUND", async () => {
    await setProductActive(1, false, actor);

    expect(names(await listForPos(1, "RETAIL"))).not.toContain("قلم جاف أزرق فاخر");
    const def = await listProductsAdmin({ branchId: 1 });
    expect(names(def.rows)).not.toContain("قلم جاف أزرق فاخر");

    const all = await listProductsAdmin({ branchId: 1, includeInactive: true });
    const p1 = all.rows.find((r) => r.productName === "قلم جاف أزرق فاخر");
    expect(p1).toBeTruthy();
    expect(p1?.productIsActive).toBe(false);

    await setProductActive(1, true, actor);
    expect(names(await listForPos(1, "RETAIL"))).toContain("قلم جاف أزرق فاخر");
    const restored = await listProductsAdmin({ branchId: 1 });
    expect(names(restored.rows)).toContain("قلم جاف أزرق فاخر");

    await expect(setProductActive(999999, false, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
