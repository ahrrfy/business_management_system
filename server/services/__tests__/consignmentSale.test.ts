import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { createSupplier } from "../supplierService";
import { createConsignmentNote } from "../consignment/noteService";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { replayOfflineSale } from "../offline/replaySale";
import { computeNetSalesByUser } from "../commissions/base";

/**
 * بضاعة الأمانة — ش٣: الثوابت المالية الحرجة (الالتقاط عند البيع + عكس المرتجع + استثناء العمولة).
 * راجع docs/consignment-design-2026-07-20.md §١٢.
 */
const actor = { userId: 1, branchId: 1 };
const TABLES = [
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys",
  "consignmentNoteLines", "consignmentNotes",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "shifts", "auditLogs", "customers", "suppliers", "categories", "users", "branches",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId);

async function seedBase() {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "SALES", code: "SALES", type: "SALES" }]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "بائع", role: "cashier", loginMethod: "local", branchId: 1 });
}
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
async function deposit(consignorId: number, variantId: number, productUnitId: number, qty: string) {
  await createConsignmentNote({ noteType: "DEPOSIT", consignorId, branchId: 1, lines: [{ lineDirection: "IN", variantId, productUnitId, quantity: qty }] }, actor);
}
async function openShift() { return insertId(await db().insert(s.shifts).values({ branchId: 1, userId: 1, openingBalance: "0", status: "OPEN" })); }
async function entries(type: string) { return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, type as any)); }
async function balance(id: number) { return (await db().select().from(s.suppliers).where(eq(s.suppliers.id, id)))[0].currentBalance; }

beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

describe("بضاعة الأمانة ش٣ — الالتقاط عند البيع", () => {
  it("بيع صنف أمانة: قيد SALE كامل + استحقاق PURCHASE يتيم + رصيد المودِع +الحصة + الربح=الهامش", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    const sale = await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: "3" }], payment: { amount: "15000", method: "CASH" } }, actor);
    // قيد SALE لم يُمسّ: revenue كامل، الربح = الهامش (15000 − 12000 = 3000).
    const saleE = (await entries("SALE"))[0];
    expect(saleE.revenue).toBe("15000.00");
    expect(saleE.cost).toBe("12000.00");
    expect(saleE.profit).toBe("3000.00");
    // استحقاق الأمانة: PURCHASE يتيم بـinvoiceId + supplierId + amount=الحصة، صفر P&L.
    const pe = await entries("PURCHASE");
    expect(pe).toHaveLength(1);
    expect(pe[0].amount).toBe("12000.00");
    expect(Number(pe[0].invoiceId)).toBe(sale.invoiceId);
    expect(Number(pe[0].supplierId)).toBe(cid);
    expect(pe[0].revenue).toBe("0.00");
    expect(pe[0].dedupeKey).toBe(`CONSIG:${sale.invoiceId}:${cid}`);
    expect(await balance(cid)).toBe("12000.00");
  });

  it("سلة مختلطة (مملوك + أمانة): يُخصَم حصص الأمانة فقط + وعاء البائع = الهامش", async () => {
    const cid = await mkConsignor();
    const cp = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, cp.variantId, cp.productUnitId, "10");
    const own = await ownedProduct("900", "1850");
    const shiftId = await openShift();
    await createSale({ branchId: 1, shiftId, priceTier: "RETAIL", sourceType: "POS",
      lines: [{ variantId: own.variantId, productUnitId: own.productUnitId, quantity: "1" }, { variantId: cp.variantId, productUnitId: cp.productUnitId, quantity: "1" }],
      payment: { amount: "6850", method: "CASH" } }, actor);
    // استحقاق أمانة = 4000 (صنف واحد). رصيد المودِع 4000.
    expect(await balance(cid)).toBe("4000.00");
    // وعاء البائع = SALE.revenue (6850) − consigDeduction (4000) = 2850 (هامش المملوك 950 + هامش الأمانة 1000 + ... فعلياً 6850−4000).
    const pool = await computeNetSalesByUser(db(), period());
    const b = pool.get(1)!;
    expect(b.sales.toFixed(2)).toBe("6850.00");
    expect(b.consigDeduction.toFixed(2)).toBe("4000.00");
    expect(b.sales.minus(b.returns).minus(b.consigDeduction).toFixed(2)).toBe("2850.00");
  });
});

describe("بضاعة الأمانة ش٣ — عكس المرتجع", () => {
  it("مرتجع كامل restock: عكس الالتزام + رصيد المودِع 0 + صافي وعاء البائع 0", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    const sale = await createSale({ branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
      lines: [{ variantId, productUnitId, quantity: "2" }], payment: { amount: "10000", method: "CASH" } }, actor);
    expect(await balance(cid)).toBe("8000.00");
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }], refund: { amount: "10000", method: "CASH" }, restock: true }, actor);
    expect(await balance(cid)).toBe("0.00"); // الالتزام عُكس بالكامل
    const pool = await computeNetSalesByUser(db(), period());
    const b = pool.get(1)!;
    // صافي وعاء البائع = sales − returns − consigDeduction = 10000 − 10000 − (8000−8000) = 0.
    expect(b.sales.minus(b.returns).minus(b.consigDeduction).toFixed(2)).toBe("0.00");
  });

  it("مرتجع تالف (restock=false): AP صافٍ = الحصة (يبقى مستحقاً) + خسارة على المكتبة + صافي وعاء البائع 0", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    const sale = await createSale({ branchId: 1, shiftId, sourceType: "POS", priceTier: "RETAIL",
      lines: [{ variantId, productUnitId, quantity: "1" }], payment: { amount: "5000", method: "CASH" } }, actor);
    expect(await balance(cid)).toBe("4000.00");
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "5000", method: "CASH" }, restock: false }, actor);
    // AP صافٍ يبقى 4000 (عُكس −4000 ثم أُعيد الاستحقاق +4000).
    expect(await balance(cid)).toBe("4000.00");
    // خسارة المكتبة: RETURN.cost = 0 (لم يُعكس) ⇒ التكلفة تبقى COGS. صافي الربح للقصة = −4000 (الحصة).
    const ret = (await entries("RETURN"))[0];
    expect(ret.cost).toBe("0.00"); // restock=false ⇒ لا عكس تكلفة
    // صافي وعاء البائع = 0 (العكس −4000 بـinvoiceId يستردّ الخصم؛ إعادة الاستحقاق يتيمة خارج الوعاء).
    const b = (await computeNetSalesByUser(db(), period())).get(1)!;
    expect(b.sales.minus(b.returns).minus(b.consigDeduction).toFixed(2)).toBe("0.00");
  });
});

describe("بضاعة الأمانة ش٣ — idempotency", () => {
  it("replay بنفس clientRequestId ⇒ استحقاق واحد لا يتضاعف", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, variantId, productUnitId, "10");
    const shiftId = await openShift();
    const input = { branchId: 1, shiftId, sourceType: "POS" as const, priceTier: "RETAIL" as const, clientRequestId: "rep-1",
      lines: [{ variantId, productUnitId, quantity: "2" }], payment: { amount: "10000", method: "CASH" as const } };
    await createSale(input, actor);
    await createSale(input, actor); // replay
    expect(await entries("PURCHASE")).toHaveLength(1); // استحقاق واحد
    expect(await balance(cid)).toBe("8000.00");
  });
});

describe("بضاعة الأمانة — تقاطع الأوفلاين (لا بيع بالسالب لصنف أمانة)", () => {
  // الثابت: مسار الأوفلاين (allowNegativeStock=true) يسمح بالسالب لبضاعة المكتبة (سالب موسوم، قرار
  // مالك ١٨/٧) لكن **لا** لصنف أمانة — بيعُ ما لم يُودَع يُلفّق التزاماً (AP) للمودِع لوحداتٍ لم تصل.
  // نفس ثابت المسار الحيّ، محروساً الآن على مسار allowNegative لا وضع الافتتاح وحده. راجع create.ts:626.
  it("ترحيل أوفلايني يتجاوز المُودَع لصنف أمانة ⇒ CONFLICT: يرتدّ بلا التزام مُلفَّق ولا سالب مخزون", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, variantId, productUnitId, "2"); // أُودِع ٢ فقط
    const shiftId = await openShift();
    // بيع ٣ (> المُودَع) عبر مسار الأوفلاين — لولا الحارس لهبط الرصيد إلى -١ وارتفع AP المودِع 12000.
    await expect(
      replayOfflineSale(
        {
          branchId: 1,
          shiftId,
          lines: [{ variantId, productUnitId, quantity: "3", unitPriceOverride: "5000" }],
          payment: { amount: "15000", method: "CASH" },
          clientRequestId: "consig-offline-oversell-1",
          capturedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          offlineReceiptNumber: "OFF-1-cz01-1",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // المعاملة ارتدّت بالكامل: صفر استحقاق أمانة، رصيد المودِع صفر، والمخزون كما أُودِع (٢).
    expect(await entries("PURCHASE")).toHaveLength(0);
    expect(await balance(cid)).toBe("0.00");
    const st = (await db().select().from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1))))[0];
    expect(Number(st.quantity)).toBe(2);
  });

  it("ترحيل أوفلايني ضمن المُودَع لصنف أمانة ⇒ يُرحَّل ويُلتقط الالتزام (الحارس جراحيّ لا يُفرِط الحجب)", async () => {
    const cid = await mkConsignor();
    const { variantId, productUnitId } = await mkConsignProduct(cid, "4000", "5000");
    await deposit(cid, variantId, productUnitId, "5");
    const shiftId = await openShift();
    const res = await replayOfflineSale(
      {
        branchId: 1,
        shiftId,
        lines: [{ variantId, productUnitId, quantity: "3", unitPriceOverride: "5000" }],
        payment: { amount: "15000", method: "CASH" },
        clientRequestId: "consig-offline-ok-1",
        capturedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        offlineReceiptNumber: "OFF-1-cz01-2",
      },
      actor,
    );
    expect(res.status).toBe("PAID");
    // البيع ضمن المُودَع مسموح: التُقط الالتزام كاملاً (الحصة ٤٠٠٠ × ٣) والمخزون ٥ − ٣ = ٢.
    expect(await entries("PURCHASE")).toHaveLength(1);
    expect(await balance(cid)).toBe("12000.00");
    const st = (await db().select().from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1))))[0];
    expect(Number(st.quantity)).toBe(2);
  });
});

/** فترة الشهر الحالية YYYY-MM (UTC) — للاختبارات الحيّة. */
function period(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
