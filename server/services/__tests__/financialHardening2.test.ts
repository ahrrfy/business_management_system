// تحصين مالي صارم (٧ بنود) — اختبارات تمرّ عبر **الراوتر الفعلي** (لا تتجاوزه) + السلوك الجديد.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../saleService";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createWorkOrder, startWorkOrder, markWorkOrderReady, deliverWorkOrder } from "../workOrderService";
import { openShift } from "../shiftService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { reconcileSupplierBalances } from "../reconcileService";
import { money } from "../money";

const actor = { userId: 1, branchId: 1 };
const adminCtx = { req: { headers: {}, ip: "127.0.0.1" } as any, res: { cookie() {}, clearCookie() {} } as any, user: { id: 1, role: "admin", branchId: 1 } as any };
const caller = () => appRouter.createCaller(adminCtx);

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "expenses", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderImages", "workOrderItems", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}
const setStock = (variantId: number, branchId: number, qty: number) => db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
const count = async (where?: any) => (await db().select().from(s.accountingEntries)).length;

beforeEach(async () => { await reset(); await seedBase(); });

describe("#1 idempotency عبر الراوتر الفعلي (النقر المزدوج ⇒ معاملة واحدة)", () => {
  it("returns.create: نفس clientRequestId ⇒ مرتجع/استرداد واحد", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    // M8: البيع النقدي يَستوجب وردية مفتوحة.
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const sale = await createSale({ branchId: 1, shiftId, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "20.00", method: "CASH" } }, actor);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    const input = { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" as const }, clientRequestId: "ret-key-1" };
    await caller().returns.create(input);
    await caller().returns.create(input); // نقرة مزدوجة بنفس المفتاح
    const outReceipts = (await db().select().from(s.receipts)).filter((r) => r.direction === "OUT");
    expect(outReceipts).toHaveLength(1); // استرداد واحد فقط
    const returnEntries = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "RETURN");
    expect(returnEntries).toHaveLength(1);
  });

  it("sales.pay: نفس clientRequestId ⇒ دفعة واحدة", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] }, actor);
    // M5/M8: الدفع النقدي يَستوجب وردية مفتوحة.
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const input = { invoiceId: sale.invoiceId, amount: "10.00", method: "CASH" as const, clientRequestId: "pay-key-1" };
    await caller().sales.pay(input);
    await caller().sales.pay(input);
    expect((await db().select().from(s.receipts))).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN")).toHaveLength(1);
  });

  it("purchases.receive: نفس clientRequestId ⇒ استلام واحد", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createPurchaseOrder({ supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }] }, actor);
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    const input = { purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 5 }], clientRequestId: "recv-key-1" };
    await caller().purchases.receive(input);
    await caller().purchases.receive(input);
    expect((await db().select().from(s.inventoryMovements)).filter((m) => m.movementType === "IN")).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PURCHASE")).toHaveLength(1);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("25.00"); // 5×5.00 مرّة واحدة
  });

  it("vouchers.create: نفس clientRequestId ⇒ سند واحد", async () => {
    const input = { voucherType: "PAYMENT" as const, branchId: 1, amount: "30.00", paymentMethod: "CASH" as const, partyType: "OTHER" as const, description: "إيجار", clientRequestId: "vch-key-1" };
    const r1 = await caller().vouchers.create(input);
    const r2 = await caller().vouchers.create(input);
    expect(r2.receiptId).toBe(r1.receiptId); // نفس السند (replay)
    expect((await db().select().from(s.receipts))).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_OUT")).toHaveLength(1);
  });
});

describe("#2 عربون أمر الشغل يدخل الصندوق/الدفتر ويُحتسَب عند التسليم", () => {
  it("العربون ⇒ receipt(IN)+shiftId+PAYMENT_IN عند الإنشاء، ويُضمّ لمدفوع الفاتورة عند التسليم", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const wo = await createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH" }, actor);
    // إيصال العربون + قيد PAYMENT_IN موجودان وبشيفت.
    const depRcpt = (await db().select().from(s.receipts)).find((r) => Number(r.workOrderId) === wo.workOrderId && r.direction === "IN");
    expect(depRcpt).toBeTruthy();
    expect(depRcpt!.amount).toBe("5.00");
    expect(depRcpt!.shiftId).toBeTruthy();
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN")).toHaveLength(1);
    // التسليم: دفعة 15 ⇒ مدفوع الفاتورة = 5 (عربون) + 15 = 20، PAID، AR=0.
    await startWorkOrder(wo.workOrderId, { ...actor, role: "admin" });
    await markWorkOrderReady(wo.workOrderId, { ...actor, role: "admin" });
    await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "15.00", method: "CASH" } } as any, { ...actor, role: "admin" });
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.sourceId, `WO-${wo.workOrderId}`)))[0];
    expect(inv.paidAmount).toBe("20.00");
    expect(inv.status).toBe("PAID");
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00"); // لا مطالبة مزدوجة بالعربون
  });
});

describe("#3 تقريب IQD النقدي على الخادم", () => {
  it("بيع نقدي كامل بإجمالي غير مضاعف لـ250 ⇒ يُقرَّب + قيد ADJUST + النقد=المقرّب", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.productPrices).values([{ productUnitId: 1, priceTier: "WHOLESALE", price: "1240.00" }]);
    // M8: البيع النقدي يَستوجب وردية مفتوحة.
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const sale = await createSale({ branchId: 1, shiftId, sourceType: "POS", priceTier: "WHOLESALE", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], payment: { amount: "1240.00", method: "CASH" }, cashRoundIQD: true }, actor);
    expect(sale.total).toBe("1250.00"); // 1240 → 1250 (أقرب 250)
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.total).toBe("1250.00");
    expect(inv.cashRoundingAdjustment).toBe("10.00");
    expect(inv.paidAmount).toBe("1250.00");
    expect(inv.status).toBe("PAID");
    const adj = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "ADJUST");
    expect(adj).toHaveLength(1);
    expect(adj[0].amount).toBe("10.00");
    // النقد المستلم (PAYMENT_IN) = الإجمالي المقرّب.
    const pin = (await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN");
    expect(pin[0].amount).toBe("1250.00");
  });
});

describe("#4 سقف مرتجع الشراء (لا تضخيم قيمة)", () => {
  it("سعر إرجاع وحدة يتجاوز التكلفة المسجّلة ⇒ يُرفض", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "100.00" });
    await setStock(1, 1, 10); // مخزون كافٍ للإخراج
    // costPrice=4.00؛ نحاول الإرجاع بسعر 10.00 (>التكلفة) ⇒ رفض.
    await expect(createPurchaseReturn({ supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "10.00" }] }, actor)).rejects.toThrow();
    // بسعر ≤ التكلفة (4.00) ⇒ يُقبل.
    await expect(createPurchaseReturn({ supplierId: 1, branchId: 1, items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "4.00" }] }, actor)).resolves.toBeTruthy();
  });
});

describe("#5 ذرّية فتح الوردية", () => {
  it("فتح وردية ثانية لنفس الموظّف/الفرع ⇒ يُرفض", async () => {
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    await expect(openShift({ branchId: 1, openingBalance: "0" }, actor)).rejects.toThrow();
  });
  it("بعد الإغلاق يُسمح بفتح وردية جديدة", async () => {
    const sh = await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const { closeShift } = await import("../shiftService");
    await closeShift({ shiftId: sh.shiftId, countedCash: "0" }, { ...actor, role: "admin" });
    await expect(openShift({ branchId: 1, openingBalance: "0" }, actor)).resolves.toBeTruthy();
  });
});

describe("#2ب استرداد العربون عند إلغاء أمر الشغل (لا نقد عالق)", () => {
  it("إلغاء أمر بعربون مقبوض ⇒ receipt(OUT)+PAYMENT_OUT يعكس PAYMENT_IN (صافي الدفتر صفر)", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const wo = await createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH" }, actor);
    // ألغِ عبر الراوتر (managerProcedure ⇒ admin مسموح).
    await caller().workOrders.cancel({ workOrderId: wo.workOrderId });
    const rcpts = await db().select().from(s.receipts);
    const inRcpt = rcpts.filter((r) => Number(r.workOrderId) === wo.workOrderId && r.direction === "IN");
    const outRcpt = rcpts.filter((r) => Number(r.workOrderId) === wo.workOrderId && r.direction === "OUT");
    expect(inRcpt).toHaveLength(1);
    expect(outRcpt).toHaveLength(1);
    expect(outRcpt[0].amount).toBe("5.00");
    expect(outRcpt[0].shiftId).toBeTruthy(); // استرداد نقدي على وردية مفتوحة
    const entries = await db().select().from(s.accountingEntries);
    const pin = entries.filter((e) => e.entryType === "PAYMENT_IN");
    const pout = entries.filter((e) => e.entryType === "PAYMENT_OUT");
    expect(pin).toHaveLength(1);
    expect(pout).toHaveLength(1);
    // صافي النقد في الدفتر = PAYMENT_IN − PAYMENT_OUT = 0.
    expect(money(pin[0].amount).minus(money(pout[0].amount)).toFixed(2)).toBe("0.00");
    const wOrder = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, wo.workOrderId)))[0];
    expect(wOrder.status).toBe("CANCELLED");
  });
});

describe("#2ج حارس وردية لعربون نقدي عند الإنشاء", () => {
  it("عربون نقدي بلا وردية مفتوحة ⇒ يُرفض (CONFLICT)", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    // لا وردية مفتوحة.
    await expect(
      createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH" }, actor)
    ).rejects.toThrow();
    // لا أمر شغل أُنشئ (ROLLBACK كامل).
    expect(await db().select().from(s.workOrders)).toHaveLength(0);
  });
  it("بلا عربون ⇒ لا يلزم وردية", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    await expect(
      createWorkOrder({ branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "0", paymentMethod: "CASH" }, actor)
    ).resolves.toBeTruthy();
  });
});

describe("#1ب idempotency للمصروف وإنشاء أمر الشغل (النقر المزدوج)", () => {
  it("expenses.create: نفس clientRequestId ⇒ مصروف/صرف واحد", async () => {
    const input = { branchId: 1, category: "RENT" as const, amount: "30.00", paymentMethod: "CASH" as const, shiftId: null, clientRequestId: "exp-key-1" };
    await caller().expenses.create(input);
    await caller().expenses.create(input);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect((await db().select().from(s.receipts)).filter((r) => r.direction === "OUT")).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_OUT")).toHaveLength(1);
  });
  it("workOrders.create: نفس clientRequestId ⇒ أمر/عربون واحد", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    await openShift({ branchId: 1, openingBalance: "0" }, actor);
    const input = { branchId: 1, customerId: 1, baseVariantId: 1, title: "لوحة", salePrice: "20.00", deposit: "5.00", paymentMethod: "CASH" as const, clientRequestId: "wo-key-1" };
    const r1 = await caller().workOrders.create(input as any);
    const r2 = await caller().workOrders.create(input as any);
    expect((r2 as any).workOrderId).toBe((r1 as any).workOrderId); // replay
    expect(await db().select().from(s.workOrders)).toHaveLength(1);
    expect((await db().select().from(s.receipts)).filter((r) => r.direction === "IN")).toHaveLength(1); // عربون واحد
    expect((await db().select().from(s.accountingEntries)).filter((e) => e.entryType === "PAYMENT_IN")).toHaveLength(1);
  });
});

describe("#6 تدقيق تطابق ذمم الموردين (AP)", () => {
  it("يكشف انحراف currentBalance عن المُشتقّ من قيود المورد", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const po = await createPurchaseOrder({ supplierId: 1, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }] }, actor);
    const poItem = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 10 }] }, actor);
    // سليم الآن (AP=50 من القيود = الرصيد) ⇒ لا انحراف.
    expect(await reconcileSupplierBalances()).toHaveLength(0);
    // أفسد الرصيد يدوياً ⇒ يُكتشَف.
    await db().update(s.suppliers).set({ currentBalance: "999.00" }).where(eq(s.suppliers.id, 1));
    const issues = await reconcileSupplierBalances();
    expect(issues).toHaveLength(1);
    expect(issues[0].entity).toBe("supplier");
  });
});
