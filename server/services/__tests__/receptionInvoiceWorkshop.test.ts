/**
 * ش١ — ورشة فواتير محطة خدمة الزبائن (طابور keyset + تسديد collectOnInvoice).
 * الوثيقة الحاكمة: docs/reception-cashier-system-design-2026-08-05.md §٦ + §٨.٥ + §٩.
 *
 * المُثبَت هنا:
 *  Q1 — نطاق الطابور: فواتير ورديات RECEPTION فقط (فاتورة RETAIL لا تظهر)، وأعمدته تحمل
 *       المتبقّي الحقيقيّ وحالة التسليم و«قَبَضَها».
 *  Q2 — فلاتر paymentState/method/q تعمل خادمياً.
 *  Q3 — keyset: hasMore/nextCursor بلا تكرار صفوف بين الصفحات، وفاتورة الأمس قابلة للوصول.
 *  Q4 — فاتورة تسليم أمر شغل (عربون + الباقي عند الاستلام) تظهر في الطابور بمتبقٍّ صحيح
 *       (كانت تُنشأ بلا shiftId فتختفي — إصلاح deliver.ts).
 *  C1 — collectOnInvoice: يسدّد عبر processPayment، والدفعة تدخل **درج القابض** الحاليّ
 *       (تأكيد المالك: الموظّف يُحاسَب على ما استلمه هو)، وidempotency لا يزدوج.
 *  C2 — الحصر البنيويّ: فاتورة وردية RETAIL تُرفض FORBIDDEN (ليست باباً على مبيعات التجزئة).
 *  C3 — نقديّ بلا وردية مفتوحة ⇒ PRECONDITION_FAILED برسالة «درجك أنت».
 *  R1 — بوّابة الطابور: warehouse/auditor ⇒ FORBIDDEN، والكاشير ومشغّل الطباعة يمران للقراءة فقط.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { listReceptionInvoices } from "../reception";

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
const CASHIER2 = { userId: 5, branchId: 1, role: "cashier" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف الخدمة الأول", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "rc2", name: "موظف الخدمة الثاني", email: "r2@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 6, openId: "wh", name: "مخزني", email: "w@t.test", role: "warehouse", loginMethod: "local", branchId: 1 },
    { id: 7, openId: "aud", name: "مدقق", email: "a@t.test", role: "auditor", loginMethod: "local", branchId: 1 },
    { id: 8, openId: "po", name: "فني طباعة", email: "p@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل آجل", phone: "+9647700000009", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

/** بيع مباشر نقديّ كامل على وردية الاستقبال — فاتورة PAID في نطاق الطابور. */
async function directSale(shiftId: number, reqId: string, qty = 1, method: "CASH" | "CARD" = "CASH") {
  return checkoutReception({
    branchId: 1,
    shiftId,
    paymentMethod: method,
    paymentReference: method === "CARD" ? "CARD-1" : undefined,
    paidAmount: (1000 * qty).toFixed(2),
    clientRequestId: reqId,
    regularSale: { lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }], amount: (1000 * qty).toFixed(2) },
  }, CASHIER);
}

function makeCtx(user: { id: number }) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as never;
}
async function callerFor(userId: number) {
  const u = (await db().select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  return appRouter.createCaller(makeCtx(u as never));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("Q — طابور فواتير المحطة", () => {
  it("Q1: نطاق RECEPTION فقط + الأعمدة (المتبقّي/قَبَضَها) — فاتورة RETAIL لا تظهر", async () => {
    const rec = await openReception();
    await directSale(rec.shiftId, "wq1-a");
    // فاتورة تجزئة على وردية RETAIL لنفس الموظف — يجب ألا تظهر في طابور المحطة.
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    await checkoutReception; // (لا شيء — التجزئة تمرّ عبر sales.create؛ نحقنها مباشرةً بنفس البنية)
    await db().insert(s.invoices).values({
      id: 900, invoiceNumber: "INV-RET-900", sourceType: "POS", sourceId: "wq1-ret",
      branchId: 1, shiftId: retail.shiftId, priceTier: "RETAIL",
      subtotal: "5000.00", taxAmount: "0.00", discountAmount: "0.00",
      total: "5000.00", costTotal: "0.00", status: "PAID", paidAmount: "5000.00", createdBy: 2,
    });

    const page = await listReceptionInvoices({ branchId: 1, sinceDays: 7 });
    expect(page.rows.length).toBe(1);
    const row = page.rows[0];
    expect(row.status).toBe("PAID");
    expect(row.createdByName).toBe("موظف الخدمة الأول");
    expect(page.rows.some((r) => r.invoiceNumber === "INV-RET-900")).toBe(false);
  });

  it("Q2: فلاتر paymentState/method/q", async () => {
    const rec = await openReception();
    await directSale(rec.shiftId, "wq2-cash", 1, "CASH");
    const cardSale = await directSale(rec.shiftId, "wq2-card", 2, "CARD");

    const unsettled = await listReceptionInvoices({ branchId: 1, sinceDays: 7, paymentState: "UNSETTLED" });
    expect(unsettled.rows.length).toBe(0); // البيع المباشر يولد مدفوعاً

    const cardOnly = await listReceptionInvoices({ branchId: 1, sinceDays: 7, method: "CARD" });
    expect(cardOnly.rows.length).toBe(1);
    expect(Number(cardOnly.rows[0].id)).toBe(Number(cardSale.regularSale!.invoiceId));

    const byNumber = await listReceptionInvoices({ branchId: 1, sinceDays: 7, q: cardOnly.rows[0].invoiceNumber.slice(-5) });
    expect(byNumber.rows.some((r) => Number(r.id) === Number(cardSale.regularSale!.invoiceId))).toBe(true);
  });

  it("Q3: keyset — صفحتان بلا تكرار، وفاتورة أقدم من اليوم قابلة للوصول", async () => {
    const rec = await openReception();
    for (let i = 0; i < 5; i += 1) await directSale(rec.shiftId, `wq3-${i}`);
    // فاتورة «أمس»: نزحزح تاريخها — كانت sinceDays:1 المثبَّتة تحجبها إطلاقاً (§٨.٥).
    const old = await directSale(rec.shiftId, "wq3-old");
    await db().update(s.invoices)
      .set({ invoiceDate: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(s.invoices.id, Number(old.regularSale!.invoiceId)));

    const p1 = await listReceptionInvoices({ branchId: 1, sinceDays: 7, limit: 3 });
    expect(p1.rows.length).toBe(3);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listReceptionInvoices({ branchId: 1, sinceDays: 7, limit: 3, cursor: p1.nextCursor! });
    const ids1 = new Set(p1.rows.map((r) => Number(r.id)));
    expect(p2.rows.every((r) => !ids1.has(Number(r.id)))).toBe(true);
    // فاتورة الأمس (قبل ٣ أيام) موجودة في مجموع الصفحات.
    const all = [...p1.rows, ...p2.rows];
    expect(all.some((r) => Number(r.id) === Number(old.regularSale!.invoiceId))).toBe(true);
  });

  it("Q4: فاتورة تسليم أمر شغل بعربون تظهر بمتبقٍّ صحيح (كانت بلا shiftId فتختفي)", async () => {
    await openReception();
    const wo = await createWorkOrder({
      branchId: 1, customerId: 1, baseVariantId: null, title: "درع",
      salePrice: "50000", quantity: 1, deposit: "20000", paymentMethod: "CASH",
    }, CASHIER);
    const workOrderId = (wo as { workOrderId: number }).workOrderId;
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, workOrderId));
    const res = await deliverWorkOrder({ workOrderId, payment: { amount: "10000", method: "CASH" } }, CASHIER);

    const page = await listReceptionInvoices({ branchId: 1, sinceDays: 7, paymentState: "UNSETTLED" });
    const row = page.rows.find((r) => Number(r.id) === res.invoiceId);
    expect(row).toBeTruthy();
    // المتبقّي = ٥٠٬٠٠٠ − (٢٠٬٠٠٠ عربون + ١٠٬٠٠٠ عند التسليم) = ٢٠٬٠٠٠.
    expect(Number(row!.total) - Number(row!.paidAmount)).toBe(20000);
    expect(row!.workOrderId).toBe(workOrderId);
  });
});

describe("C — تسديد دفعة من المحطة (reception.collectOnInvoice)", () => {
  it("C1: التسديد يدخل درج القابض الحاليّ (موظفٌ ثانٍ يقبض ⇒ درجه هو) + idempotency لا يزدوج + قَبَضَها", async () => {
    await openReception(2);
    const wo = await createWorkOrder({
      branchId: 1, customerId: 1, baseVariantId: null, title: "لوحة",
      salePrice: "30000", quantity: 1, deposit: "10000", paymentMethod: "CASH",
    }, CASHIER);
    const workOrderId = (wo as { workOrderId: number }).workOrderId;
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, workOrderId));
    const delivered = await deliverWorkOrder({ workOrderId }, CASHIER); // بلا دفعة تسليم ⇒ متبقٍّ ٢٠٬٠٠٠ آجلاً

    // الموظّف الثاني (وردية مستقلّة) يقبض المتبقّي — الدفعة تدخل **درجه هو**.
    const shift2 = await openReception(5);
    const caller2 = await callerFor(5);
    const clientRequestId = "collect-c1-0001";
    const r1 = await caller2.reception.collectOnInvoice({
      invoiceId: delivered.invoiceId, amount: "20000.00", method: "CASH", clientRequestId,
    });
    expect(r1.collectedIntoShiftId).toBe(shift2.shiftId);

    // idempotency: نفس المفتاح ⇒ لا إيصال ثانٍ.
    await caller2.reception.collectOnInvoice({
      invoiceId: delivered.invoiceId, amount: "20000.00", method: "CASH", clientRequestId,
    });
    const receipts = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, delivered.invoiceId), eq(s.receipts.direction, "IN"), eq(s.receipts.shiftId, shift2.shiftId)));
    expect(receipts.length).toBe(1);
    expect(receipts[0].cashBucket).toBe("DRAWER");

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, delivered.invoiceId)))[0];
    expect(inv.paidAmount).toBe("30000.00");
    expect(inv.status).toBe("PAID");
    // ذمّة العميل صفّيت (processPayment).
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00");
    // «قَبَضَها» في الطابور = القابض الفعليّ (الموظّف الثاني) لا مُنشئ الفاتورة.
    const page = await listReceptionInvoices({ branchId: 1, sinceDays: 7 });
    const row = page.rows.find((r) => Number(r.id) === delivered.invoiceId);
    expect(row!.lastCollectorName).toBe("موظف الخدمة الثاني");
  });

  it("C2: فاتورة وردية RETAIL خارج النطاق ⇒ FORBIDDEN (ليست باباً على مبيعات التجزئة)", async () => {
    const retail = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    await db().insert(s.invoices).values({
      id: 901, invoiceNumber: "INV-RET-901", sourceType: "POS", sourceId: "c2-ret",
      branchId: 1, shiftId: retail.shiftId, customerId: 1, priceTier: "RETAIL",
      subtotal: "9000.00", taxAmount: "0.00", discountAmount: "0.00",
      total: "9000.00", costTotal: "0.00", status: "PENDING", paidAmount: "0.00", createdBy: 2,
    });
    const caller = await callerFor(2);
    await expect(caller.reception.collectOnInvoice({
      invoiceId: 901, amount: "9000.00", method: "CASH", clientRequestId: "collect-c2",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("C3: نقديّ بلا وردية مفتوحة ⇒ PRECONDITION_FAILED", async () => {
    const rec = await openReception(2);
    const sale = await directSale(rec.shiftId, "c3-sale");
    // فاتورة عليها متبقٍّ (نحقن متبقّياً عبر خفض paidAmount مباشرةً لغرض الحارس فقط).
    await db().update(s.invoices).set({ paidAmount: "0.00", status: "PENDING" })
      .where(eq(s.invoices.id, Number(sale.regularSale!.invoiceId)));
    // الموظف الثاني بلا أيّ وردية.
    const caller2 = await callerFor(5);
    await expect(caller2.reception.collectOnInvoice({
      invoiceId: Number(sale.regularSale!.invoiceId), amount: "1000.00", method: "CASH", clientRequestId: "collect-c3",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("R — بوّابة طابور القراءة وإعادة الطباعة", () => {
  it("warehouse/auditor ممنوعان؛ الكاشير يقرأ ويطبع؛ ومشغّل الطباعة يرى الطابور وجلبُه محكومٌ بعزل الموظّف", async () => {
    const rec = await openReception();
    await directSale(rec.shiftId, "r1-sale");

    for (const uid of [6, 7]) {
      const caller = await callerFor(uid);
      await expect(caller.reception.invoiceQueue({ sinceDays: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const cashierCaller = await callerFor(2);
    const ok = await cashierCaller.reception.invoiceQueue({ sinceDays: 7 });
    expect(ok.rows.length).toBe(1);
    // الكاشير مُنشئ الفاتورة (rec) ⇒ يجلبها للطباعة (invoiceViewProcedure + عزل الموظّف يطابق).
    const cashInvoice = await cashierCaller.sales.get({ invoiceId: ok.rows[0].id });
    expect(cashInvoice?.invoiceNumber).toBe(ok.rows[0].invoiceNumber);

    // مشغّل الطباعة (uid 8) يرى الطابور، لكن sales.get عبر invoiceViewProcedure محكومٌ بعزل
    // الموظّف (scopedOwnerId): يطبع فواتيره هو (طلب المالك «فواتيري»)، وفاتورةُ زميلٍ (أنشأها
    // الكاشير هنا) تعود null — سياسة عزل الموظّف الثابتة، لا تُضعَّف.
    const printCaller = await callerFor(8);
    const printable = await printCaller.reception.invoiceQueue({ sinceDays: 7 });
    expect(printable.rows).toHaveLength(1);
    const invoice = await printCaller.sales.get({ invoiceId: printable.rows[0].id });
    expect(invoice).toBeNull();
  });
});
