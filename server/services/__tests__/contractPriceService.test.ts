// بند 12ب (٧/٧): التسعير التعاقدي الخاص بعميل — upsert/تفرّد + resolve + نقطة العرض (POS)
// + الأهم: اختبار تكاملي لمسار البيع الحقيقي (createSale) يثبت أن السعر التعاقدي يُفرَض خادمياً.
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listForPos, lookupByBarcode } from "../catalogService";
import {
  listContractPricesForCustomer,
  removeContractPrice,
  resolveContractPrices,
  setContractPriceActive,
  upsertContractPrice,
} from "../contractPriceService";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };
const BARCODE = "6299999000011";
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  await truncateTables([
    "customerContractPrices", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems",
    "invoices", "branchStock", "productPrices", "productUnits", "productVariants", "products",
    "shifts", "customers", "branches", "users",
  ]);
}

/** بذرة: منتج بوحدة (id=1) سعر مفرد 100، عميلان (1 تعاقدي مستقبلاً، 2 بلا عقد) بلا حدّ ائتمان. */
async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "40.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: BARCODE });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "100.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.customers).values([
    { id: 1, name: "دائرة حكومية", defaultPriceTier: "RETAIL", creditLimit: null },
    { id: 2, name: "عميل عادي", defaultPriceTier: "RETAIL", creditLimit: null },
  ]);
}
beforeEach(async () => { await reset(); await seed(); });

/** بيع آجل (بلا دفعة ⇒ لا وردية) بسطر واحد كمية 2 — بلا unitPriceOverride ليُسعِّر الخادم. */
const creditSale = (customerId: number, extra: Record<string, unknown> = {}) =>
  createSale(
    { branchId: 1, customerId, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], ...extra },
    actor
  );

async function invoiceLine(invoiceId: number) {
  const rows = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("upsert + تفرّد (UNIQUE عميل×وحدة)", () => {
  it("الإدخال الأول ينشئ، والثاني لنفس (العميل، الوحدة) يحدّث بلا صف ثانٍ", async () => {
    const r1 = await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    expect(r1.updated).toBe(false);

    const r2 = await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "75.00", note: "عقد 2026/14" }, actor);
    expect(r2.updated).toBe(true);
    expect(r2.id).toBe(r1.id);

    const rows = await db()
      .select()
      .from(s.customerContractPrices)
      .where(and(eq(s.customerContractPrices.customerId, 1), eq(s.customerContractPrices.productUnitId, 1)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price).toBe("75.00");
    expect(rows[0]!.note).toBe("عقد 2026/14");
  });

  it("إعادة upsert لسعر معطَّل تعيد تفعيله", async () => {
    const r = await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    await setContractPriceActive(r.id, false);
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "82.00" }, actor);
    const rows = await listContractPricesForCustomer(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isActive).toBe(true);
    expect(rows[0]!.price).toBe("82.00");
  });

  it("يرفض سعراً صفراً/سالباً وعميلاً/وحدةً غير موجودَين ووحدةً معطَّلة السلسلة", async () => {
    await expect(upsertContractPrice({ customerId: 1, productUnitId: 1, price: "0" }, actor))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(upsertContractPrice({ customerId: 99, productUnitId: 1, price: "80.00" }, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(upsertContractPrice({ customerId: 1, productUnitId: 99, price: "80.00" }, actor))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    // متغيّر معطَّل ⇒ وحدة سلسلتها ميتة.
    await db().insert(s.productVariants).values({ id: 2, productId: 1, sku: "NB-2", costPrice: "40.00", isActive: false });
    await db().insert(s.productUnits).values({ id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
    await expect(upsertContractPrice({ customerId: 1, productUnitId: 2, price: "80.00" }, actor))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("تعطيل/حذف سعر غير موجود ⇒ NOT_FOUND", async () => {
    await expect(setContractPriceActive(123, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removeContractPrice(123)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("resolveContractPrices", () => {
  it("يعيد النشِط فقط للوحدات المطلوبة (والمعطَّل/عميل آخر لا يتسرّبان)", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    const m1 = await resolveContractPrices(db(), 1, [1, 999]);
    expect(m1.get(1)).toBe("80.00");
    expect(m1.has(999)).toBe(false);

    // عميل آخر: لا شيء.
    const m2 = await resolveContractPrices(db(), 2, [1]);
    expect(m2.size).toBe(0);

    // بعد التعطيل: لا شيء.
    const rows = await listContractPricesForCustomer(1);
    await setContractPriceActive(rows[0]!.id, false);
    const m3 = await resolveContractPrices(db(), 1, [1]);
    expect(m3.size).toBe(0);

    // قائمة فارغة ⇒ خريطة فارغة بلا استعلام.
    expect((await resolveContractPrices(db(), 1, [])).size).toBe(0);
  });
});

describe("نقطة العرض (POS): listForPos/lookupByBarcode مع customerId", () => {
  it("يعرض السعر التعاقدي بعلم isContractPrice للعميل المتعاقد، وسعر الفئة لغيره", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);

    const withContract = await listForPos(1, "RETAIL", undefined, 200, { customerId: 1 });
    const rowC = withContract.find((r) => r.productUnitId === 1)!;
    expect(rowC.price).toBe("80.00");
    expect(rowC.isContractPrice).toBe(true);

    const noCustomer = await listForPos(1, "RETAIL");
    const rowN = noCustomer.find((r) => r.productUnitId === 1)!;
    expect(rowN.price).toBe("100.00");
    expect(rowN.isContractPrice).toBe(false);

    const otherCustomer = await listForPos(1, "RETAIL", undefined, 200, { customerId: 2 });
    const rowO = otherCustomer.find((r) => r.productUnitId === 1)!;
    expect(rowO.price).toBe("100.00");
    expect(rowO.isContractPrice).toBe(false);

    const scanned = await lookupByBarcode(BARCODE, 1, "RETAIL", 1);
    expect(scanned?.price).toBe("80.00");
    expect(scanned?.isContractPrice).toBe(true);

    const scannedPlain = await lookupByBarcode(BARCODE, 1, "RETAIL");
    expect(scannedPlain?.price).toBe("100.00");
    expect(scannedPlain?.isContractPrice).toBe(false);
  });

  it("السعر التعاقدي المعطَّل لا يظهر في العرض", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    const rows = await listContractPricesForCustomer(1);
    await setContractPriceActive(rows[0]!.id, false);
    const posRows = await listForPos(1, "RETAIL", undefined, 200, { customerId: 1 });
    const row = posRows.find((r) => r.productUnitId === 1)!;
    expect(row.price).toBe("100.00");
    expect(row.isContractPrice).toBe(false);
  });
});

describe("نقطة الفرض (تكاملي): createSale الحقيقي يُسعِّر بالسعر التعاقدي", () => {
  it("عميل بسعر تعاقدي 80 ⇒ بند الفاتورة 80×2=160؛ عميل بلا عقد ⇒ 100×2=200", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);

    const sale1 = await creditSale(1);
    expect(sale1.total).toBe("160.00");
    const line1 = await invoiceLine(sale1.invoiceId);
    expect(line1.unitPrice).toBe("80.00");
    expect(line1.total).toBe("160.00");

    const sale2 = await creditSale(2);
    expect(sale2.total).toBe("200.00");
    const line2 = await invoiceLine(sale2.invoiceId);
    expect(line2.unitPrice).toBe("100.00");
  });

  it("السعر التعاقدي المعطَّل لا يسري ⇒ يعود سعر الفئة", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    const rows = await listContractPricesForCustomer(1);
    await setContractPriceActive(rows[0]!.id, false);

    const sale = await creditSale(1);
    expect(sale.total).toBe("200.00");
    expect((await invoiceLine(sale.invoiceId)).unitPrice).toBe("100.00");
  });

  it("المحذوف لا يسري أيضاً", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    const rows = await listContractPricesForCustomer(1);
    await removeContractPrice(rows[0]!.id);
    const sale = await creditSale(1);
    expect(sale.total).toBe("200.00");
  });

  it("override صريح يبقى مقدَّماً على السعر التعاقدي (بنية الأسبقية القائمة: override ← تعاقدي ← فئة)", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    const sale = await creditSale(1, {
      lines: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "90.00" }],
    });
    expect(sale.total).toBe("180.00");
    expect((await invoiceLine(sale.invoiceId)).unitPrice).toBe("90.00");
  });

  it("بيع بلا عميل (نقدي عابر) لا يتأثر بأي عقد", async () => {
    await upsertContractPrice({ customerId: 1, productUnitId: 1, price: "80.00" }, actor);
    // بيع نقدي يحتاج وردية مفتوحة.
    const sr = await db().insert(s.shifts).values({ userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
    const shiftId = Number((sr as any)?.[0]?.insertId ?? (sr as any)?.insertId);
    const sale = await createSale(
      { branchId: 1, sourceType: "POS", shiftId, lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "200.00", method: "CASH" } },
      actor
    );
    expect(sale.total).toBe("200.00");
  });
});
