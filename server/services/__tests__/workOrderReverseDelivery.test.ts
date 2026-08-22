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
 *  (ز) بلا `reopen` ⇒ WIP المُعادُ فتحُه بالعكس يُفرَّغ **خسارةً معلنة** (`ADJUST_WIP_WASTE`
 *      بمفتاح `WO-REVERSE-WASTE:`) فيصفر صافي WIP للأمر عند إقفاله CANCELLED — ومع
 *      `reopen` لا هدرَ: الخامةُ قيدَ تنفيذٍ حيٍّ يُقفله التسليمُ الثاني.
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

/** أمرٌ خدميّ بعربونٍ **ودفعةِ تسليم** معاً — الحالةُ التي لم تغطِّها الاختبارات الأولى. */
async function deliveredServiceOrderWithBoth(reqId: string, deposit: string, atDelivery: string) {
  const r = await createWorkOrder({
    branchId: 1, customerId: 1, title: "خدمة بعربون ودفعة", quantity: 1,
    salePrice: "30000.00", deposit, paymentMethod: "CASH", shiftId: 1,
    materials: [], clientRequestId: reqId,
  } as never, { ...CASHIER, shiftId: 1 } as never);
  const woId = Number((r as { workOrderId: number }).workOrderId);
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  await deliverWorkOrder(
    { workOrderId: woId, payment: { amount: atDelivery, method: "CASH" }, clientRequestId: `${reqId}-dlv` } as never,
    CASHIER as never,
  );
  return woId;
}

const woOf = async (id: number) =>
  (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)))[0];
const invOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];

/**
 * صافي WIP للأمر من القيود **المخزَّنة فعلاً** — أربعُ محطّات تمرّ بها كلفةُ الموادّ:
 * CONSUME يفتحه (+amount)، وSALE يُقفله إلى COGS عند التسليم (−cost)، وRETURN يعيد فتحه
 * عند العكس (`cost` مخزَّنٌ سالباً بحكم §٥ ⇒ −cost)، وWASTE يُفرغه خسارةً (−amount).
 *
 * ⚠️ التمييزُ بـ`dedupeKey`/`entryType` لا بـ`postingProfile` — الأخير لا يُملأ إلّا مع
 * الدفتر المزدوج (OFF افتراضياً) ⇒ التأكيدُ عليه أخضرُ كاذبٌ لا يمسك شيئاً.
 */
async function wipNetForOrder(woId: number, invId: number) {
  const rows = await db().select({
    type: s.accountingEntries.entryType,
    key: s.accountingEntries.dedupeKey,
    invoiceId: s.accountingEntries.invoiceId,
    cost: s.accountingEntries.cost,
    amount: s.accountingEntries.amount,
  }).from(s.accountingEntries);
  let net = money(0);
  for (const r of rows) {
    const k = r.key ?? "";
    if (k === `WO-WIP-CONSUME:${woId}`) net = net.plus(money(r.amount ?? "0"));
    if (r.type === "SALE" && Number(r.invoiceId) === invId) net = net.minus(money(r.cost ?? "0"));
    if (k === `WO-REVERSE:${woId}`) net = net.minus(money(r.cost ?? "0"));
    if (k === `WO-REVERSE-WASTE:${woId}`) net = net.minus(money(r.amount ?? "0"));
  }
  return round2(net);
}

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

  it("⭐ (ز) استرجاعٌ بلا reopen: قيدُ هدرٍ بكامل كلفة الموادّ وصافي WIP للأمر يصفر", async () => {
    const woId = await deliveredServiceOrder("rv-9");
    const invId = Number((await woOf(woId)).invoiceId);

    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "رفض نهائيّ — الخامة هدر" }, MANAGER);

    // ٤ قطع × ٥٠٠ تكلفةً = ٢٠٠٠: قبل الإصلاح كان العكسُ يعيدها من COGS إلى WIP ثمّ يقفل
    // الأمرَ CANCELLED **بلا قيد هدر** ⇒ خامةٌ استُهلكت فيزيائياً وكلفتُها تتبخّر من P&L
    // وWIP يحمل رصيداً ميتاً إلى الأبد — خرقُ «لا دينار يضيع بصمت».
    const waste = (await db().select().from(s.accountingEntries))
      .filter((e) => e.dedupeKey === `WO-REVERSE-WASTE:${woId}`);
    expect(waste).toHaveLength(1);
    expect(waste[0].entryType).toBe("ADJUST");
    expect(round2(money(waste[0].amount ?? "0")).toFixed(2)).toBe("2000.00");
    expect(round2(money(waste[0].cost ?? "0")).toFixed(2)).toBe("2000.00");

    // الثابت: CONSUME − SALE + RETURN − WASTE = 0 — لا رصيدَ WIP خلف حالةٍ نهائية.
    expect((await wipNetForOrder(woId, invId)).toFixed(2)).toBe("0.00");

    // ⛔ الهدرُ قيدٌ فقط: الخامة خُصمت من المخزون عند البدء — لا حركةَ مصروفِ مخزونٍ ثانية.
    const wasteMoves = await db().select({ n: sql<number>`COUNT(*)` }).from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceType, "STOCK_EXPENSE"));
    expect(Number(wasteMoves[0].n)).toBe(0);
  });

  it("⭐ (ز) مع reopen لا قيدَ هدر: الخامةُ عادت قيدَ التنفيذ وWIP حيٌّ يُقفله التسليمُ الثاني", async () => {
    const woId = await deliveredServiceOrder("rv-10");
    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "خطأ تسليم — يُعاد", reopen: true }, MANAGER);
    const waste = (await db().select().from(s.accountingEntries))
      .filter((e) => (e.dedupeKey ?? "").startsWith("WO-REVERSE-WASTE:"));
    expect(waste).toHaveLength(0);
  });

  it("⭐ عربونٌ **ودفعةُ تسليم** معاً: كلُّ شقٍّ يُبرئ حسابَه — لا أمانةَ سالبة", async () => {
    // الثغرةُ التي أمسكتها مراجعة Codex ولم تغطِّها اختباراتي: كان العكسُ يُعيد فتح
    // **العربون وحده** كأمانة ثمّ يخصم الأمانةَ بكامل المردود ⇒ أمانةٌ سالبة بفارق دفعة
    // التسليم، ودفترٌ لا يوافق `customers.currentBalance`.
    const woId = await deliveredServiceOrderWithBoth("rv-8", "10000.00", "20000.00");

    await reverseWorkOrderDelivery({ workOrderId: woId, reason: "رفض بعد الاستلام" }, MANAGER);

    // ⚠️ `postingSourceComponents` **ليست عموداً** في القاعدة (تُستعمل للتحقّق في الذاكرة
    // فقط) — التأكيدُ عليها يقرأ `undefined` دائماً = أخضرُ كاذب، تماماً كـ`postingProfile`.
    // فالمرصدُ هو ما يُخزَّن فعلاً: قيدان منفصلان بمبلغَيهما وحاشيتَيهما.
    const outs = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    const byNote = (needle: string) =>
      round2(outs.filter((e) => (e.notes ?? "").includes(needle))
        .reduce((acc, e) => acc.plus(money(e.amount)), money(0)));

    // العربونُ ١٠٬٠٠٠ يُبرئ الأمانة، ودفعةُ التسليم ٢٠٬٠٠٠ تُعيد الذمّة — لا العكس.
    expect(byNote("حصّة العربون").toFixed(2)).toBe("10000.00");
    expect(byNote("حصّة دفعة التسليم").toFixed(2)).toBe("20000.00");
    // ومجموعُ ما خرج = كلُّ ما قُبض، لا أكثر ولا أقلّ.
    expect(round2(outs.reduce((a, e) => a.plus(money(e.amount)), money(0))).toFixed(2)).toBe("30000.00");

    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(round2(money(cust.currentBalance)).toFixed(2)).toBe("0.00");
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
