/**
 * اختبارات Slices 2–4 — مسار مال التوصيل (COD) الكامل وثوابت السلامة:
 *  - الإرسال: فاتورة customerId=NULL + SALE + عهدة COD، بلا إيصال درج (Z غير متأثّر).
 *  - الترحيل (خصم الأجرة وتوريد الصافي): PAYMENT_IN كامل + DELIVERY_FEE + DELIVERY_REMIT،
 *    صافي الدرج = المُحصَّل − الأجرة، عهدة=0، فاتورة PAID.
 *  - العجز يبقى عهدة (D4). الشطب يُصفّر العهدة كخسارة بلا نقد. الإرجاع يعكس البيع+المخزون+العهدة.
 *  - الثوابت: reconcileDeliveryFloat/CustomerBalances/LedgerProfit == [] بعد كل تحوّل.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { createWorkOrder } from "../workOrderService";
import {
  createDeliveryParty,
  dispatchToDelivery,
  recordDeliveryRemittance,
  returnConsignment,
  settleDeliveryBalance,
  writeOffDeliveryShortfall,
} from "../deliveryService";
import {
  reconcileCustomerBalances,
  reconcileDeliveryFloat,
  reconcileLedgerProfit,
} from "../reconcileService";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل التوصيل", phone: "+9647700000000" }]);
  await d.insert(s.products).values([{ id: 1, name: "كتاب مطبوع" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "BK-1", costPrice: "0.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  const { id: partyId } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "1500", branchId: 1 }, MANAGER);
  return { partyId };
}

/** صافي درج الوردية = Σ(IN) − Σ(OUT) للنقد DRAWER. */
async function drawerNet(shiftId: number): Promise<number> {
  const r = (await db()
    .select({
      net: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END),0)`,
    })
    .from(s.receipts)
    .where(and(eq(s.receipts.shiftId, shiftId), eq(s.receipts.paymentMethod, "CASH"), eq(s.receipts.cashBucket, "DRAWER"))))[0];
  return Number(r?.net ?? 0);
}
async function entryCount(type: string, partyId?: number): Promise<number> {
  const conds = [eq(s.accountingEntries.entryType, type as never)];
  if (partyId != null) conds.push(eq(s.accountingEntries.deliveryPartyId, partyId));
  const r = (await db().select({ n: sql<number>`COUNT(*)` }).from(s.accountingEntries).where(and(...conds)))[0];
  return Number(r?.n ?? 0);
}
async function partyBalance(partyId: number): Promise<string> {
  const p = (await db().select({ b: s.deliveryParties.currentBalance }).from(s.deliveryParties).where(eq(s.deliveryParties.id, partyId)).limit(1))[0];
  return String(p?.b ?? "0");
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)).limit(1))[0];
}
async function allReconcileClean() {
  expect(await reconcileDeliveryFloat()).toEqual([]);
  expect(await reconcileCustomerBalances()).toEqual([]);
  expect(await reconcileLedgerProfit()).toEqual([]);
}

/** ينشئ طلباً بعربون نقدي ويجعله READY. يُرجِع معرّفه. */
async function readyWorkOrder(shiftOpen: boolean): Promise<number> {
  const wo = await createWorkOrder(
    { branchId: 1, customerId: 1, baseVariantId: 1, title: "طباعة", salePrice: "10000", quantity: 1, deposit: shiftOpen ? "2000" : "0", paymentMethod: "CASH" },
    { userId: 2, branchId: 1 },
  );
  const woId = (wo as { workOrderId: number }).workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}

describe("delivery COD — money path", () => {
  beforeEach(async () => {
    await reset();
  });

  it("دورة كاملة: عربون → إرسال → ترحيل كامل بخصم الأجرة + ثوابت المطابقة", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);

    // الإرسال: cod = 10000 − 2000 = 8000، الأجرة 1500.
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    expect(disp.codAmount).toBe("8000.00");
    const inv = await invoice(disp.invoiceId);
    expect(inv.customerId).toBeNull(); // فاتورة COD بلا عميل (عهدة لا AR)
    expect(inv.paidAmount).toBe("2000.00"); // العربون فقط
    expect(await partyBalance(partyId)).toBe("8000.00"); // عهدة = cod
    expect(await entryCount("DELIVERY_DISPATCH", partyId)).toBe(1);
    expect(await entryCount("SALE")).toBe(1);
    // الإرسال لا يلمس درج الوردية إلا بالعربون (2000) — لا نقد COD في الدرج.
    expect(await drawerNet(shift.shiftId)).toBe(2000);
    expect((await reconcileCustomerBalances())).toEqual([]); // العميل بلا AR
    await allReconcileClean();

    // الترحيل: تحصيل 8000 كاملاً، الأجرة 1500.
    const consignmentId = disp.consignmentId;
    const rem = await recordDeliveryRemittance({ branchId: 1, partyId, lines: [{ consignmentId, collectedAmount: "8000" }] }, CASHIER);
    expect(rem.collectedTotal).toBe("8000.00");
    expect(rem.feesTotal).toBe("1500.00");
    expect(rem.netRemitted).toBe("6500.00");
    expect(rem.status).toBe("BALANCED");
    expect(await partyBalance(partyId)).toBe("0.00"); // عهدة صُفّيت
    const inv2 = await invoice(disp.invoiceId);
    expect(inv2.paidAmount).toBe("10000.00");
    expect(inv2.status).toBe("PAID");
    // صافي الدرج = العربون 2000 + (8000 − 1500) = 8500.
    expect(await drawerNet(shift.shiftId)).toBe(8500);
    expect(await entryCount("DELIVERY_FEE", partyId)).toBe(1);
    expect(await entryCount("DELIVERY_REMIT", partyId)).toBe(1);
    await allReconcileClean();
  });

  it("عجز جزئي يبقى عهدة (D4) ثم شطب المدير يُصفّرها كخسارة", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);

    // تحصيل جزئي 5000 من 8000 ⇒ عجز 3000 يبقى عهدة، بلا أجرة (لم يُسلَّم بالكامل).
    const rem = await recordDeliveryRemittance({ branchId: 1, partyId, lines: [{ consignmentId: disp.consignmentId, collectedAmount: "5000" }] }, CASHIER);
    expect(rem.status).toBe("SHORT");
    expect(rem.shortfallTotal).toBe("3000.00");
    expect(rem.feesTotal).toBe("0.00");
    expect(await partyBalance(partyId)).toBe("3000.00");
    const inv = await invoice(disp.invoiceId);
    expect(inv.status).toBe("PARTIALLY_PAID");
    expect(inv.paidAmount).toBe("7000.00"); // 2000 عربون + 5000
    await allReconcileClean();

    // شطب المدير للعجز 3000 ⇒ عهدة=0 + خسارة.
    await writeOffDeliveryShortfall({ branchId: 1, partyId, amount: "3000", reason: "نزاع غير قابل للتحصيل" }, MANAGER);
    expect(await partyBalance(partyId)).toBe("0.00");
    expect(await entryCount("DELIVERY_WRITEOFF", partyId)).toBe(1);
    await allReconcileClean();
  });

  it("تسوية الجهة نقداً تخفض العهدة", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "0" }, CASHIER);
    await recordDeliveryRemittance({ branchId: 1, partyId, lines: [{ consignmentId: disp.consignmentId, collectedAmount: "5000" }] }, CASHIER);
    expect(await partyBalance(partyId)).toBe("3000.00");
    const set = await settleDeliveryBalance({ branchId: 1, partyId, amount: "3000" }, CASHIER);
    expect(set.partyBalanceAfter).toBe("0.00");
    expect(await partyBalance(partyId)).toBe("0.00");
    await allReconcileClean();
  });

  it("إرجاع إرسالية: عكس البيع + إعادة المخزون + عكس العهدة", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(false); // بلا عربون لتبسيط الرد
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    expect(await partyBalance(partyId)).toBe("10000.00");
    const stockBefore = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))).limit(1))[0];

    await returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "ret-1" });
    expect(await partyBalance(partyId)).toBe("0.00"); // العهدة عُكِست
    const inv = await invoice(disp.invoiceId);
    expect(inv.status).toBe("RETURNED");
    const stockAfter = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))).limit(1))[0];
    expect(Number(stockAfter.q)).toBe(Number(stockBefore.q) + 1); // أُعيد للمخزون
    await allReconcileClean();
  });

  it("idempotency الإرسال: نقرة مزدوجة = إرسالية واحدة + قيد SALE واحد", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const a = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500", clientRequestId: "disp-1" }, CASHIER);
    const b = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500", clientRequestId: "disp-1" }, CASHIER);
    expect(b.consignmentId).toBe(a.consignmentId);
    expect(await entryCount("SALE")).toBe(1);
    expect(await entryCount("DELIVERY_DISPATCH", partyId)).toBe(1);
    expect(await partyBalance(partyId)).toBe("8000.00");
  });
});
