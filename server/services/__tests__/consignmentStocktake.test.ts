import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createProduct } from "../catalogService";
import { createSupplier } from "../supplierService";
import { computeNetSalesByUser } from "../commissions/base";
import { approveStocktake, createStocktakeSession, decideStocktakeItem, forceStocktakeReview } from "../stocktakeService";

/**
 * بضاعة الأمانة — ش٤ تحسين: عجز/زيادة الجرد لصنف أمانة (قرار المالك ٥ + design §٢-هـ).
 *   عجز صنف أمانة = خسارة على المكتبة (يبقى ضمن قيد SHORT) **+** التزامٌ للمودِع (استحقاق يتيم
 *   بلا invoiceId كأنه بِيع بلا إيراد) ⇒ يرفع رصيد المودِع، ويبقى **خارج وعاء العمولة**.
 *   زيادة صنف أمانة = تُستبعَد من قيد OVER (بضاعة المودِع الزائدة ليست ربحنا) بلا استحقاق.
 */
const actor = { userId: 1, branchId: 1 };
const TABLES = [
  "stocktakeDecisions", "stocktakeCounts", "stocktakeItems", "stocktakeAssignments", "stocktakeSessions",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys",
  "consignmentNoteLines", "consignmentNotes",
  "branchStock", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "shifts", "auditLogs", "customers", "suppliers", "categories", "users", "branches",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "SALES", code: "SALES", type: "SALES" }]);
  await db().insert(s.users).values([
    { id: 1, openId: "t1", name: "مدير", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "t2", name: "مشرف", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
}
async function mkConsignor(name = "أ. حيدر") { return (await createSupplier({ name, supplierKind: "CONSIGNOR" }, actor)).supplierId; }
async function mkConsignProduct(consignorId: number, share = "400", sell = "500") {
  const sku = `MLZ-${Math.random().toString(36).slice(2, 7)}`;
  await createProduct({ name: "ملزمة", isConsignment: true, consignorId,
    variants: [{ sku, costPrice: share, units: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, prices: [{ priceTier: "RETAIL" as const, price: sell }] }] }] }, actor);
  const v = (await db().select().from(s.productVariants).where(eq(s.productVariants.sku, sku)))[0];
  const u = (await db().select().from(s.productUnits).where(eq(s.productUnits.variantId, Number(v.id))))[0];
  return { variantId: Number(v.id), productUnitId: Number(u.id) };
}
// رصيد مباشر بلا حركة (نمط setStockRow في stocktake.test) — كي لا تُحسَب حركة إيداعٍ بعد countedAt
// «تصحيح ما بعد العدّ» فتنحرف اللقطة. الإيداع نفسه مُغطّى في consignmentNotes.test؛ هنا نختبر منطق الجرد.
async function setStockRow(variantId: number, qty: number, branchId = 1) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function supplierBalance(id: number): Promise<string> {
  return String((await db().select({ b: s.suppliers.currentBalance }).from(s.suppliers).where(eq(s.suppliers.id, id)))[0].b);
}
async function entriesOf(dedupeKey: string) {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, dedupeKey));
}
async function insertCount(sessionId: number, variantId: number, assignmentId: number, qty: number) {
  await db().insert(s.stocktakeCounts).values({
    sessionId, variantId, assignmentId, kind: "FIRST", qty, countedByName: "عامل",
    countedAt: new Date(Date.now() - 5_000), isConflict: false, clientRequestId: crypto.randomUUID(),
  });
}
async function mkSession(variantId: number) {
  return createStocktakeSession({
    name: "جرد أمانة", branchId: 1, scopeType: "MANUAL", variantIds: [variantId],
    assignments: [{ name: "عامل", method: "PIN" }], dualThreshold: "1000000",
  }, actor);
}

beforeEach(async () => { await truncateTables(TABLES); await seedBase(); });

describe("بضاعة الأمانة — عجز/زيادة الجرد (ش٤ تحسين)", () => {
  it("عجز صنف أمانة: قيد SHORT خسارةً على المكتبة + استحقاق يتيم للمودِع يرفع رصيده، وخارج وعاء العمولة", async () => {
    const cid = await mkConsignor();
    const { variantId } = await mkConsignProduct(cid, "400", "500");
    await setStockRow(variantId, 10); // رصيد 10؛ رصيد المودِع 0 (لا التزام عند الإيداع)
    expect(await supplierBalance(cid)).toBe("0.00");

    const r = await mkSession(variantId);
    await insertCount(r.sessionId, variantId, r.assignments[0].assignmentId, 7); // عجز 3 × 400 = 1200
    await forceStocktakeReview(r.sessionId, actor);
    await decideStocktakeItem({ sessionId: r.sessionId, variantId, action: "ADJUST", reason: "LOSS_THEFT" }, actor);

    const ok = await approveStocktake(r.sessionId, actor);
    expect(ok.shortExpense).toBe("1200.00"); // خسارة المكتبة كاملةً (لا تُخصم بالاستحقاق)
    expect(ok.overGain).toBe("0.00");

    // (أ) قيد SHORT — خسارة على المكتبة (profit سالب).
    const [short] = await entriesOf(`STOCKTAKE:${r.sessionId}:SHORT`);
    expect(short).toBeTruthy();
    expect(short.cost).toBe("1200.00");
    expect(short.profit).toBe("-1200.00");
    expect(short.amount).toBe("0.00");

    // (ب) استحقاق يتيم للمودِع — PURCHASE بلا invoiceId + رصيد المودِع يرتفع 1200.
    const [accrual] = await entriesOf(`CONSIG:STK:${r.sessionId}:${cid}`);
    expect(accrual).toBeTruthy();
    expect(accrual.entryType).toBe("PURCHASE");
    expect(Number(accrual.supplierId)).toBe(cid);
    expect(accrual.invoiceId).toBeNull();
    expect(accrual.amount).toBe("1200.00");
    expect(accrual.revenue).toBe("0.00");
    expect(accrual.profit).toBe("0.00");
    expect(await supplierBalance(cid)).toBe("1200.00");

    // (ج) خارج وعاء العمولة: invoiceId فارغ ⇒ INNER JOIN على الفواتير يستبعده ⇒ لا خصم لأي بائع.
    const base = await computeNetSalesByUser(db(), new Date().toISOString().slice(0, 7));
    for (const [, v] of base) expect(v.consigDeduction.toString()).toBe("0");

    // (د) المخزون سُوّي للمعدود الحقيقي.
    const [bs] = await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1)));
    expect(bs.quantity).toBe(7);
  });

  it("زيادة صنف أمانة: تُستبعَد من قيد OVER ولا تُنشئ استحقاقاً (ليست ربح المكتبة)", async () => {
    const cid = await mkConsignor("أ. سالم");
    const { variantId } = await mkConsignProduct(cid, "400", "500");
    await setStockRow(variantId, 10);

    const r = await mkSession(variantId);
    await insertCount(r.sessionId, variantId, r.assignments[0].assignmentId, 13); // زيادة 3
    await forceStocktakeReview(r.sessionId, actor);
    await decideStocktakeItem({ sessionId: r.sessionId, variantId, action: "ADJUST", reason: "ENTRY_ERROR" }, actor);

    const ok = await approveStocktake(r.sessionId, actor);
    expect(ok.overGain).toBe("0.00"); // مستبعدة من الربح
    expect(ok.shortExpense).toBe("0.00");

    expect(await entriesOf(`STOCKTAKE:${r.sessionId}:OVER`)).toHaveLength(0);
    expect(await entriesOf(`CONSIG:STK:${r.sessionId}:${cid}`)).toHaveLength(0);
    expect(await supplierBalance(cid)).toBe("0.00");

    // المخزون سُوّي رغم عدم وجود قيد دفتري.
    const [bs] = await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1)));
    expect(bs.quantity).toBe(13);
  });
});
