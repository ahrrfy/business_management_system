/**
 * سلطة التسعير اليدويّ — H6 (تدقيق ٢٧/٧) وذيلُ H7.
 *
 * الخادم كان يقبل `unitPriceOverride` و`discountAmount` كما هما (يقصّهما إلى `[0, gross]` فقط)،
 * فالضابط الوحيد كان **البيع تحت التكلفة**: بندٌ سعره ٥٠٠٠ وتكلفته ١٠٠٠ يُباع بـ١٠٠١ (تنازلٌ عن
 * ٣٩٩٩) بلا اعتمادٍ ولا حتى وسمِ تدقيق. أُغلق ذلك على **مستوى السطر** في مسار البيع سلفاً بعتبة
 * ١٥٪ (قرار المالك). وهذه الحزمة تُغطّي ما بقي مفتوحاً:
 *
 *  ١) **خصم رأس الفاتورة** كان يفلت من بوّابة السطر كلّياً (يُقصّ إلى `[0, subtotal]` وحسب).
 *  ٢) **قناة الطباعة** كانت تحرس تحت-التكلفة وحدها ⇒ سياستان مختلفتان لنفس القرار الماليّ.
 *  ٣) **ذيل H7**: بندٌ بلا سعرٍ مرجعيّ يفلت من البوّابتين — مُوثَّقٌ هنا بوصفه حدّاً معروفاً.
 */
import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  MANUAL_DISCOUNT_APPROVAL_THRESHOLD,
  invoiceDiscountExceedsThreshold,
  lineDiscountExceedsThreshold,
} from "../billing";
import { createPrintSale } from "../printSaleService";
import { createSale } from "../sale/create";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const cashier = { userId: 1, branchId: 1, role: "cashier" } as const;

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "c1", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 });
  await d.insert(s.products).values([
    { id: 1, name: "دفتر" },
    { id: 2, name: "خدمة طباعة", productType: "PRINT_SERVICE", isService: true },
    { id: 3, name: "صنفٌ بلا سعر قائمة" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "PR-1", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "NP-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  // سعر القائمة ١٠٠٠ وتكلفة ١٠٠ ⇒ متّسعٌ واسع فوق التكلفة: البوّابة الوحيدة الممكنة هي الانحراف.
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل آجل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: "1000000" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.shifts).values({
    id: 1, userId: 1, branchId: 1, status: "OPEN", shiftType: "RETAIL",
    openingBalance: "0", openGuard: "1:1:RETAIL",
  });
  await d.insert(s.shifts).values({
    id: 2, userId: 1, branchId: 1, status: "OPEN", shiftType: "PRINT_SERVICES",
    openingBalance: "0", openGuard: "1:1:PRINT_SERVICES",
  });
}

let req = 0;
const nextReq = () => `mpa-${++req}`;

function saleInput(over: Partial<Parameters<typeof createSale>[0]> = {}) {
  return {
    branchId: 1,
    shiftId: 1,
    sourceType: "ORDER" as const,
    // بلا دفعٍ = بيعٌ آجل ⇒ يلزمه عميل. البوّابة المقيسة هنا هي التسعير لا السداد.
    customerId: 1,
    clientRequestId: nextReq(),
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    ...over,
  } as Parameters<typeof createSale>[0];
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
  req = 0;
});

describe("العتبة نفسها — حسابٌ نقيّ", () => {
  it("عتبة المالك ١٥٪، والمقارنة صارمة (المساوي يمرّ)", () => {
    expect(MANUAL_DISCOUNT_APPROVAL_THRESHOLD).toBe(0.15);
    // انحرافٌ ١٥٪ بالضبط ⇒ يمرّ؛ وأكثر منه بقليل ⇒ يُمسَك.
    expect(lineDiscountExceedsThreshold(new Decimal(1000), new Decimal(1), "850.00")).toBe(false);
    expect(lineDiscountExceedsThreshold(new Decimal(1000), new Decimal(1), "849.99")).toBe(true);
    expect(invoiceDiscountExceedsThreshold(new Decimal(1000), "850.00")).toBe(false);
    expect(invoiceDiscountExceedsThreshold(new Decimal(1000), "849.99")).toBe(true);
  });

  it("بلا مرجعٍ موجب ⇒ لا قياس (ذيل H7 لا H6)", () => {
    expect(lineDiscountExceedsThreshold(new Decimal(0), new Decimal(3), "0.00")).toBe(false);
    expect(invoiceDiscountExceedsThreshold(new Decimal(0), "0.00")).toBe(false);
  });

  it("البيع فوق المرجع لا يستوجب تفويضاً (انحرافٌ سالب)", () => {
    expect(lineDiscountExceedsThreshold(new Decimal(1000), new Decimal(1), "1200.00")).toBe(false);
    expect(invoiceDiscountExceedsThreshold(new Decimal(1000), "1200.00")).toBe(false);
  });
});

describe("خصم رأس الفاتورة — النصف الذي كان يفلت", () => {
  it("خصمٌ فاتوريّ ٤٠٪ فوق التكلفة يُرفَض بلا اعتماد", async () => {
    await expect(
      createSale(saleInput({ invoiceDiscount: "400.00" }), cashier),
    ).rejects.toThrow(/خصم الفاتورة يتجاوز ١?15٪|خصم الفاتورة يتجاوز/);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });

  it("ويمرّ باعتماد المدير (نفس مفتاح تحت-التكلفة)", async () => {
    const res = await createSale(
      saleInput({ invoiceDiscount: "400.00", priceOverrideApproved: true }),
      cashier,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
    // الوسم التدقيقيّ يُرفَع للتنازل فوق التكلفة أيضاً — لا للتحت-التكلفة وحده.
    expect(res.priceOverride).toBe(true);
  });

  it("خصمٌ في حدود العتبة يمرّ بلا اعتماد", async () => {
    const res = await createSale(saleInput({ invoiceDiscount: "150.00" }), cashier);
    expect(res.invoiceId).toBeGreaterThan(0);
    expect(res.priceOverride).toBe(false);
  });

  it("خصمُ الرأس وخصمُ السطر يتراكمان في القياس — لا يتهرّب أحدهما بالآخر", async () => {
    // سطرٌ بخصم ١٠٪ (٩٠٠) ثمّ خصم رأسٍ ١٠٠ ⇒ الصافي ٨٠٠ من مرجع ١٠٠٠ = انحراف ٢٠٪.
    await expect(
      createSale(
        saleInput({
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "100.00" }],
          invoiceDiscount: "100.00",
        }),
        cashier,
      ),
    ).rejects.toThrow(/يتطلب موافقة مدير/);
  });
});

describe("قناة الطباعة — إنهاء انجراف السياسة بين القناتين", () => {
  function printInput(unitPrice: string) {
    return {
      branchId: 1,
      shiftId: 2,
      customerId: 1,
      clientRequestId: nextReq(),
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1", unitPriceOverride: unitPrice }],
    } as Parameters<typeof createPrintSale>[0];
  }

  it("سعرٌ يدويّ ينحرف ٥٠٪ عن القائمة يُرفَض — وكان يمرّ لأنّه فوق التكلفة", async () => {
    await expect(createPrintSale(printInput("500.00"), cashier)).rejects.toThrow(
      /خصمٌ يتجاوز .*٪ عن السعر المرجعيّ يتطلب موافقة مدير/,
    );
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });

  it("ويمرّ باعتماد المدير مع وسمٍ تدقيقيّ", async () => {
    const res = await createPrintSale(
      { ...printInput("500.00"), priceOverrideApproved: true } as Parameters<typeof createPrintSale>[0],
      cashier,
    );
    expect(res.priceOverride).toBe(true);
  });

  it("سعرٌ في حدود العتبة يمرّ بلا اعتماد ولا وسم", async () => {
    const res = await createPrintSale(printInput("900.00"), cashier);
    expect(res.priceOverride).toBe(false);
  });
});

/** حدٌّ معروفٌ مُوثَّق: بلا سعرٍ مرجعيّ لا قياسَ انحراف — وهو ذيل H7 لا H6. */
describe("ذيل H7 — البند بلا مرجع", () => {
  it("صنفٌ بلا سعر قائمة وتكلفته صفر يمرّ بأيّ سعر (حدٌّ معروف يلزمه قرار سياسة)", async () => {
    await db().insert(s.branchStock).values({ variantId: 3, branchId: 1, quantity: 10 });
    const res = await createSale(
      saleInput({ lines: [{ variantId: 3, productUnitId: 3, quantity: "1", unitPriceOverride: "0.00" }] }),
      cashier,
    );
    expect(res.invoiceId).toBeGreaterThan(0);
    expect(res.priceOverride).toBe(false);
  });
});
