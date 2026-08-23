// عرض البدائل (ALTERNATIVE) في واجهة المتجر (وثيقة «الجرد بالباركود» — تحسين عرض البدائل ٢٣/٨).
//
// البديل منتجٌ مختلفٌ حقيقيّ (ماركة/منشأ) يُباع تحت اسمٍ واحد، لكلٍّ مخزونه وسعره وباركوده. يجب أن
// يظهر في التفاصيل بماركته المميّزة (variantName + شارة)، وأن تُوسَم بطاقة الشبكة بـhasAlternatives.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { storefrontCatalog, storefrontProduct } from "../storefrontService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables([
    "invoiceItems", "onlineOrderItems", "onlineOrders", "customers", "reservationStock",
    "bundleComponents", "branchStock", "productImages", "productPrices", "productUnits",
    "productVariants", "products", "categories", "branches",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await d.insert(s.products).values([
    // (1) منتجٌ باسمٍ واحد تحته متغيّرٌ مدمج + بديلٌ حقيقيّ (ماركة مختلفة).
    { id: 1, name: "دفتر ٤٠ ورقة", categoryId: 1, showInStore: true },
    // (2) منتجٌ عاديّ بلا بدائل — ضابط.
    { id: 2, name: "قلم رصاص", categoryId: 1, showInStore: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB40", costPrice: "1.00", variantKind: "VARIANT" },
    { id: 2, productId: 1, sku: "NB40-ALT2", costPrice: "1.00", variantKind: "ALTERNATIVE", variantName: "ماركة النسر" },
    { id: 3, productId: 2, sku: "PENCIL", costPrice: "1.00", variantKind: "VARIANT" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "BC-NB40" },
    { id: 2, variantId: 2, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "BC-ALT" },
    { id: 3, variantId: 3, unitName: "قطعة", isBaseUnit: true, isStoreSaleUnit: true, barcode: "BC-PENCIL" },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1250.00" }, // البديل بسعره الخاص
    { productUnitId: 3, priceTier: "RETAIL", price: "500.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 5 },
    { variantId: 2, branchId: 1, quantity: 3 }, // للبديل مخزونه المستقلّ
    { variantId: 3, branchId: 1, quantity: 4 },
  ]);
});

describe("عرض البدائل في المتجر", () => {
  it("تفاصيل المنتج: يُظهر البديل بماركته وسعره ومخزونه المستقلّ ويضبط hasAlternatives", async () => {
    const product = await storefrontProduct(1, 1);
    expect(product).not.toBeNull();
    expect(product!.hasAlternatives).toBe(true);

    const alt = product!.variants!.find((v) => v.variantId === 2)!;
    expect(alt.variantKind).toBe("ALTERNATIVE");
    expect(alt.variantName).toBe("ماركة النسر");
    expect(alt.label).toBe("ماركة النسر"); // الاسم المميّز يظهر كعنوان الخيار
    expect(alt.inStock).toBe(true);
    // للبديل وحدته وسعره الخاصّان (لا سعر الأصل).
    expect(alt.units[0]?.price).toBe("1250.00");

    // المتغيّر المدمج يبقى VARIANT.
    const base = product!.variants!.find((v) => v.variantId === 1)!;
    expect(base.variantKind).toBe("VARIANT");
  });

  it("الشبكة: بطاقة المنتج ذي البديل تحمل hasAlternatives، والعاديّ لا", async () => {
    const catalog = await storefrontCatalog({ branchId: 1, limit: 20 });
    const withAlt = catalog.items.find((i) => i.productId === 1);
    const plain = catalog.items.find((i) => i.productId === 2);
    expect(withAlt?.hasAlternatives).toBe(true);
    expect(plain?.hasAlternatives).toBe(false);
  });

  it("بديلٌ نافدٌ يظهر في التفاصيل بماركته لكن inStock=false (لا يُخفى صامتاً)", async () => {
    await db().update(s.branchStock).set({ quantity: 0 }).where(eq(s.branchStock.variantId, 2));
    const product = await storefrontProduct(1, 1);
    const alt = product!.variants!.find((v) => v.variantId === 2)!;
    expect(alt.variantName).toBe("ماركة النسر");
    expect(alt.inStock).toBe(false);
    // المنتج نفسه يبقى متوفّراً عبر متغيّره المدمج، وشارة البدائل تبقى.
    expect(product!.hasAlternatives).toBe(true);
  });
});
