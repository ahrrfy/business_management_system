import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { createPurchaseOrder } from "../purchaseService";
import { replaceBundleComponents } from "../bundleService";
import { withTx } from "../tx";
import { createSupplier, deactivateSupplier, listSuppliers, updateSupplier } from "../supplierService";

/**
 * بضاعة الأمانة — ش١: اختبارات الأساس والحراس التسعة ذات الصلة بالإنشاء.
 * راجع docs/consignment-design-2026-07-20.md §٥-ط + §١٢.
 */

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "idempotencyKeys",
  "branchStock", "bundleComponents", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "productImages", "products",
  "purchaseOrderItems", "purchaseOrders",
  "auditLogs", "customers", "suppliers", "categories",
  "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

/** مودِع أمانة سريع. */
async function mkConsignor(name = "أ. حيدر") {
  const { supplierId } = await createSupplier({ name, supplierKind: "CONSIGNOR" }, actor);
  return supplierId;
}
/** مورّد اعتيادي سريع. */
async function mkRegular(name = "مورّد ورق") {
  const { supplierId } = await createSupplier({ name }, actor);
  return supplierId;
}
/** منتج أمانة بسيط بمتغيّر واحد. */
function consignProductInput(consignorId: number, share = "4000", opening?: number) {
  return {
    name: "ملزمة فيزياء",
    isConsignment: true,
    consignorId,
    variants: [{
      sku: `MLZ-${Math.random().toString(36).slice(2, 7)}`,
      costPrice: share,
      openingStock: opening,
      units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "5000" }] }],
    }],
  };
}
async function baseVariantId(sku: string) {
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
  const u = (await db().select().from(s.productUnits).where(and(eq(s.productUnits.variantId, Number(v.id)), eq(s.productUnits.isBaseUnit, true))))[0];
  return { variantId: Number(v.id), productUnitId: Number(u.id) };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("بضاعة الأمانة ش١ — المودِع", () => {
  it("إنشاء مودِع بنوع CONSIGNOR + حقول الاتفاقية تُخزَّن، وفلتر النوع يعزل", async () => {
    const cid = await createSupplier(
      { name: "أ. زينب", supplierKind: "CONSIGNOR", settlementCycle: "WEEKLY", abandonedAfterMonths: 6, agreementNotes: "تلف على المكتبة" },
      actor,
    );
    const row = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, cid.supplierId)))[0];
    expect(row.supplierKind).toBe("CONSIGNOR");
    expect(row.settlementCycle).toBe("WEEKLY");
    expect(row.abandonedAfterMonths).toBe(6);
    // افتراضات المودِع الجديد بلا حقول اتفاقية.
    await mkRegular("مورّد عادي");
    const consignors = await listSuppliers({ kind: "CONSIGNOR" });
    expect(consignors.rows.every((r) => r.supplierKind === "CONSIGNOR")).toBe(true);
    expect(consignors.rows.some((r) => r.name === "أ. زينب")).toBe(true);
    const regulars = await listSuppliers({ kind: "REGULAR" });
    expect(regulars.rows.some((r) => r.name === "مورّد عادي")).toBe(true);
    expect(regulars.rows.some((r) => r.supplierKind === "CONSIGNOR")).toBe(false);
  });

  it("افتراض المودِع الجديد: abandonedAfterMonths=12 و settlementCycle=MONTHLY", async () => {
    const { supplierId } = await createSupplier({ name: "مودِع افتراضي", supplierKind: "CONSIGNOR" }, actor);
    const row = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)))[0];
    expect(row.abandonedAfterMonths).toBe(12);
    expect(row.settlementCycle).toBe("MONTHLY");
  });
});

describe("بضاعة الأمانة ش١ — حراس المنتج (§٥-ط ٧+٨)", () => {
  it("منتج أمانة صالح بمودِع CONSIGNOR وحصة موجبة يُنشأ", async () => {
    const cid = await mkConsignor();
    const r = await createProduct(consignProductInput(cid), actor);
    const p = (await db().select().from(s.products).where(eq(s.products.id, r.productId)))[0];
    expect(p.isConsignment).toBe(true);
    expect(Number(p.consignorId)).toBe(cid);
  });

  it("أمانة بلا مودِع تُرفض (التلازم)", async () => {
    await expect(
      createProduct({ name: "ملزمة", isConsignment: true, consignorId: null, variants: [{ sku: "X1", costPrice: "4000", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }] }] }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("مودِع بلا وسم أمانة يُرفض (التلازم العكسي)", async () => {
    const cid = await mkConsignor();
    await expect(
      createProduct({ name: "ملزمة", isConsignment: false, consignorId: cid, variants: [{ sku: "X2", costPrice: "4000", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }] }] }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("مودِع من نوع REGULAR يُرفض كمودِع أمانة", async () => {
    const rid = await mkRegular();
    await expect(createProduct(consignProductInput(rid), actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("حصة صفرية تُرفض (الحصة إلزامية > 0)", async () => {
    const cid = await mkConsignor();
    await expect(createProduct(consignProductInput(cid, "0"), actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("منتج خدمي لا يكون أمانة", async () => {
    const cid = await mkConsignor();
    await expect(
      createProduct({ ...consignProductInput(cid), isService: true }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("بضاعة الأمانة ش١ — حارس الشراء (§٥-ط ١، ازدواج AP)", () => {
  it("أمر شراء لمورّد CONSIGNOR يُرفض", async () => {
    const cid = await mkConsignor();
    // نحتاج متغيّراً اعتيادياً لبند الشراء (الرفض على مستوى نوع المورّد قبل فحص البنود).
    const reg = await createProduct({ name: "ورق", variants: [{ sku: "PPR-1", costPrice: "100", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }] }] }, actor);
    const { variantId, productUnitId } = await baseVariantId("PPR-1");
    void reg;
    await expect(
      createPurchaseOrder({ supplierId: cid, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId, productUnitId, quantity: "10", unitPrice: "100" }] }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("أمر شراء يحوي صنف أمانة يُرفض (حتى لمورّد اعتيادي)", async () => {
    const cid = await mkConsignor();
    const rid = await mkRegular();
    const cp = await createProduct(consignProductInput(cid), actor);
    const sku = (await db().select({ sku: s.productVariants.sku }).from(s.productVariants).where(eq(s.productVariants.productId, cp.productId)))[0].sku!;
    const { variantId, productUnitId } = await baseVariantId(sku);
    await expect(
      createPurchaseOrder({ supplierId: rid, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId, productUnitId, quantity: "10", unitPrice: "100" }] }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("بضاعة الأمانة ش١ — حارس البكج (§٥-ط ٢)", () => {
  it("صنف أمانة لا يُضمَّن في بكج", async () => {
    const cid = await mkConsignor();
    const cp = await createProduct(consignProductInput(cid), actor);
    const sku = (await db().select({ sku: s.productVariants.sku }).from(s.productVariants).where(eq(s.productVariants.productId, cp.productId)))[0].sku!;
    const { variantId } = await baseVariantId(sku);
    // بكج مضيف
    const bundle = await createProduct({
      name: "بكج قرطاسية", isBundle: true,
      bundleComponents: [{ componentVariantId: variantId, componentBaseQuantity: 1 }],
      variants: [{ sku: "BND-1", costPrice: "0", units: [{ unitName: "طقم", conversionFactor: "1", isBaseUnit: true }] }],
    }, actor).catch((e) => e);
    // الإنشاء نفسه يجب أن يُرفض لأن مكوّنه صنف أمانة.
    expect(bundle).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("بضاعة الأمانة ش١ — قفل نوع الحساب وحارس التعطيل (§٥-ز/§٨)", () => {
  it("تحويل نوع مودِع له صنف أمانة مربوط يُرفض", async () => {
    const cid = await mkConsignor();
    await createProduct(consignProductInput(cid), actor);
    await expect(updateSupplier({ supplierId: cid, supplierKind: "REGULAR" }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("تحويل نوع مودِع بلا أي حركة مسموح", async () => {
    const cid = await mkConsignor("مودِع بلا حركة");
    const res = await updateSupplier({ supplierId: cid, supplierKind: "REGULAR" }, actor);
    expect(res.changed).toBe(true);
    const row = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, cid)))[0];
    expect(row.supplierKind).toBe("REGULAR");
  });

  it("تعطيل مودِع له بضاعة متبقية على الرف يُرفض", async () => {
    const cid = await mkConsignor();
    await createProduct(consignProductInput(cid, "4000", 10), actor); // رصيد افتتاحي ١٠
    await expect(deactivateSupplier(cid, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("تعطيل مودِع بلا بضاعة ولا رصيد مسموح", async () => {
    const cid = await mkConsignor("مودِع فارغ");
    const res = await deactivateSupplier(cid, actor);
    expect(res.isActive).toBe(false);
  });
});
