/**
 * استرجاعُ أمر شغلٍ مُسلَّم — إغلاقُ الثقب الأسود (٢٠/٨).
 *
 * **قبل هذا:** أمرُ شغلٍ **خدميّ خالص** بعد التسليم بلا مخرجٍ إطلاقاً — كلّ بابٍ يُحيل إلى
 * مغلق: الإلغاء يرفض المُسلَّم، و`sales.cancel` يرفض WORKORDER، و`sales.correct` كذلك،
 * و`returns.create` يشترط بنداً **وفاتورةُ الخدمة الخالصة بلا بنود**. فتبقى الفاتورة وقيدُ
 * البيع والذمّة حيّةً للأبد على طلبٍ رفضه الزبون.
 *
 * الثوابت المحروسة:
 *  (أ) خدميّ خالصٌ مُسلَّم ⇒ يُعكَس: الفاتورة RETURNED، والذمّة تسقط، والمقبوض يُردّ نقداً.
 *  (ب) **الميزان**: `Σ(BID) − Σ(العكس) = 0` لكل دور — لا إيرادَ ولا تكلفةَ يبقيان معلَّقين.
 *  (ج) `reopen` يُعيده READY **ويفكّ الفاتورة** — وإلّا اصطدمت إعادةُ التسليم بقيدٍ فريد.
 *  (د) ما ليس مُسلَّماً ⇒ رفض. وإرساليةٌ حيّة ⇒ رفض.
 *  (هـ) عكسٌ مكرَّرٌ بنفس المفتاح ⇒ لا قيدَ ثانٍ ولا ردَّ ثانٍ.
 *  (و) صفرُ حركة مخزون في كلّ ما سبق.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { startWorkOrder, markWorkOrderReady } from "../workOrder/lifecycle";
import { deliverWorkOrder } from "../workOrder/deliver";
import { reverseWorkOrderDelivery } from "../workOrder/reverseDelivery";
import { money, round2 } from "../money";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "m", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.products).values([{ id: 1, name: "ورق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  // وردية استقبالٍ مفتوحة — يلزمها القبضُ عند التسليم والردُّ عند العكس.
  await d.insert(s.shifts).values([
    { id: 1, branchId: 1, userId: 2, shiftType: "RECEPTION", status: "OPEN", openingCash: "500000.00" },
  ] as never);
});

/** أمرٌ خدميّ خالص (بلا `baseVariantId`) ⇒ فاتورتُه **بلا بنود** — الحالة المسدودة بعينها. */
async function deliveredServiceOrder(reqId: string, deposit = "0") {
  const r = await createWorkOrder({
    branchId: 1, customerId: 1, title: "تصميم وطباعة", quantity: 1,
    salePrice: "30000.00", deposit,
    ...(deposit !== "0" ? { paymentMethod: "CASH", shiftId: 1 } : {}),
    materials: [{ variantId: 1, baseQuantity: 4 }], clientRequestId: reqId,
  } as never, { ...CASHIER, shiftId: 1 } as never);
  const woId = Number((r as { workOrderId: number }).workOrderId);
  await startWorkOrder(woId, CASHIER);
  await markWorkOrderReady(woId, CASHIER);
  await deliverWorkOrder({ workOrderId: woId, payment: null, clientRequestId: `${reqId}-dlv` } as never, CASHIER as never);
  return woId;
}

const woOf = async (id: number) =>
  (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)))[0];
const invOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];

/** ميزانُ الأدوار من مكوّنات القيود: يجب أن يصفر بين البيع وعكسه. */
async function roleNet() {
  const rows = await db().select({
    type: s.accountingEntries.entryType,
    revenue: s.accountingEntries.revenue,
    cost: s.accountingEntries.cost,
    amount: s.accountingEntries.amount,
  }).from(s.accountingEntries).where(sql`${s.accountingEntries.entryType} IN ('SALE','RETURN')`);
  let revenue = money(0), cost = money(0);
  for (const r of rows) {
    revenue = revenue.plus(money(r.revenue ?? "0"));
    cost = cost.plus(money(r.cost ?? "0"));
  }
  return { revenue: round2(revenue), cost: round2(cost) };
}

describe("استرجاع أمر شغل مُسلَّم", () => {
  it("⭐ (أ)+(ب) خدميّ خالصٌ مُسلَّم يُعكَس، والفاتورة RETURNED، والميزان يصفر", async () => {
    const woId = await deliveredServiceOrder("rv-1");
    const before = await woOf(woId);
    expect(before.status).toBe("DELIVERED");
    const invId = Number(before.invoiceId);
    // الحالةُ المسدودة بعينها: صفرُ بنودٍ ⇒ `returns.create` عاجزٌ عنها بنيوياً.
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invId));
    expect(items).toHaveLength(0);

    const res = await reverseWorkOrderDelivery(
      { workOrderId: woId, reason: "رفض الزبون العمل المُسلَّم" },
      MANAGER,
    );
    expect(res.delegatedToReturn).toBe(false);

    const inv = await invOf(invId);
    expect(inv.status).toBe("RETURNED");
    expect(round2(money(inv.returnedTotal ?? "0")).toFixed(2)).toBe("30000.00");

    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(round2(money(cust.currentBalance)).toFixed(2)).toBe("0.00");

    const net = await roleNet();
    expect(net.revenue.toFixed(2)).toBe("0.00");
    expect(net.cost.toFixed(2)).toBe("0.00");

    const wo = await woOf(woId);
    expect(wo.status).toBe("CANCELLED");
    expect(wo.cancelReason).toBe("رفض الزبون العمل المُسلَّم");
    expect(Number(wo.cancelledBy)).toBe(MANAGER.userId);

    // **صفٌّ تدقيقيٌّ واحدٌ لا صفّان**: كان الراوتر يكتب `workOrder.reverseDelivery` أيضاً
    // فوق كتابة الخدمة ⇒ حدثان في الخطّ الزمنيّ لعمليةٍ واحدة، أحدهما أفقرُ بياناً،
    // والقارئُ لا يعرف أوقعت مرّتين أم لا. والفرعُ يُكتب (كان يسقط في ctx المُصنَّع).
    const logs = await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "workOrder.reverseDelivery"));
    expect(logs).toHaveLength(1);
    expect(Number(logs[0].branchId)).toBe(1);
    expect((logs[0].newValue as { refundedTotal: string }).refundedTotal).toBe("0.00");
  });

  it("⭐ (ب) المقبوض يُردّ فعلاً بإيصال OUT نقديّ من درج الاستقبال", async () => {
    const woId = await deliveredServiceOrder("rv-2", "10000.00");
    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "أعاده المندوب" }, MANAGER);

    const outs = await db().select().from(s.receipts).where(and(
      eq(s.receipts.workOrderId, woId), eq(s.receipts.direction, "OUT"),
    ));
    const total = outs.reduce((sum, r) => sum.plus(money(r.amount)), money(0));
    // ثابت #638: لا يبقى في المكتبة مالٌ هو للعميل بعد سقوط البيع.
    expect(round2(total).toFixed(2)).toBe("10000.00");
    expect(outs.every((r) => r.cashBucket === "DRAWER" && r.status === "COMPLETED")).toBe(true);
  });

  it("⭐ (ج) reopen يعيده READY ويفكّ الفاتورة فتمكن إعادة التسليم", async () => {
    const woId = await deliveredServiceOrder("rv-3");
    await reverseWorkOrderDelivery(
      { workOrderId: woId, reason: "خطأ في التسليم", reopen: true },
      MANAGER,
    );
    const wo = await woOf(woId);
    expect(wo.status).toBe("READY");
    // بلا فكّ الارتباط يصطدم التسليمُ الثاني بقيد `uq_wo_invoice` ⇒ يستحيل استعمال reopen.
    expect(wo.invoiceId).toBeNull();
    expect(wo.deliveredAt).toBeNull();
  });

  it("⭐ (د) ما ليس مُسلَّماً يُرفَض", async () => {
    const r = await createWorkOrder({
      branchId: 1, customerId: 1, title: "قيد التنفيذ", quantity: 1, salePrice: "5000.00", deposit: "0",
      materials: [{ variantId: 1, baseQuantity: 1 }], clientRequestId: "rv-4",
    } as never, CASHIER);
    const woId = Number((r as { workOrderId: number }).workOrderId);
    await expect(
      reverseWorkOrderDelivery({ workOrderId: woId, reason: "أيّ سبب" }, MANAGER),
    ).rejects.toThrowError(/مُسلَّم/);
  });

  it("⭐ (هـ) عكسٌ مكرَّرٌ بنفس المفتاح لا يُنتج قيداً ولا ردّاً ثانياً", async () => {
    const woId = await deliveredServiceOrder("rv-5", "10000.00");
    const key = "rev-idem-1";
    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "رفض", clientRequestId: key }, MANAGER);
    const entriesAfter1 = Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.accountingEntries))[0].n);
    const outsAfter1 = Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.receipts)
      .where(eq(s.receipts.direction, "OUT")))[0].n);

    const replay = await reverseWorkOrderDelivery({ workOrderId: woId, reason: "رفض", clientRequestId: key }, MANAGER);
    expect(replay.replayed).toBe(true);
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.accountingEntries))[0].n)).toBe(entriesAfter1);
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.receipts)
      .where(eq(s.receipts.direction, "OUT")))[0].n)).toBe(outsAfter1);
  });

  it("⭐ (و) صفرُ حركة مخزون: الخامة استُهلكت ولا تعود صنفاً صالحاً", async () => {
    const woId = await deliveredServiceOrder("rv-6");
    const before = Number((await db().select().from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0].quantity);
    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "رفض" }, MANAGER);
    const after = Number((await db().select().from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0].quantity);
    expect(after).toBe(before);
  });

  it("لا يُعكَس ما عُكِس: الفاتورة المرتجعة تُرفَض ثانيةً", async () => {
    const woId = await deliveredServiceOrder("rv-7");
    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "رفض", reopen: true }, MANAGER);
    // بعد reopen حالتُه READY ⇒ يرفضه حارس «مُسلَّم فقط».
    await expect(
      reverseWorkOrderDelivery({ workOrderId: woId, reason: "ثانيةً" }, MANAGER),
    ).rejects.toThrowError(/مُسلَّم/);
  });
});
