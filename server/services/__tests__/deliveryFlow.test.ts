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
import { returnSale } from "../returnService";
import { createWorkOrder } from "../workOrderService";
import {
  confirmConsignmentDelivery,
  createDeliveryParty,
  dispatchToDelivery,
  listOpenConsignments,
  recordDeliveryRemittance,
  returnConsignment,
  settleDeliveryBalance,
  transitionConsignmentParcel,
  writeOffDeliveryShortfall,
} from "../deliveryService";
import {
  reconcileCustomerBalances,
  reconcileDeliveryFloat,
  reconcileLedgerProfit,
} from "../reconcileService";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
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
    { id: 3, openId: "local_courier", name: "مندوب", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل التوصيل", phone: "+9647700000000" }]);
  await d.insert(s.products).values([{ id: 1, name: "كتاب مطبوع" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "BK-1", costPrice: "0.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  const { id: partyId } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "1500", userId: 3, branchId: 1 }, MANAGER);
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
async function readyWorkOrder(
  shiftOpen: boolean,
  feeCollection: "COURIER" | "COUNTER" | "SHOP" = "COURIER",
): Promise<number> {
  const wo = await createWorkOrder(
    {
      branchId: 1,
      customerId: 1,
      baseVariantId: 1,
      title: "طباعة",
      salePrice: "10000",
      quantity: 1,
      deposit: shiftOpen ? "2000" : "0",
      paymentMethod: "CASH",
      hasDelivery: true,
      deliveryAddress: "بغداد",
      // 5/8: al-ujra tunqas min al-tawrid faqat 'inda SHOP/COUNTER. COURIER = yaqbiduha
      // al-mandub min al-zabun mubasharatan ⇒ kharij daftarina tamaman.
      deliveryFeeCollection: feeCollection,
    },
    { userId: 2, branchId: 1 },
  );
  const woId = (wo as { workOrderId: number }).workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}

async function deliver(consignmentId: number) {
  for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `flow-${consignmentId}-${toStatus}` },
      { userId: 3 },
    );
  }
  await confirmConsignmentDelivery(
    { consignmentId, clientRequestId: `flow-${consignmentId}-delivered` },
    { userId: 3 },
  );
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
    expect(inv.customerId).toBe(1);
    expect(inv.paidAmount).toBe("2000.00"); // العربون فقط
    expect(await partyBalance(partyId)).toBe("0.00"); // لا عهدة قبل تحصيل العميل
    expect(await entryCount("DELIVERY_DISPATCH", partyId)).toBe(0);
    expect(await entryCount("SALE")).toBe(1);
    // الإرسال لا يلمس درج الوردية إلا بالعربون (2000) — لا نقد COD في الدرج.
    expect(await drawerNet(shift.shiftId)).toBe(2000);
    expect((await reconcileCustomerBalances())).toEqual([]);
    await allReconcileClean();

    await deliver(disp.consignmentId);
    expect(await partyBalance(partyId)).toBe("8000.00");
    expect(await entryCount("DELIVERY_DISPATCH", partyId)).toBe(1);

    // الترحيل: توريد 8000 كاملة؛ أجرة COURIER قبضها المندوب مباشرة من العميل.
    const consignmentId = disp.consignmentId;
    const rem = await recordDeliveryRemittance({ branchId: 1, partyId, countedCash: "8000", lines: [{ consignmentId, collectedAmount: "8000" }] }, CASHIER);
    expect(rem.collectedTotal).toBe("8000.00");
    expect(rem.feesTotal).toBe("0.00");
    expect(rem.netRemitted).toBe("8000.00");
    expect(rem.status).toBe("BALANCED");
    expect(await partyBalance(partyId)).toBe("0.00"); // عهدة صُفّيت
    const inv2 = await invoice(disp.invoiceId);
    expect(inv2.paidAmount).toBe("10000.00");
    expect(inv2.status).toBe("PAID");
    expect(await drawerNet(shift.shiftId)).toBe(10000);
    expect(await entryCount("DELIVERY_FEE", partyId)).toBe(0);
    expect(await entryCount("DELIVERY_REMIT", partyId)).toBe(1);
    await allReconcileClean();
  });

  it("عجز جزئي يبقى عهدة (D4) ثم شطب المدير يُصفّرها كخسارة", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    await deliver(disp.consignmentId);

    // توريد جزئي 5000 من 8000 ⇒ 3000 تبقى عهدة.
    const rem = await recordDeliveryRemittance({ branchId: 1, partyId, countedCash: "5000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "5000" }] }, CASHIER);
    expect(rem.status).toBe("BALANCED");
    expect(rem.shortfallTotal).toBe("0.00");
    expect(rem.feesTotal).toBe("0.00");
    expect(await partyBalance(partyId)).toBe("3000.00");
    const inv = await invoice(disp.invoiceId);
    expect(inv.status).toBe("PAID");
    expect(inv.paidAmount).toBe("10000.00"); // قبض العميل ثبت عند التسليم
    await allReconcileClean();

    // شطب المدير للعجز 3000 — **موجَّهاً بالإرسالية** (حوكمة ٩/٨: عجز إرساليةٍ حيّة لا يُشطَب
    // مجمّعاً كي لا تبقى زومبي تقبل توريداً لاحقاً يقلب الرصيد سالباً): يقفلها WRITTEN_OFF
    // ويقيّد فاتورتها مسدَّدةً ويُصفّر العهدة كخسارة.
    await expect(
      writeOffDeliveryShortfall({ branchId: 1, partyId, amount: "3000", reason: "نزاع غير قابل للتحصيل" }, MANAGER),
    ).rejects.toThrow(/السائبة/); // المجمّع محجوز للعهدة غير المرتبطة بإرساليات
    await writeOffDeliveryShortfall({ branchId: 1, partyId, amount: "3000", reason: "نزاع غير قابل للتحصيل", consignmentId: disp.consignmentId }, MANAGER);
    expect(await partyBalance(partyId)).toBe("0.00");
    expect(await entryCount("DELIVERY_WRITEOFF", partyId)).toBe(1);
    const cnAfter = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, disp.consignmentId)))[0];
    expect(cnAfter.status).toBe("WRITTEN_OFF");
    const invAfter = await invoice(disp.invoiceId);
    expect(invAfter.status).toBe("PAID"); // الزبون دفع للمندوب — ذمّة الفاتورة تُقفل والخسارة على المكتبة
    await allReconcileClean();
  });

  it("فرق النقد المعدود يوقف التسوية ذرّياً ولا يغيّر الفاتورة أو عهدة المندوب", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    await deliver(disp.consignmentId);
    const beforeInvoice = await invoice(disp.invoiceId);
    const beforeReceipts = await db().select().from(s.receipts);

    await expect(recordDeliveryRemittance({
      branchId: 1,
      partyId,
      countedCash: "6000",
      lines: [{ consignmentId: disp.consignmentId, collectedAmount: "8000" }],
    }, CASHIER)).rejects.toThrow(/لا يطابق صافي التوريد/);

    expect(await partyBalance(partyId)).toBe("8000.00");
    const afterInvoice = await invoice(disp.invoiceId);
    expect(afterInvoice.paidAmount).toBe(beforeInvoice.paidAmount);
    expect(afterInvoice.status).toBe(beforeInvoice.status);
    expect(await db().select().from(s.receipts)).toHaveLength(beforeReceipts.length);
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
    await allReconcileClean();
  });

  it("تسوية الجهة نقداً تخفض العهدة السائبة — والمدعومة بإرسالية مفتوحة تُرفض", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "0" }, CASHIER);
    await deliver(disp.consignmentId);
    // حوكمة ٩/٨: عهدةُ إرساليةٍ مفتوحة لا تُسوَّى بمبلغٍ حرّ (تُورَّد بالإرسالية كي تُقيَّد فاتورتها).
    await recordDeliveryRemittance({ branchId: 1, partyId, countedCash: "5000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "5000" }] }, CASHIER);
    expect(await partyBalance(partyId)).toBe("3000.00");
    await expect(settleDeliveryBalance({ branchId: 1, partyId, amount: "3000" }, CASHIER)).rejects.toThrow(/السائبة/);
    // إكمال التوريد ⇒ عهدة صفر، ثم عهدة **سائبة** (نمط تحصيلات المتجر: قيد DISPATCH بلا إرسالية)
    // هي نطاق التسوية الحرّة المشروع.
    await recordDeliveryRemittance({ branchId: 1, partyId, countedCash: "3000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "3000" }] }, CASHIER);
    expect(await partyBalance(partyId)).toBe("0.00");
    await db().insert(s.accountingEntries).values({
      entryType: "DELIVERY_DISPATCH", branchId: 1, deliveryPartyId: partyId,
      amount: "3000.00", entryDate: sql`CURDATE()` as unknown as string,
      notes: "عهدة تحصيلات متجر (تجهيزة اختبار)",
    });
    await db().update(s.deliveryParties)
      .set({ currentBalance: sql`${s.deliveryParties.currentBalance} + 3000` })
      .where(eq(s.deliveryParties.id, partyId));
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
    expect(await partyBalance(partyId)).toBe("0.00");
    const stockBefore = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))).limit(1))[0];

    const { rows: returnQueue } = await listOpenConsignments(partyId, 1);
    expect(returnQueue.find((c) => Number(c.id) === disp.consignmentId)?.parcelStatus).toBe("ASSIGNED");
    await returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "ret-1" });
    expect((await listOpenConsignments(partyId, 1)).rows.some((c) => Number(c.id) === disp.consignmentId)).toBe(false);
    expect(await partyBalance(partyId)).toBe("0.00"); // العهدة عُكِست
    const inv = await invoice(disp.invoiceId);
    expect(inv.status).toBe("RETURNED");
    const stockAfter = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))).limit(1))[0];
    // ناتج أمر الشغل المخصّص لم يملك حركة OUT مرجعية على الفاتورة، لذلك لا يجوز اختراع
    // حركة IN عند رجوع الطرد. الثابت: لا إعادة مخزون بلا إخراج أصلي مثبت.
    expect(Number(stockAfter.q)).toBe(Number(stockBefore.q));
    await allReconcileClean();
  });

  it("سباق إرجاع الإرسالية مع توريدها يقفل party→consignment ولا يقع في deadlock", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(false);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);

    const results = await Promise.allSettled([
      returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "race-delivery-return" }),
      recordDeliveryRemittance({
        branchId: 1,
        partyId,
        countedCash: "10000",
        clientRequestId: "race-delivery-remittance",
        lines: [{ consignmentId: disp.consignmentId, collectedAmount: "10000" }],
      }, CASHIER),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await db().select({ status: s.deliveryConsignments.status }).from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, disp.consignmentId)).limit(1))[0]?.status).toBe("RETURNED");
    await allReconcileClean();
  }, 15_000);

  it("سباق إرجاع الإرسالية مع مرتجع البيع يقفل drawer→party→consignment→invoice ولا يكرر الرد", async () => {
    const { partyId } = await seed();
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, disp.invoiceId)).limit(1))[0];

    const results = await Promise.allSettled([
      returnConsignment(disp.consignmentId, {
        ...MANAGER,
        clientRequestId: "race-consignment-refund",
        refundShiftId: shift.shiftId,
      }),
      returnSale({
        invoiceId: disp.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: Number(item.baseQuantity) }],
        refund: { amount: "2000", method: "CASH", shiftId: shift.shiftId },
        restock: true,
        clientRequestId: "race-sale-return",
      }, MANAGER),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const cashRefunds = await db().select({ amount: s.receipts.amount }).from(s.receipts).where(and(
      eq(s.receipts.invoiceId, disp.invoiceId),
      eq(s.receipts.direction, "OUT"),
      eq(s.receipts.paymentMethod, "CASH"),
    ));
    expect(cashRefunds.filter((receipt) => Number(receipt.amount) === 2000)).toHaveLength(1);
    expect((await invoice(disp.invoiceId)).status).toBe("RETURNED");
    await allReconcileClean();
  }, 15_000);

  it("idempotency الإرسال: نقرة مزدوجة = إرسالية واحدة + قيد SALE واحد", async () => {
    const { partyId } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const woId = await readyWorkOrder(true);
    const a = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500", clientRequestId: "disp-1" }, CASHIER);
    const b = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500", clientRequestId: "disp-1" }, CASHIER);
    expect(b.consignmentId).toBe(a.consignmentId);
    expect(await entryCount("SALE")).toBe(1);
    expect(await entryCount("DELIVERY_DISPATCH", partyId)).toBe(0);
    expect(await partyBalance(partyId)).toBe("0.00");
  });

  // ─── ردّ عربون الإرجاع — إسناد الدرج الفعليّ (بلاغ مالك ٢/٨/٢٦، مرآة إصلاح returnService.ts) ───
  describe("إرجاع إرسالية بعربون نقديّ — إسناد الدرج الفعليّ لا وردية المدير", () => {
    it("المديرة بلا وردية + وردية الكاشير هي الوحيدة المفتوحة ⇒ ردّ العربون يُنسَب لها تلقائياً", async () => {
      const { partyId } = await seed();
      const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
      const woId = await readyWorkOrder(true); // عربون ٢٠٠٠ نقداً
      const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);

      // قبل الإصلاح: shiftIdForCashTx(actor=المديرة بلا وردية) ⇒ TREASURY (لا يظهر في Z-report الكاشير).
      await returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "ret-attr-1" });

      const outRows = await db()
        .select({ shiftId: s.receipts.shiftId, cashBucket: s.receipts.cashBucket, amount: s.receipts.amount })
        .from(s.receipts)
        .where(and(eq(s.receipts.invoiceId, disp.invoiceId), eq(s.receipts.direction, "OUT"), eq(s.receipts.paymentMethod, "CASH")));
      const refundRow = outRows.find((r) => Number(r.amount) === 2000);
      expect(refundRow?.shiftId).toBe(shift.shiftId); // انتسب لدرج الكاشير الحقيقيّ — لا TREASURY، لا وردية شبحيّة.
      expect(refundRow?.cashBucket).toBe("DRAWER");
      await allReconcileClean();
    });

    it("تعدّد الدرج (وردية المديرة الخاصّة + وردية الكاشير) بلا تحديد صريح ⇒ يُرفَض", async () => {
      const { partyId } = await seed();
      const cashierShift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
      await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 1, branchId: 1 });
      const woId = await readyWorkOrder(true);
      const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);

      await expect(
        returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "ret-attr-2" }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      void cashierShift;
    });

    it("تعدّد الدرج + refundShiftId صريح لوردية الكاشير ⇒ ينجح وينتسب لها لا لوردية المديرة", async () => {
      const { partyId } = await seed();
      const cashierShift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
      const mgrShift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 1, branchId: 1 });
      const woId = await readyWorkOrder(true);
      const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);

      await returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "ret-attr-3", refundShiftId: cashierShift.shiftId });

      expect(await drawerNet(cashierShift.shiftId)).toBe(0); // ٢٠٠٠ عربون IN − ٢٠٠٠ ردّ OUT = صفر
      expect(await drawerNet(mgrShift.shiftId)).toBe(0); // لم يُلمَس درج المديرة إطلاقاً
    });

    it("الدرج استُنزف بمصروفٍ سابق في نفس الوردية ⇒ ردّ عربونٍ يتجاوز المتاح حالياً يُرفَض", async () => {
      const { partyId } = await seed();
      const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
      const woId = await readyWorkOrder(true); // عربون ٢٠٠٠
      const disp = await dispatchToDelivery({ workOrderId: woId, partyId, deliveryFee: "1500" }, CASHIER);
      // مصروفٌ نقديّ يستنزف الدرج (المتاح بعد العربون = ٢٠٠٠) إلى ٥٠٠ فقط.
      await db().insert(s.receipts).values({
        branchId: 1, shiftId: shift.shiftId, direction: "OUT", amount: "1500.00",
        paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", createdBy: 2,
      });

      await expect(
        returnConsignment(disp.consignmentId, { ...MANAGER, clientRequestId: "ret-attr-4" }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });
  });
});
