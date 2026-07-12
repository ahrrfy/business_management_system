/**
 * اختبارات storeCatalogService — «الكتالوج والعرض» في لوحة hPanel.
 * يغطّي: تجميع القائمة بحبيبة المنتج + الفلاتر (قسم/مميّز/مخفيّ/بلا صورة/بحث)، تبديل التمييز/الإظهار،
 * تعيين/إزالة الصورة الرئيسية، وضبط المخزون الذرّي (setStock + قيد ADJUST بإشارة صحيحة + عدم القيد عند دلتا صفر).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import {
  listStoreCatalog,
  setProductFeatured,
  setProductPrimaryImage,
  setProductStoreVisible,
  setStoreProductStock,
} from "../storeCatalogService";
import { truncateTables } from "../../__tests__/__testUtils__";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables([
    "accountingEntries", "inventoryMovements", "branchStock", "productImages",
    "productPrices", "productUnits", "productVariants", "products", "categories", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.categories).values([
    { id: 1, name: "قرطاسية" },
    { id: 2, name: "هدايا" },
  ]);
  // ٤ منتجات: دفتر (قسم١، صورة، مخزون٥٠)، قلم مميّز (قسم١، بلا صورة، نافد)، هدية مخفية (قسم٢، مخفيّ)، بلا قسم.
  await d.insert(s.products).values([
    { id: 1, name: "دفتر مدرسي", categoryId: 1, isFeatured: false, showInStore: true },
    { id: 2, name: "قلم مميّز", categoryId: 1, isFeatured: true, showInStore: true },
    { id: 3, name: "هدية مخفية", categoryId: 2, isFeatured: false, showInStore: false },
    { id: 4, name: "سلعة بلا قسم", categoryId: null, isFeatured: false, showInStore: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "V1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "V2", costPrice: "2.00" },
    { id: 3, productId: 3, sku: "V3", costPrice: "10.00" },
    { id: 4, productId: 4, sku: "V4", costPrice: "1.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "قطعة", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "2000.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "300.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 2, branchId: 1, quantity: 0 },
    { variantId: 3, branchId: 1, quantity: 10 },
    { variantId: 4, branchId: 1, quantity: 5 },
  ]);
  await d.insert(s.productImages).values([
    { productId: 1, variantId: null, url: TINY_PNG, isPrimary: true },
    { productId: 4, variantId: null, url: TINY_PNG, isPrimary: true },
  ]);
});

describe("listStoreCatalog — التجميع والترتيب", () => {
  it("يعيد كل المنتجات بحبيبة المنتج، المميّز يتصدّر، مع السعر/المخزون/الصورة الصحيحة", async () => {
    const { rows, total } = await listStoreCatalog({ branchId: 1, limit: 50 });
    expect(total).toBe(4);
    expect(rows).toHaveLength(4);
    expect(rows[0].productId).toBe(2); // المميّز يتصدّر
    expect(rows[0].isFeatured).toBe(true);

    const notebook = rows.find((r) => r.productId === 1)!;
    expect(notebook.categoryName).toBe("قرطاسية");
    expect(notebook.retailPrice).toBe("1000.00");
    expect(notebook.stockBase).toBe(50);
    expect(notebook.hasImage).toBe(true);
    expect(notebook.variantId).toBe(1);

    const pen = rows.find((r) => r.productId === 2)!;
    expect(pen.stockBase).toBe(0);
    expect(pen.hasImage).toBe(false);
  });
});

describe("listStoreCatalog — الفلاتر", () => {
  it("featuredOnly ⇒ المميّز فقط", async () => {
    const { rows, total } = await listStoreCatalog({ branchId: 1, featuredOnly: true });
    expect(total).toBe(1);
    expect(rows.map((r) => r.productId)).toEqual([2]);
  });

  it("hiddenOnly ⇒ المخفيّ فقط", async () => {
    const { rows } = await listStoreCatalog({ branchId: 1, hiddenOnly: true });
    expect(rows.map((r) => r.productId)).toEqual([3]);
  });

  it("missingImageOnly ⇒ المنتجات بلا صورة فقط (٢ و٣)", async () => {
    const { rows } = await listStoreCatalog({ branchId: 1, missingImageOnly: true });
    expect(rows.map((r) => r.productId).sort()).toEqual([2, 3]);
  });

  it("categoryId محدّد ⇒ منتجات القسم فقط", async () => {
    const { rows } = await listStoreCatalog({ branchId: 1, categoryId: 1 });
    expect(rows.map((r) => r.productId).sort()).toEqual([1, 2]);
  });

  it("categoryId=0 ⇒ المنتجات بلا قسم فقط", async () => {
    const { rows } = await listStoreCatalog({ branchId: 1, categoryId: 0 });
    expect(rows.map((r) => r.productId)).toEqual([4]);
  });

  it("البحث بالاسم (q) ⇒ المطابق فقط", async () => {
    const { rows } = await listStoreCatalog({ branchId: 1, q: "دفتر" });
    expect(rows.map((r) => r.productId)).toEqual([1]);
  });
});

describe("setProductFeatured / setProductStoreVisible", () => {
  it("تبديل التمييز يُحفَظ", async () => {
    await setProductFeatured({ productId: 1, isFeatured: true });
    const p = (await db().select({ f: s.products.isFeatured }).from(s.products).where(eq(s.products.id, 1)))[0];
    expect(p.f).toBe(true);
  });

  it("تبديل الإظهار يُحفَظ ولا يمسّ isActive (تفعيل الـERP)", async () => {
    await setProductStoreVisible({ productId: 1, showInStore: false });
    const p = (await db().select({ v: s.products.showInStore, a: s.products.isActive }).from(s.products).where(eq(s.products.id, 1)))[0];
    expect(p.v).toBe(false);
    expect(p.a).toBe(true);
  });

  it("رفض: منتج غير موجود ⇒ NOT_FOUND", async () => {
    await expect(setProductFeatured({ productId: 99999, isFeatured: true })).rejects.toThrow(/غير موجود/);
  });
});

describe("setProductPrimaryImage", () => {
  it("تعيين صورة رئيسية جديدة على مستوى المنتج (variantId=null)", async () => {
    const r = await setProductPrimaryImage({ productId: 2, url: TINY_PNG });
    expect(r.hasImage).toBe(true);
    const imgs = await db().select().from(s.productImages).where(and(eq(s.productImages.productId, 2), isNull(s.productImages.variantId), eq(s.productImages.isPrimary, true)));
    expect(imgs).toHaveLength(1);
  });

  it("استبدال الصورة الحالية (لا تكرار — حذف ثم إدراج)", async () => {
    await setProductPrimaryImage({ productId: 1, url: TINY_PNG });
    const imgs = await db().select().from(s.productImages).where(and(eq(s.productImages.productId, 1), isNull(s.productImages.variantId), eq(s.productImages.isPrimary, true)));
    expect(imgs).toHaveLength(1); // كانت صورة واحدة، بقيت واحدة
  });

  it("url=null ⇒ إزالة الصورة الرئيسية", async () => {
    const r = await setProductPrimaryImage({ productId: 1, url: null });
    expect(r.hasImage).toBe(false);
    const imgs = await db().select().from(s.productImages).where(and(eq(s.productImages.productId, 1), isNull(s.productImages.variantId), eq(s.productImages.isPrimary, true)));
    expect(imgs).toHaveLength(0);
  });

  it("رفض: صورة بصيغة غير صالحة ⇒ BAD_REQUEST", async () => {
    await expect(setProductPrimaryImage({ productId: 1, url: "not-a-data-url" })).rejects.toThrow(/غير صالحة/);
  });
});

describe("setStoreProductStock — ضبط ذرّي + قيد ADJUST", () => {
  it("رفع المخزون ⇒ حركة ADJUST + قيد بإشارة كلفة سالبة (delta×cost)", async () => {
    const r = await setStoreProductStock({ variantId: 2, branchId: 1, targetQuantity: 30, createdBy: 1 });
    expect(r.delta).toBe(30);
    expect(r.newQuantity).toBe(30);

    const stock = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 2), eq(s.branchStock.branchId, 1))))[0];
    expect(stock.q).toBe(30);

    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
    expect(entries).toHaveLength(1);
    expect(entries[0].dedupeKey).toBe(`INV_ADJUST:${r.movementId}`);
    expect(Number(entries[0].cost)).toBe(-60); // 30 × 2.00 مُنفَى
    expect(Number(entries[0].profit)).toBe(60);
  });

  it("خفض المخزون ⇒ delta سالب + كلفة موجبة (استرداد قيمة)", async () => {
    const r = await setStoreProductStock({ variantId: 1, branchId: 1, targetQuantity: 20, createdBy: 1 }); // 50→20
    expect(r.delta).toBe(-30);
    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].cost)).toBe(120); // −(−30 × 4.00) = +120
  });

  it("دلتا صفر (نفس الكمية) ⇒ لا قيد محاسبي", async () => {
    const r = await setStoreProductStock({ variantId: 3, branchId: 1, targetQuantity: 10, createdBy: 1 }); // 10→10
    expect(r.delta).toBe(0);
    const entries = await db().select().from(s.accountingEntries);
    expect(entries).toHaveLength(0);
  });

  it("رفض: كمية سالبة ⇒ خطأ (لا تغيير)", async () => {
    await expect(setStoreProductStock({ variantId: 1, branchId: 1, targetQuantity: -5, createdBy: 1 })).rejects.toThrow();
    const stock = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(stock.q).toBe(50); // بلا تغيير
  });
});
