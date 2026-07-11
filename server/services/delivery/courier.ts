// courier — شاشة المندوب الذاتية «توصيلاتي» (طلبات المتجر B2C فقط، نموذج AR على العميل).
//
// السياق: dispatchOnlineOrder يُسند طلب متجر مؤكَّد لمندوب (onlineOrders.deliveryPartyId) وينشئ
// فاتورة على **ذمّة العميل** (COD غير مدفوع). هنا يؤكّد المندوب التسليم ويُحصّل النقد:
//   • الفاتورة تُسدَّد (paidAmount↑، حالة، ذمّة العميل↓) — الزبون لم يعُد مديناً.
//   • النقد بيد المندوب ⇒ عهدته ترتفع (deliveryParties.currentBalance += المحصَّل) + قيد DELIVERY_DISPATCH.
// لا نقد يدخل الدرج هنا (المندوب على الهاتف، لا وردية) — التسليم للمتجر لاحقاً عبر delivery.settle
// (موظّف باستلام النقد، SOD) الذي يخفض العهدة ويُدخل الدرج. لا ازدواج: الإيراد اعتُرف مرّة عند الإرسال
// (قيد SALE داخل createSale)، وهذا مجرّد تحصيل + نقل موقع النقد (ذمّة عميل → عهدة مندوب → درج).
//
// الهوية: يُحلّ partyId من ctx.user عبر deliveryParties.userId (ربط 0068) ⇒ عزل ذاتي صارم
// (المندوب لا يرى/يؤكّد إلا طلباته). لا نستعمل عزل الفرع — المندوب عابرٌ لفروع طلباته.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { customers, deliveryParties, invoiceItems, invoices, onlineOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { adjustCustomerBalance, adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { returnSale } from "../returnService";
import { withTx } from "../tx";

/** يحلّ جهة التوصيل المرتبطة بحساب المستخدم (المندوب). null إن لم يُربط الحساب بجهة نشطة. */
export async function resolveCourierPartyId(userId: number): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const row = (
    await db
      .select({ id: deliveryParties.id, isActive: deliveryParties.isActive })
      .from(deliveryParties)
      .where(eq(deliveryParties.userId, userId))
      .limit(1)
  )[0];
  if (!row || !row.isActive) return null;
  return Number(row.id);
}

export interface MyDeliveryRow {
  id: number;
  orderNumber: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  address: string | null;
  orderTotal: string;
  /** المبلغ المتبقّي تحصيله من الفاتورة (صافي − مسدَّد) — ما يجب أن يقبضه المندوب. */
  codDue: string;
  createdAt: Date;
}

export interface MyDeliveriesResult {
  linked: boolean;
  partyName: string | null;
  custodyBalance: string; // نقدٌ بذمّة المندوب (مُحصَّل لم يُورَّد بعد)
  toDeliver: MyDeliveryRow[]; // SHIPPED — قابلة للتأكيد
  delivered: MyDeliveryRow[]; // DELIVERED — سُلّمت (سجلّ حديث)
}

/** طلبات المندوب: قيد التوصيل (SHIPPED) + المُسلّمة حديثاً (DELIVERED) + عهدته الحالية. */
export async function listMyDeliveries(userId: number): Promise<MyDeliveriesResult> {
  const empty: MyDeliveriesResult = { linked: false, partyName: null, custodyBalance: "0", toDeliver: [], delivered: [] };
  const db = getDb();
  if (!db) return empty;
  const party = (
    await db
      .select({ id: deliveryParties.id, name: deliveryParties.name, isActive: deliveryParties.isActive, balance: deliveryParties.currentBalance })
      .from(deliveryParties)
      .where(eq(deliveryParties.userId, userId))
      .limit(1)
  )[0];
  if (!party || !party.isActive) return empty;
  const partyId = Number(party.id);

  const rows = await db
    .select({
      id: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      status: onlineOrders.status,
      governorate: onlineOrders.governorate,
      address: onlineOrders.shippingAddress,
      orderTotal: onlineOrders.total,
      createdAt: onlineOrders.orderDate,
      customerName: customers.name,
      customerPhone: customers.phone,
      invTotal: invoices.total,
      invPaid: invoices.paidAmount,
      invReturned: invoices.returnedTotal,
    })
    .from(onlineOrders)
    .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
    .leftJoin(invoices, eq(onlineOrders.invoiceId, invoices.id))
    .where(and(eq(onlineOrders.deliveryPartyId, partyId), inArray(onlineOrders.status, ["SHIPPED", "DELIVERED"])))
    .orderBy(desc(onlineOrders.id))
    .limit(120);

  const toDeliver: MyDeliveryRow[] = [];
  const delivered: MyDeliveryRow[] = [];
  for (const r of rows) {
    // COD المستحقّ = صافي الفاتورة (total − returned) − المسدَّد. للطلب المُرسَل حديثاً = total.
    const net = money(r.invTotal ?? r.orderTotal).minus(money(r.invReturned ?? "0"));
    const due = Decimal.max(net.minus(money(r.invPaid ?? "0")), 0);
    const row: MyDeliveryRow = {
      id: Number(r.id),
      orderNumber: r.orderNumber,
      status: r.status,
      customerName: r.customerName ?? null,
      customerPhone: r.customerPhone ?? null,
      governorate: r.governorate ?? null,
      address: r.address ?? null,
      orderTotal: String(r.orderTotal),
      codDue: toDbMoney(due),
      createdAt: r.createdAt,
    };
    (r.status === "DELIVERED" ? delivered : toDeliver).push(row);
  }
  return {
    linked: true,
    partyName: party.name,
    custodyBalance: String(party.balance ?? "0"),
    toDeliver,
    delivered: delivered.slice(0, 40),
  };
}

export interface ConfirmDeliveryResult {
  orderId: number;
  orderNumber: string;
  collected: string;
  custodyAfter: string;
  alreadyDelivered?: boolean;
}

/** تأكيد تسليم طلب متجر + تحصيل COD كاملاً. ذرّي: فاتورة تُسدَّد + ذمّة عميل↓ + عهدة المندوب↑. */
export async function confirmCourierDelivery(
  input: { onlineOrderId: number },
  actor: { userId: number },
): Promise<ConfirmDeliveryResult> {
  const partyId = await resolveCourierPartyId(actor.userId);
  if (partyId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "حسابك غير مرتبط بمندوب توصيل — راجع المدير" });
  }
  return withTx(async (tx) => {
    // ترتيب القفل يطابق مسار التوصيل (party ثم الفاتورة) لتجنّب تشابك مع settle/remittance.
    const partyRow = (
      await tx.select({ id: deliveryParties.id, balance: deliveryParties.currentBalance, isActive: deliveryParties.isActive }).from(deliveryParties).where(eq(deliveryParties.id, partyId)).for("update").limit(1)
    )[0];
    if (!partyRow) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    // إعادة فحص التفعيل تحت القفل (سباق تعطيل متزامن — مراجعة عدائية ١٢/٧): جهة عُطّلت لا تقبض عهدة جديدة.
    if (!partyRow.isActive) throw new TRPCError({ code: "FORBIDDEN", message: "جهة التوصيل مُعطَّلة — راجع المدير" });

    const order = (
      await tx.select().from(onlineOrders).where(eq(onlineOrders.id, input.onlineOrderId)).for("update").limit(1)
    )[0];
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    // IDOR: المندوب لا يؤكّد إلا طلباته المُسنَدة إليه.
    if (Number(order.deliveryPartyId) !== partyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذا الطلب ليس ضمن توصيلاتك" });
    }
    // يجب أن يكون مُرسَلاً (SHIPPED) أو مُسلَّماً (DELIVERED — استرداد idempotent). غيرهما: لم يُجهَّز بعد.
    if (order.status !== "SHIPPED" && order.status !== "DELIVERED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب ليس قيد التوصيل" });
    }
    if (!order.invoiceId) throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب بلا فاتورة — تعذّر التحصيل" });

    const inv = (
      await tx.select().from(invoices).where(eq(invoices.id, Number(order.invoiceId))).for("update").limit(1)
    )[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الطلب غير موجودة" });
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فاتورة الطلب ملغاة/مرتجعة — راجع المدير" });
    }

    // القيمة المُحصَّلة تُشتقّ من **الفاتورة** (صافي − مسدَّد) لا من حالة الطلب ⇒ التأكيد idempotent
    // وغير قابل للحجب: لو أُقفلت الحالة DELIVERED دون تحصيل (مثلاً مسارٌ آخر)، هذا يُكمل التحصيل؛
    // ولو سبق الدفع كاملاً، collected=0 (لا ازدواج). مراجعة عدائية ١٢/٧ (تعارض مساري DELIVERED).
    const wasDelivered = order.status === "DELIVERED";
    const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));
    const collected = Decimal.max(net.minus(money(inv.paidAmount ?? "0")), 0);

    if (!wasDelivered) await tx.update(onlineOrders).set({ status: "DELIVERED" }).where(eq(onlineOrders.id, order.id));

    let custodyAfter = money(partyRow.balance ?? "0");
    if (collected.gt(0)) {
      const newPaid = money(inv.paidAmount ?? "0").plus(collected);
      await tx
        .update(invoices)
        .set({ paidAmount: toDbMoney(newPaid), status: computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0"), paymentDate: new Date() })
        .where(eq(invoices.id, inv.id));
      // ذمّة العميل↓ (سدّد نقداً للمندوب).
      if (order.customerId != null) await adjustCustomerBalance(tx, Number(order.customerId), collected.neg());
      // عهدة المندوب↑ (يحمل النقد حتى يُورّده للمتجر).
      await adjustDeliveryBalance(tx, partyId, collected);
      // قيد تسوية ذمّة العميل (بلا إيصال درج — النقد بعهدة المندوب لا الدرج).
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        invoiceId: inv.id,
        customerId: order.customerId != null ? Number(order.customerId) : null,
        deliveryPartyId: partyId,
        amount: collected,
        dedupeKey: `ONLINE_COD_PAY:${inv.id}`,
        notes: `تحصيل COD متجر — ${order.orderNumber}`,
      });
      // قيد عهدة المندوب (نظير DELIVERY_DISPATCH لمسار أوامر الشغل — يظهر في كشف عهدة المندوب).
      await postEntry(tx, {
        entryType: "DELIVERY_DISPATCH",
        invoiceId: inv.id,
        deliveryPartyId: partyId,
        amount: collected,
        dedupeKey: `ONLINE_COD_CUSTODY:${inv.id}`,
        notes: `عهدة COD متجر — ${order.orderNumber}`,
      });
      custodyAfter = custodyAfter.plus(collected);
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      collected: toDbMoney(collected),
      custodyAfter: toDbMoney(custodyAfter),
      alreadyDelivered: wasDelivered && collected.isZero(),
    };
  });
}

export interface FailDeliveryResult {
  orderId: number;
  orderNumber: string;
  reversed: boolean;
  alreadyCancelled?: boolean;
}

/**
 * تعذّر التسليم (رفض الزبون/عنوان خاطئ): يعكس بيع الطلب المرفوض ذرّياً ويُلغيه.
 * البضاعة تعود للمخزون + قيد RETURN عاكس + تُصفّى ذمّة العميل عن الفاتورة + الفاتورة RETURNED + الطلب
 * CANCELLED (بسبب). بلا عهدة (لم يُحصَّل شيء). يُعاد استخدام returnSale المُختبَر (idempotent بمفتاح
 * `courier-fail:<order>` ⇒ استرداد آمن لو فشل تحديث الطلب بعد نجاح العكس). محصورٌ بطلبٍ **غير محصَّل**
 * (paidAmount=0): بعد التحصيل يكون إرجاعاً بعد التسليم (مدير)، لا «تعذّر تسليم».
 */
export async function failCourierDelivery(
  input: { onlineOrderId: number; reason: string },
  actor: { userId: number },
): Promise<FailDeliveryResult> {
  const partyId = await resolveCourierPartyId(actor.userId);
  if (partyId == null) throw new TRPCError({ code: "FORBIDDEN", message: "حسابك غير مرتبط بمندوب توصيل — راجع المدير" });
  const reason = (input.reason ?? "").trim();
  if (reason.length < 2) throw new TRPCError({ code: "BAD_REQUEST", message: "اذكر سبب تعذّر التسليم" });
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const order = (await db.select().from(onlineOrders).where(eq(onlineOrders.id, input.onlineOrderId)).limit(1))[0];
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
  if (Number(order.deliveryPartyId) !== partyId) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الطلب ليس ضمن توصيلاتك" });
  if (order.status === "CANCELLED") return { orderId: order.id, orderNumber: order.orderNumber, reversed: false, alreadyCancelled: true };
  if (order.status !== "SHIPPED") throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب ليس قيد التوصيل" });
  if (!order.invoiceId) throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب بلا فاتورة" });

  const inv = (await db.select({ paidAmount: invoices.paidAmount, branchId: invoices.branchId }).from(invoices).where(eq(invoices.id, Number(order.invoiceId))).limit(1))[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الطلب غير موجودة" });
  if (money(inv.paidAmount ?? "0").gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب محصَّل — الإرجاع بعد التسليم عبر المدير" });
  }

  // أسطر الإرجاع = كل بنود الفاتورة بكامل الكمية المتبقّية (طلب مرفوض كليّاً).
  const items = await db
    .select({ id: invoiceItems.id, baseQuantity: invoiceItems.baseQuantity, returnedBaseQuantity: invoiceItems.returnedBaseQuantity })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, Number(order.invoiceId)));
  const lines = items
    .map((i) => ({ invoiceItemId: Number(i.id), baseQuantity: Number(i.baseQuantity) - Number(i.returnedBaseQuantity ?? 0) }))
    .filter((l) => l.baseQuantity > 0);

  if (lines.length > 0) {
    // returnSale ذرّي: إعادة مخزون + عكس SALE + تصفير ذمّة العميل + الفاتورة RETURNED. actor.branchId=فرع
    // الفاتورة كي يمرّ فحص ملكية الفرع (المندوب عابرٌ للفروع). لا استرداد نقدي (paidAmount=0).
    await returnSale(
      { invoiceId: Number(order.invoiceId), lines, refund: null, restock: true, clientRequestId: `courier-fail:${order.id}` },
      { userId: actor.userId, branchId: Number(inv.branchId), role: "courier" },
    );
  }
  await db.update(onlineOrders).set({ status: "CANCELLED", cancelReason: reason }).where(eq(onlineOrders.id, order.id));
  return { orderId: order.id, orderNumber: order.orderNumber, reversed: lines.length > 0 };
}
