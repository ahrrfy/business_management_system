/**
 * F7 (تدقيق ٢/٧) — اختبارات معالجة ثغرتين من نقد الاكتمال:
 *  (#2) IDOR كتابة عبر الفروع في عهدة التوصيل: settle/recordRemittance/dispatch أضيف لها assertPartyInScope.
 *  (#3) رياضة كشف حساب المورّد: الرصيد الجاري يجب أن يتّزن مع currentBalance عبر الإشارة الصحيحة لكل نوع قيد
 *       (كان يعامل كل الدفعات مديناً ⇒ مرتجع الشراء بإشارة معكوسة).
 */
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { getSupplierStatement } from "../reports/apAging";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const TABLES = [
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts", "inventoryMovements",
  "deliveryRemittances", "deliveryConsignments", "deliveryParties",
  "purchaseOrderItems", "purchaseOrders", "invoiceItems", "invoices",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "suppliers", "customers", "users", "branches",
];
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "adm", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "c1", name: "كاشير ف١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "c2", name: "كاشير ف٢", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAP", costPrice: "200.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
}
function caller(role: string, branchId: number, id: number) {
  const ctx = { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: { id, role, branchId } } as any;
  return appRouter.createCaller(ctx);
}

beforeEach(async () => { await reset(); await seed(); });

describe("F7 #2 — IDOR كتابة عبر الفروع في عهدة التوصيل", () => {
  it("كاشير ف١ يسوّي جهةَ ف٢ ⇒ FORBIDDEN (جهة فرعٍ آخر)", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "مندوب ف٢", partyType: "INDIVIDUAL", branchId: 2, currentBalance: "500.00" });
    await expect(
      caller("cashier", 1, 4).delivery.settle({ partyId: 1, amount: "100.00" } as any),
    ).rejects.toThrow(/جهة التوصيل تخصّ فرعاً آخر/);
  });

  it("كاشير ف٢ يسوّي جهةَ ف٢ ⇒ لا يُرفَض بحارس الفرع (قد يفشل لسبب آخر، لا «فرعٍ آخر»)", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "مندوب ف٢", partyType: "INDIVIDUAL", branchId: 2, currentBalance: "500.00" });
    try {
      await caller("cashier", 2, 5).delivery.settle({ partyId: 1, amount: "100.00" } as any);
    } catch (e: any) {
      expect(String(e?.message)).not.toMatch(/جهة التوصيل تخصّ فرعاً آخر/);
    }
  });

  it("جهة مشتركة (branchId=null) ⇒ أي كاشير يعبُر حارس الفرع", async () => {
    await db().insert(s.deliveryParties).values({ id: 2, name: "مندوب مشترك", partyType: "INDIVIDUAL", branchId: null, currentBalance: "500.00" });
    try {
      await caller("cashier", 1, 4).delivery.settle({ partyId: 2, amount: "100.00" } as any);
    } catch (e: any) {
      expect(String(e?.message)).not.toMatch(/جهة التوصيل تخصّ فرعاً آخر/);
    }
  });

  it("مدير (مرتفع) يعبُر الفروع على التسوية", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "مندوب ف٢", partyType: "INDIVIDUAL", branchId: 2, currentBalance: "500.00" });
    try {
      await caller("manager", 1, 1).delivery.settle({ partyId: 1, amount: "100.00" } as any);
    } catch (e: any) {
      expect(String(e?.message)).not.toMatch(/جهة التوصيل تخصّ فرعاً آخر/);
    }
  });
});

describe("F7 #3 — رياضة كشف حساب المورّد تتّزن مع currentBalance (إشارة كل نوع قيد)", () => {
  it("شراء مُستلَم ١٠٠٠ + مرتجع شراء ٢٠٠ ⇒ الرصيد الجاري = currentBalance = 800 (المنطق الجديد)، والقديم كان 1200", async () => {
    const actor = { userId: 1, branchId: 1 };
    await db().insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0" });
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPrice: "200.00" }] },
      actor,
    );
    const item = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 5 }] }, actor);
    await createPurchaseReturn(
      { supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "200.00" }], settlement: "CREDIT" },
      actor,
    );

    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("800.00"); // AP الفعليّ

    const stmt = (await getSupplierStatement(1, { from: "2000-01-01" }))!;
    expect(stmt.summary.currentBalance).toBe("800.00");

    // محاكاة منطق SupplierStatement.tsx (الجديد): إشارة AP الموقَّعة لكل نوع قيد.
    const D = (v: any) => new Decimal(String(v ?? 0));
    let balNew = D(stmt.summary.openingBalance); // من الفترة: opening=0
    for (const p of stmt.purchaseOrders) balNew = balNew.plus(D(p.total)); // credit
    for (const p of stmt.payments) {
      const amt = D(p.amount);
      const reducesAP = p.entryType === "PAYMENT_OUT" || p.entryType === "EXCHANGE_SETTLE";
      const signed = p.entryType === "RETURN" ? amt : (reducesAP ? amt.neg() : amt);
      balNew = balNew.plus(signed);
    }
    expect(balNew.toFixed(2)).toBe("800.00"); // يتّزن مع currentBalance ✓

    // محاكاة المنطق القديم المعيب (كل دفعة مدين بلا نظر للنوع) ⇒ ينحرف (توثيق الكسر).
    let balOld = D(stmt.summary.openingBalance);
    for (const p of stmt.purchaseOrders) balOld = balOld.plus(D(p.total));
    for (const p of stmt.payments) balOld = balOld.minus(D(p.amount)); // debit خام
    expect(balOld.toFixed(2)).toBe("1200.00"); // مرتجع −200 خُصم كمدين ⇒ +200 خطأً
    expect(balOld.toFixed(2)).not.toBe(sup.currentBalance);
  });
});
