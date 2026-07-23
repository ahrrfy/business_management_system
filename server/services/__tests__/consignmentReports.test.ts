import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { createSupplier } from "../supplierService";
import { createConsignmentNote, consignmentBalancesReport, consignmentMarginsReport, consignmentSettlementStatement } from "../consignment/noteService";
import { getInventoryValuation } from "../reportsInventoryService";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";

/** بضاعة الأمانة — ش٤: الأمانة خارج تقييم أصول المكتبة (تُعرَض سطراً منفصلاً) + تقرير الأرصدة + الهوامش. §١١. */
const actor = { userId: 1, branchId: 1 };
const TABLES = [
  "accountingEntries", "receipts", "idempotencyKeys", "invoiceItems", "invoices", "shifts",
  "inventoryMovements", "consignmentNoteLines", "consignmentNotes",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "customers", "suppliers", "categories", "users", "branches",
];
const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId);
async function openShift() { return insertId(await db().insert(s.shifts).values({ branchId: 1, userId: 1, openingBalance: "0", status: "OPEN" })); }
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
async function seedBase() {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "SALES", code: "SALES", type: "SALES" }]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
}
beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

describe("بضاعة الأمانة ش٤ — استثناء التقييم", () => {
  it("صنف أمانة مودَع لا يدخل مجموع تقييم الأصول، ويظهر في السطر المنفصل + تقرير الأرصدة", async () => {
    // منتج مملوك برصيد افتتاحي (أصل مكتبة).
    await createProduct({ name: "قلم", variants: [{ sku: "OWN-1", costPrice: "100", openingStock: 10,
      units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "200" }] }] }] }, actor);
    // مودِع + صنف أمانة + إيداع 20 (حصة 4000).
    const cid = (await createSupplier({ name: "أ. حيدر", supplierKind: "CONSIGNOR" }, actor)).supplierId;
    await createProduct({ name: "ملزمة", isConsignment: true, consignorId: cid,
      variants: [{ sku: "MLZ-1", costPrice: "4000", units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: "5000" }] }] }] }, actor);
    const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "MLZ-1")))[0];
    const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
    await createConsignmentNote({ noteType: "DEPOSIT", consignorId: cid, branchId: 1,
      lines: [{ lineDirection: "IN", variantId: Number(v.id), productUnitId: Number(u.id), quantity: "20" }] }, actor);

    const val = await getInventoryValuation({});
    // مجموع الأصول = المملوك فقط (10 × 100 = 1000) — لا يتضمّن الأمانة (20 × 4000 = 80000).
    expect(val.totals.totalValue).toBe("1000.00");
    // الأمانة سطر منفصل.
    expect(val.consignment.totalValue).toBe("80000.00");
    expect(val.consignment.totalQty).toBe(20);

    // تقرير الأرصدة: المودِع له 20 قطعة بقيمة 80000 بالحصة.
    const bal = await consignmentBalancesReport();
    const row = bal.find((r) => r.consignorId === cid)!;
    expect(row.remainingQty).toBe(20);
    expect(row.remainingValueByShare).toBe("80000.00");
  });
});

// ── ش٤: تقرير هوامش الأمانة (ربح المكتبة المُحقَّق من بيع بضاعة المودِع) ──
const WIDE = { startDate: "2020-01-01", endDate: "2099-12-31" };
async function mkConsignor(name = "أ. حيدر") { return (await createSupplier({ name, supplierKind: "CONSIGNOR" }, actor)).supplierId; }
async function mkConsignProduct(consignorId: number, share = "4000", sell = "5000") {
  const sku = `MLZ-${Math.random().toString(36).slice(2, 7)}`;
  await createProduct({ name: "ملزمة", isConsignment: true, consignorId,
    variants: [{ sku, costPrice: share, units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: sell }] }] }] }, actor);
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
  const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
  return { variantId: Number(v.id), productUnitId: Number(u.id) };
}
async function ownedProduct(cost = "900", sell = "1850") {
  const sku = `OWN-${Math.random().toString(36).slice(2, 7)}`;
  await createProduct({ name: "قلم", variants: [{ sku, costPrice: cost, openingStock: 100, units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: sell }] }] }] }, actor);
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
  const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
  return { variantId: Number(v.id), productUnitId: Number(u.id) };
}
async function depositC(consignorId: number, variantId: number, productUnitId: number, qty: string) {
  await createConsignmentNote({ noteType: "DEPOSIT", consignorId, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: qty }] }, actor);
}

describe("بضاعة الأمانة ش٤ — تقرير الهوامش", () => {
  it("بيع صنف أمانة ⇒ هامش المكتبة = الإيراد − الحصة (3 × [5000−4000] = 3000) + نسبة 20٪", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);

    // تأكيد نموذج البيانات: سطر الفاتورة يحمل الحصة في unitCost (4000/وحدة أساس) — أساس حساب الهامش.
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.variantId, variantId)))[0];
    expect(item.unitCost).toBe("4000.00");
    expect(item.total).toBe("15000.00");

    const rep = await consignmentMarginsReport(WIDE);
    expect(rep.rows).toHaveLength(1);
    const r = rep.rows[0];
    expect(r.consignorId).toBe(cid);
    expect(r.soldQty).toBe(3);
    expect(r.soldValue).toBe("15000.00");
    expect(r.consignorShare).toBe("12000.00");
    expect(r.libraryMargin).toBe("3000.00");
    expect(r.marginPct).toBe("20.00");
    expect(rep.totals.libraryMargin).toBe("3000.00");
    expect(rep.totals.soldValue).toBe("15000.00");
  });

  it("الهامش صافٍ من المرتجعات: بيع 3 ثم إرجاع 1 ⇒ صافي 2 (إيراد 10000 − حصة 8000 = هامش 2000)", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    const sale = await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "5000", method: "CASH" }, restock: true }, actor);

    const rep = await consignmentMarginsReport(WIDE);
    expect(rep.rows).toHaveLength(1);
    const r = rep.rows[0];
    expect(r.soldQty).toBe(2); // 3 − 1 مُرتجَع
    expect(r.soldValue).toBe("10000.00"); // 15000 × 2/3
    expect(r.consignorShare).toBe("8000.00"); // 4000 × 2
    expect(r.libraryMargin).toBe("2000.00");
    expect(r.marginPct).toBe("20.00");
  });

  it("فلتر التاريخ: نطاقٌ منقضٍ لا يشمل البيع ⇒ صفر صفوف وإجماليات صفرية", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);

    const rep = await consignmentMarginsReport({ startDate: "2019-01-01", endDate: "2020-01-01" });
    expect(rep.rows).toHaveLength(0);
    expect(rep.totals.libraryMargin).toBe("0.00");
    expect(rep.totals.soldValue).toBe("0.00");
  });

  it("فلتر الفرع: البيع على الفرع 1 لا يظهر عند تصفية الفرع 2", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);

    expect((await consignmentMarginsReport({ ...WIDE, branchId: 2 })).rows).toHaveLength(0);
    expect((await consignmentMarginsReport({ ...WIDE, branchId: 1 })).rows).toHaveLength(1);
  });

  it("سلة مختلطة: يظهر سطر الأمانة فقط، والمملوك مُستبعَد (الهامش من الأمانة حصراً)", async () => {
    const cid = await mkConsignor();
    const cp = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, cp.variantId, cp.productUnitId, "10");
    const own = await ownedProduct("900", "1850");
    const shiftId = await openShift();
    await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [
        { variantId: own.variantId, productUnitId: own.productUnitId, quantity: "1" },
        { variantId: cp.variantId, productUnitId: cp.productUnitId, quantity: "1" },
      ], payment: { amount: "6850", method: "CASH" } }, actor);

    const rep = await consignmentMarginsReport(WIDE);
    expect(rep.rows).toHaveLength(1); // المملوك لا يظهر
    expect(rep.rows[0].consignorId).toBe(cid);
    expect(rep.rows[0].soldValue).toBe("5000.00"); // سطر الأمانة فقط (لا 1850 المملوك)
    expect(rep.rows[0].libraryMargin).toBe("1000.00"); // 5000 − 4000
  });
});

describe("بضاعة الأمانة ش٥ — كشف تسوية المودِع (قراءة فقط)", () => {
  it("كشف مودِع بعد بيع 3 (من 10 مودَعة): ترويسة + سطر صنف + متبقٍّ 7", async () => {
    const cid = await mkConsignor("أ. سالم");
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);

    const st = (await consignmentSettlementStatement({ consignorId: cid, ...WIDE }))!;
    expect(st).not.toBeNull();
    expect(st.consignorName).toBe("أ. سالم");
    expect(st.currentOwed).toBe("12000.00"); // AP الحاليّ = الحصة المُستحقّة عن المبيع
    // إجماليات الفترة (net).
    expect(st.period.soldQty).toBe(3);
    expect(st.period.soldValue).toBe("15000.00");
    expect(st.period.share).toBe("12000.00");
    expect(st.period.margin).toBe("3000.00");
    expect(st.period.marginPct).toBe("20.00");
    // سطر الصنف المُباع.
    expect(st.lines).toHaveLength(1);
    expect(st.lines[0].soldQty).toBe(3);
    expect(st.lines[0].margin).toBe("3000.00");
    // المتبقّي الحيّ = 10 − 3 = 7 بقيمة 7×4000 = 28000 بالحصّة.
    expect(st.remaining.qty).toBe(7);
    expect(st.remaining.valueByShare).toBe("28000.00");
  });

  it("الكشف صافٍ من المرتجعات: بيع 3 ثم إرجاع 1 ⇒ الفترة تعكس صافي 2 والمتبقّي يعود 8", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    const sale = await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "5000", method: "CASH" }, restock: true }, actor);

    const st = (await consignmentSettlementStatement({ consignorId: cid, ...WIDE }))!;
    expect(st.period.soldQty).toBe(2);
    expect(st.period.soldValue).toBe("10000.00");
    expect(st.period.margin).toBe("2000.00");
    expect(st.currentOwed).toBe("8000.00"); // 12000 − 4000 (عكس المرتجع)
    expect(st.remaining.qty).toBe(8); // 10 − 3 + 1 restock
  });

  it("مودِع بلا مبيعات في الفترة: كشفٌ بلا أسطر وإجماليات صفرية + متبقٍّ يعكس المُودَع", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await depositC(cid, variantId, productUnitId, "5");
    const st = (await consignmentSettlementStatement({ consignorId: cid, ...WIDE }))!;
    expect(st.lines).toHaveLength(0);
    expect(st.period.soldValue).toBe("0.00");
    expect(st.currentOwed).toBe("0.00");
    expect(st.remaining.qty).toBe(5);
    expect(st.remaining.valueByShare).toBe("20000.00");
  });

  it("مورّد اعتياديّ (ليس مودِعاً) ⇒ null (لا كشف أمانة)", async () => {
    const reg = (await createSupplier({ name: "مورّد عاديّ", supplierKind: "REGULAR" }, actor)).supplierId;
    expect(await consignmentSettlementStatement({ consignorId: reg, ...WIDE })).toBeNull();
  });
});
