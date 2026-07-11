/**
 * اختبارات شاشة المندوب «توصيلاتي» — تحصيل COD لطلبات المتجر (نموذج AR على العميل).
 *
 * الثوابت المالية الحرجة (تُتحقَّق بمطابِقات reconcileService): تأكيد المندوب للتسليم يُسدّد الفاتورة
 * (ذمّة العميل↓) ويرفع عهدة المندوب↑ بنفس القيمة — بلا انحراف في أيٍّ من:
 *   • reconcileCustomerBalances (AR) — PAYMENT_IN بـinvoiceId مُستثنى من السندات، والـpaidAmount يمثّله.
 *   • reconcileDeliveryFloat (عهدة) — DELIVERY_DISPATCH يطابق زيادة currentBalance.
 *   • reconcileLedgerProfit — قيودنا revenue=cost=0 لا تمسّ P&L (الإيراد اعتُرف بـSALE عند الإرسال).
 * + العزل الذاتي (IDOR): مندوب لا يؤكّد إلا طلباته؛ حساب بلا جهة يُرفض؛ idempotency النقر المزدوج.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { confirmCourierDelivery, createDeliveryParty, failCourierDelivery, listMyDeliveries, resolveCourierPartyId, setDeliveryPartyActive, updateDeliveryParty } from "../deliveryService";
import { setOnlineOrderStatus } from "../storeAdmin/orderFulfillmentService";
import { adjustCustomerBalance } from "../ledgerService";
import { money } from "../money";
import { withTx } from "../tx";
import { reconcileCustomerBalances, reconcileDeliveryFloat, reconcileLedgerProfit } from "../reconcileService";

const MANAGER = { userId: 1, branchId: 1, role: "manager" };

const TABLES = [
  "idempotencyKeys", "creditApprovals", "accountingEntries", "receipts",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "onlineOrderItems", "onlineOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
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

/** يبذر الأساس + مندوبَين مرتبطَين بجهتين. يعيد partyIds. */
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cr1", name: "مندوب أ", email: "c1@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "cr2", name: "مندوب ب", email: "c2@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "6.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  // creditLimit: null = بلا حدّ ⇒ بيع آجل بلا موافقة ائتمان (نتفادى تبعيّة ساعة موافقة الائتمان في
  // اختبار موضوعه التحصيل لا الائتمان — الائتمان المؤقّت مسار dispatchOnlineOrder المُتحقَّق حيّاً).
  await d.insert(s.customers).values({ id: 1, name: "زبون متجر", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  const { id: partyA } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "جهة أ", userId: 3, branchId: 1 }, MANAGER);
  const { id: partyB } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "جهة ب", userId: 4, branchId: 1 }, MANAGER);
  return { partyA, partyB };
}

/**
 * يُهيّئ طلب متجر في حالة «مع المندوب» (SHIPPED) كما يتركه dispatchOnlineOrder:
 * فاتورة ONLINE حقيقية على ذمّة العميل (عبر createSale — بيع + مخزون + قيد SALE + AR)، ثم طلبٌ
 * مربوطٌ بها ومُسنَدٌ للمندوب. يعيد {orderId, invoiceId, total}.
 */
async function shippedOrder(qty: number, orderNumber: string, partyId: number): Promise<{ orderId: number; invoiceId: number; total: string }> {
  const d = db();
  const sale = await createSale(
    { branchId: 1, customerId: 1, sourceType: "ONLINE", priceTier: "RETAIL", lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }] },
    MANAGER,
  );
  const total = (qty * 10).toFixed(2);
  await d.insert(s.onlineOrders).values({
    orderNumber, customerId: 1, branchId: 1,
    subtotal: total, shippingCost: "0", taxAmount: "0", total,
    status: "SHIPPED", invoiceId: sale.invoiceId, deliveryPartyId: partyId,
    shippingAddress: "بغداد - الكرادة", governorate: "baghdad",
  });
  const orderId = Number((await d.select({ id: s.onlineOrders.id }).from(s.onlineOrders).where(eq(s.onlineOrders.orderNumber, orderNumber)).limit(1))[0].id);
  return { orderId, invoiceId: sale.invoiceId, total };
}

async function order(id: number) {
  return (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, id)).limit(1))[0];
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)).limit(1))[0];
}
async function customerBalance(id: number): Promise<string> {
  return String((await db().select({ b: s.customers.currentBalance }).from(s.customers).where(eq(s.customers.id, id)).limit(1))[0]?.b ?? "0");
}
async function partyBalance(id: number): Promise<string> {
  return String((await db().select({ b: s.deliveryParties.currentBalance }).from(s.deliveryParties).where(eq(s.deliveryParties.id, id)).limit(1))[0]?.b ?? "0");
}
async function stockOf(variantId: number): Promise<number> {
  return Number((await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1))).limit(1))[0]?.q ?? 0);
}
async function reconcileClean() {
  expect(await reconcileCustomerBalances()).toEqual([]);
  expect(await reconcileDeliveryFloat()).toEqual([]);
  expect(await reconcileLedgerProfit()).toEqual([]);
}

describe("courier «توصيلاتي» — تحصيل COD لطلب متجر", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("تأكيد التسليم يُسدّد الفاتورة + يرفع عهدة المندوب + كل المطابِقات نظيفة", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(2, "ORD-C1", partyA); // 2 × 10 = 20
    // حالة ما بعد الإرسال: SHIPPED، فاتورة على ذمّة العميل، لا عهدة بعد.
    expect((await order(o.orderId)).status).toBe("SHIPPED");
    expect(await customerBalance(1)).toBe("20.00"); // AR = total (غير مدفوع)
    expect(await partyBalance(partyA)).toBe("0.00");
    await reconcileClean();

    // المندوب أ (userId 3) يؤكّد التسليم والتحصيل.
    const res = await confirmCourierDelivery({ onlineOrderId: o.orderId }, { userId: 3 });
    expect(res.collected).toBe("20.00");
    expect((await order(o.orderId)).status).toBe("DELIVERED");
    const inv = await invoice(o.invoiceId);
    expect(inv.paidAmount).toBe("20.00");
    expect(inv.status).toBe("PAID");
    expect(await customerBalance(1)).toBe("0.00"); // AR صُفّي
    expect(await partyBalance(partyA)).toBe("20.00"); // عهدة المندوب = المُحصَّل
    await reconcileClean();
  });

  it("idempotency: تأكيد مزدوج ⇒ alreadyDelivered بلا ازدواج تحصيل", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(1, "ORD-C2", partyA);
    const first = await confirmCourierDelivery({ onlineOrderId: o.orderId }, { userId: 3 });
    expect(first.collected).toBe("10.00");
    const second = await confirmCourierDelivery({ onlineOrderId: o.orderId }, { userId: 3 });
    expect(second.alreadyDelivered).toBe(true);
    expect(second.collected).toBe("0.00");
    expect(await customerBalance(1)).toBe("0.00");
    expect(await partyBalance(partyA)).toBe("10.00"); // لم تتضاعف
    await reconcileClean();
  });

  it("IDOR: مندوب آخر لا يؤكّد طلباً ليس ضمن توصيلاته (FORBIDDEN)", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(1, "ORD-C3", partyA);
    // المندوب ب (userId 4) — الطلب مُسنَد لجهة أ.
    await expect(confirmCourierDelivery({ onlineOrderId: o.orderId }, { userId: 4 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await order(o.orderId)).status).toBe("SHIPPED"); // لم يتغيّر
    expect(await customerBalance(1)).toBe("10.00");
  });

  it("حساب غير مرتبط بجهة ⇒ resolve=null والتأكيد يُرفض", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(1, "ORD-C4", partyA);
    expect(await resolveCourierPartyId(1)).toBeNull(); // المدير بلا جهة
    await expect(confirmCourierDelivery({ onlineOrderId: o.orderId }, { userId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listMyDeliveries: يعزل طلبات المندوب ويحسب COD المستحقّ", async () => {
    const { partyA, partyB } = await seedParties();
    await shippedOrder(3, "ORD-C5", partyA); // 30 لجهة أ
    await shippedOrder(1, "ORD-C6", partyB); // 10 لجهة ب
    const mine = await listMyDeliveries(3); // المندوب أ
    expect(mine.linked).toBe(true);
    expect(mine.toDeliver).toHaveLength(1);
    expect(mine.toDeliver[0].orderNumber).toBe("ORD-C5");
    expect(mine.toDeliver[0].codDue).toBe("30.00");
    // حساب غير مرتبط ⇒ linked=false، قائمة فارغة.
    const none = await listMyDeliveries(1);
    expect(none.linked).toBe(false);
    expect(none.toDeliver).toHaveLength(0);
  });

  it("حارس التسريب: «تم التسليم» الموظّفي محجوب لطلب مندوب غير محصَّل", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(2, "ORD-C7", partyA); // فاتورة غير مدفوعة
    // الموظّف يحاول إنهاءه DELIVERED بلا تحصيل ⇒ محجوب (وإلا يُخفي COD إلى الأبد).
    await expect(setOnlineOrderStatus({ id: o.orderId, status: "DELIVERED", scopedBranchId: null }, 1)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await order(o.orderId)).status).toBe("SHIPPED");
    expect(await customerBalance(1)).toBe("20.00"); // AR سليم
  });

  it("عربون جزئي: التحصيل = صافي الفاتورة − المسدَّد", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(2, "ORD-C8", partyA); // total 20
    // محاكاة عربون مسبق 5 (paidAmount + خفض ذمّة العميل معاً — حالة متّسقة).
    await withTx(async (tx) => {
      await tx.execute(sql`UPDATE invoices SET paidAmount='5.00', invoiceStatus='PARTIALLY_PAID' WHERE id=${o.invoiceId}`);
      await adjustCustomerBalance(tx, 1, money("5").neg());
    });
    expect(await customerBalance(1)).toBe("15.00");
    const res = await confirmCourierDelivery({ onlineOrderId: o.orderId }, { userId: 3 });
    expect(res.collected).toBe("15.00"); // 20 − 5
    expect((await invoice(o.invoiceId)).status).toBe("PAID");
    expect(await customerBalance(1)).toBe("0.00");
    expect(await partyBalance(partyA)).toBe("15.00");
    await reconcileClean();
  });

  it("حارس اليُتْم: تعطيل/فكّ ربط جهة عليها طلب قيد التوصيل محجوب", async () => {
    const { partyA } = await seedParties();
    await shippedOrder(1, "ORD-C9", partyA);
    await expect(setDeliveryPartyActive(partyA, false, { userId: 1, branchId: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(updateDeliveryParty({ id: partyA, userId: null }, { userId: 1, branchId: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("جهة معطَّلة (بلا طلبات): resolve=null و linked=false", async () => {
    const { partyB } = await seedParties();
    await setDeliveryPartyActive(partyB, false, { userId: 1, branchId: 1 }); // لا طلبات ⇒ مسموح
    expect(await resolveCourierPartyId(4)).toBeNull();
    expect((await listMyDeliveries(4)).linked).toBe(false);
  });

  it("تعذّر التسليم: يعكس البيع (إعادة مخزون + تصفير ذمّة + فاتورة RETURNED + طلب CANCELLED) والمطابِقات نظيفة", async () => {
    const { partyA } = await seedParties();
    const before = await stockOf(1); // 100
    const o = await shippedOrder(2, "ORD-F1", partyA); // خصم مخزون 2 ⇒ 98
    expect(await stockOf(1)).toBe(before - 2);
    expect(await customerBalance(1)).toBe("20.00");

    const res = await failCourierDelivery({ onlineOrderId: o.orderId, reason: "رفض الزبون الاستلام" }, { userId: 3 });
    expect(res.reversed).toBe(true);
    expect(await stockOf(1)).toBe(before); // أُعيدت البضاعة للمخزون
    expect(await customerBalance(1)).toBe("0.00"); // ذمّة العميل صُفّيت
    expect((await invoice(o.invoiceId)).status).toBe("RETURNED");
    const ord = await order(o.orderId);
    expect(ord.status).toBe("CANCELLED");
    expect(ord.cancelReason).toBe("رفض الزبون الاستلام");
    expect(await partyBalance(partyA)).toBe("0.00"); // بلا عهدة (لم يُحصَّل)
    await reconcileClean();
  });

  it("تعذّر التسليم: IDOR (مندوب آخر) + idempotent (استدعاء ثانٍ) + حجب طلبٍ محصَّل", async () => {
    const { partyA } = await seedParties();
    const o = await shippedOrder(1, "ORD-F2", partyA);
    // مندوب آخر (userId 4) لا يُلغي طلب جهة أ.
    await expect(failCourierDelivery({ onlineOrderId: o.orderId, reason: "اختبار" }, { userId: 4 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // إلغاء صحيح ثم استدعاء ثانٍ ⇒ alreadyCancelled بلا عكس مزدوج.
    await failCourierDelivery({ onlineOrderId: o.orderId, reason: "عنوان خاطئ" }, { userId: 3 });
    const again = await failCourierDelivery({ onlineOrderId: o.orderId, reason: "عنوان خاطئ" }, { userId: 3 });
    expect(again.alreadyCancelled).toBe(true);
    await reconcileClean();

    // طلب محصَّل (paidAmount>0) لا يُعذَّر تسليمه (يُرجَع بعد التسليم عبر المدير).
    const o2 = await shippedOrder(1, "ORD-F3", partyA);
    await confirmCourierDelivery({ onlineOrderId: o2.orderId }, { userId: 3 }); // حُصِّل
    // بعد التحصيل الطلب DELIVERED لا SHIPPED ⇒ يُرفض بـ«ليس قيد التوصيل».
    await expect(failCourierDelivery({ onlineOrderId: o2.orderId, reason: "متأخّر" }, { userId: 3 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// مساعد: يعيد partyIds من آخر بذرة (seedBase تُنفَّذ في beforeEach). نعيد قراءتها بالاسم لتفادي حالة مشتركة.
async function seedParties(): Promise<{ partyA: number; partyB: number }> {
  const d = db();
  const a = (await d.select({ id: s.deliveryParties.id }).from(s.deliveryParties).where(eq(s.deliveryParties.userId, 3)).limit(1))[0];
  const b = (await d.select({ id: s.deliveryParties.id }).from(s.deliveryParties).where(eq(s.deliveryParties.userId, 4)).limit(1))[0];
  return { partyA: Number(a.id), partyB: Number(b.id) };
}
