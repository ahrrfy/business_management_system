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
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { customers, deliveryConsignments, deliveryParties, invoiceItems, invoices, onlineOrders } from "../../../drizzle/schema";
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
  /** المعرّف الطبيعيّ للصفّ: onlineOrders.id للطلب، deliveryConsignments.id للإرسالية. */
  id: number;
  /** مصدر الصفّ — يحدّد أيّ mutation يستدعيها التأكيد (طلب متجر vs إرسالية استقبال). */
  kind: "online" | "consignment";
  orderNumber: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  address: string | null;
  orderTotal: string;
  /** المبلغ المتبقّي تحصيله (صافي الفاتورة − مسدَّد للمتجر، أو codAmount − collectedAmount للإرسالية). */
  codDue: string;
  /** ١٠/٨ (تمرير كامل): أجرة المندوب — يقبضها من الزبون **فوق** codDue ويحتفظ بها (لا تُورَّد). */
  courierFee: string;
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
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      invTotal: invoices.total,
      invPaid: invoices.paidAmount,
      invReturned: invoices.returnedTotal,
      // ١٠/٨ (تمرير كامل): الأجرة للمندوب — للفواتير الجديدة فقط (deliveryFee=0)؛ القديمة
      // شحنُها داخل codDue أصلاً فلا أجرة إضافية فوقه.
      shippingCost: sql<string>`CASE WHEN CAST(${invoices.deliveryFee} AS DECIMAL(15,2)) > 0 THEN '0.00' ELSE COALESCE(${onlineOrders.shippingCost}, '0.00') END`,
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
      kind: "online",
      orderNumber: r.orderNumber,
      status: r.status,
      customerName: r.customerName ?? null,
      customerPhone: r.customerPhone ?? null,
      governorate: r.governorate ?? null,
      address: r.address ?? null,
      orderTotal: String(r.orderTotal),
      codDue: toDbMoney(due),
      courierFee: toDbMoney(money(r.shippingCost ?? "0")),
      createdAt: r.createdAt,
    };
    (r.status === "DELIVERED" ? delivered : toDeliver).push(row);
  }

  // إرساليات الاستقبال (deliveryConsignments) المُسنَدة لهذه الجهة والتي لم تُورَّد بعد
  // (remittanceId IS NULL). العهدة تُرفَع عند الإرسال والتسوية عند التوريد؛ هنا المندوب يرى ما
  // يحمله ويختم «سلّمتُ» (courierDeliveredAt) كإفصاحٍ تشغيليّ بحت — لا يمسّ أيّ مالٍ (§٥). نقصر
  // على DISPATCHED/PARTIAL (نفس حارس التأكيد): إرساليةٌ مُرجَعة/مشطوبة/مدفوعةٌ كاملاً غير قابلة
  // للختم فلا تُعرَض بزرٍّ ميّت. codDue = codAmount − collectedAmount (نموذج العهدة، لا الفاتورة).
  const cnRows = await db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      status: deliveryConsignments.status,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
      createdAt: deliveryConsignments.createdAt,
      recipientName: deliveryConsignments.recipientName,
      recipientPhone: deliveryConsignments.recipientPhone,
      deliveryAddress: deliveryConsignments.deliveryAddress,
      deliveryFee: deliveryConsignments.deliveryFee,
      feeCollection: deliveryConsignments.feeCollection,
      invTotal: invoices.total,
      custName: customers.name,
      custPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .where(and(
      eq(deliveryConsignments.partyId, partyId),
      isNull(deliveryConsignments.remittanceId),
      inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
    ))
    .orderBy(desc(deliveryConsignments.id))
    .limit(120);

  for (const r of cnRows) {
    const due = Decimal.max(money(r.codAmount).minus(money(r.collectedAmount ?? "0")), 0);
    const row: MyDeliveryRow = {
      id: Number(r.id),
      kind: "consignment",
      orderNumber: r.consignmentNumber,
      status: r.status,
      customerName: r.recipientName ?? r.custName ?? null,
      customerPhone: r.recipientPhone ?? r.custPhone ?? null,
      governorate: null,
      address: r.deliveryAddress ?? null,
      orderTotal: String(r.invTotal ?? toDbMoney(due)),
      codDue: toDbMoney(due),
      // COURIER = يقبض أجرته من الزبون بنفسه فوق COD؛ COUNTER/SHOP لا يقبض من الزبون شيئاً فوقه.
      courierFee: toDbMoney(r.feeCollection === "COURIER" ? money(r.deliveryFee ?? "0") : money(0)),
      createdAt: r.createdAt,
    };
    (r.courierDeliveredAt ? delivered : toDeliver).push(row);
  }

  // دمج المصدرين بترتيب زمنيّ نازل (الأحدث أولاً) — كلا القائمتين مبنيّتان أصلاً بترتيب المعرّف
  // النازل لكلٍّ على حدة، والفرز الموحّد يمنع تكتّل مصدرٍ فوق الآخر.
  const byRecent = (a: MyDeliveryRow, b: MyDeliveryRow) => b.createdAt.getTime() - a.createdAt.getTime();
  toDeliver.sort(byRecent);
  delivered.sort(byRecent);
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
    // مراجعة عدائية ٩/٨ — الشقّ الثاني من حارس ازدواج العهدة (نظير رفض ONLINE في dispatchInvoice):
    // لو أُسندت فاتورة الطلب إرساليةً من مسار الاستقبال (بيانات قديمة/التفاف API) فعهدتُها ودورةُ
    // تحصيلها هناك — تأكيدُها هنا يرفع العهدة مرّةً ثانية بمفتاح dedupe مختلف لنقدٍ واحد.
    // المفتوحة فقط (DISPATCHED/PARTIAL): إرسالية مغلقة (وُرِّدت/أُرجعت/شُطبت) لا خطرَ ازدواجٍ
    // منها — التحصيل هنا يُشتقّ من متبقّي الفاتورة فيصير صفراً بعد التوريد؛ ورفضُها كان يقفل
    // ختم DELIVERED على طلبٍ سُلِّم فعلاً إلى الأبد.
    const cnDup = (
      await tx
        .select({ n: deliveryConsignments.consignmentNumber })
        .from(deliveryConsignments)
        .where(and(
          eq(deliveryConsignments.invoiceId, Number(inv.id)),
          inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
        ))
        .limit(1)
    )[0];
    if (cnDup) {
      throw new TRPCError({ code: "CONFLICT", message: `فاتورة الطلب مُسنَدة لإرسالية استقبال بالطريق (${cnDup.n}) — تحصيلها عبر توريد المندوب هناك` });
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

export interface ConfirmConsignmentResult {
  consignmentId: number;
  consignmentNumber: string;
  deliveredAt: Date;
  alreadyDelivered?: boolean;
}

/**
 * تأكيد المندوب تسليمَ إرسالية استقبال (شاشة «توصيلاتي») — **ختمٌ تشغيليّ بحت** لا أثر ماليّ له.
 *
 * على النقيض من طلب المتجر (confirmCourierDelivery يُحصّل COD ويرفع العهدة)، إرسالية الاستقبال
 * رُفعت عهدتها **عند الإرسال** (dispatch) وتُسوَّى الفاتورة **عند توريد المندوب** (recordDeliveryRemittance
 * بيد الموظّف). فلو مسّ هذا التأكيدُ المالَ لَحُسِب مرّتين. لذا يضبط `courierDeliveredAt` **وحده**
 * (المندوب يقول: سلّمتُ) ولا يمسّ status/collectedAmount/remittanceId/settledAt/deliveryFee، ولا
 * يستدعي adjustDeliveryBalance/adjustCustomerBalance/postEntry، ولا يحدّث invoices — مسار التوريد
 * يبقى كما هو تماماً (§٥). idempotent: ختمٌ مسبق يُعاد كما هو بلا خطأ.
 */
export async function confirmConsignmentDelivery(
  input: { consignmentId: number },
  actor: { userId: number },
): Promise<ConfirmConsignmentResult> {
  const partyId = await resolveCourierPartyId(actor.userId);
  if (partyId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "حسابك غير مرتبط بمندوب توصيل — راجع المدير" });
  }
  return withTx(async (tx) => {
    const cn = (
      await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, input.consignmentId)).for("update").limit(1)
    )[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    // IDOR: المندوب لا يختم إلا إرساليّاته المُسنَدة إليه.
    if (Number(cn.partyId) !== partyId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه الإرسالية ليست ضمن توصيلاتك" });
    }
    // idempotent: مختومة سابقاً ⇒ تُعاد كما هي بلا خطأ ولا تغيير (نقرة مزدوجة/إعادة محاولة).
    if (cn.courierDeliveredAt != null) {
      return {
        consignmentId: Number(cn.id),
        consignmentNumber: cn.consignmentNumber,
        deliveredAt: cn.courierDeliveredAt,
        alreadyDelivered: true,
      };
    }
    // قابلة للختم ما دامت قيد التوصيل ولم تُورَّد — المال يُسوَّى عند التوريد لا هنا.
    if ((cn.status !== "DISPATCHED" && cn.status !== "PARTIAL") || cn.remittanceId != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "غير قابلة للتأكيد" });
    }
    const deliveredAt = new Date();
    // ⛔ لا شيء غير هذا العمود — راجع توثيق الدالة أعلاه (المال يُسوَّى عند توريد المندوب).
    await tx
      .update(deliveryConsignments)
      .set({ courierDeliveredAt: deliveredAt })
      .where(eq(deliveryConsignments.id, Number(cn.id)));
    return {
      consignmentId: Number(cn.id),
      consignmentNumber: cn.consignmentNumber,
      deliveredAt,
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

  // المرحلة ①: **مطالبة ذرّية** بالطلب تحت قفل الصفّ (SHIPPED→CANCELLED). تُسلسِل ضدّ التحصيل المتزامن
  // (confirmCourierDelivery يقفل نفس الصفّ ويشترط SHIPPED/DELIVERED) ⇒ لا يعكس هذا فاتورةً حُصِّلت
  // للتوّ (مراجعة عدائية ١٢/٧): إمّا هذا يُطالِب أولاً فيرى confirm الحالة CANCELLED فيُرفَض، أو confirm
  // يُطالِب فيرى هذا DELIVERED فيُرفَض. فحص paidAmount يجري **تحت القفل** بعد المطالبة.
  const claim = await withTx(async (tx) => {
    const order = (await tx.select().from(onlineOrders).where(eq(onlineOrders.id, input.onlineOrderId)).for("update").limit(1))[0];
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    if (Number(order.deliveryPartyId) !== partyId) throw new TRPCError({ code: "FORBIDDEN", message: "هذا الطلب ليس ضمن توصيلاتك" });
    if (!order.invoiceId) throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب بلا فاتورة" });
    const inv = (await tx.select({ status: invoices.status, paidAmount: invoices.paidAmount, branchId: invoices.branchId }).from(invoices).where(eq(invoices.id, Number(order.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الطلب غير موجودة" });
    if (order.status === "CANCELLED") {
      // استرداد idempotent: مُطالَبٌ سابقاً — أكمِل العكس إن لم تُرجَع الفاتورة بعد (فشلٌ بين المطالبة والعكس).
      const done = inv.status === "CANCELLED" || inv.status === "RETURNED";
      return { orderNumber: order.orderNumber, invoiceId: Number(order.invoiceId), branchId: Number(inv.branchId), needsReverse: !done, alreadyDone: done };
    }
    if (order.status !== "SHIPPED") throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب ليس قيد التوصيل" });
    if (money(inv.paidAmount ?? "0").gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب محصَّل — الإرجاع بعد التسليم عبر المدير" });
    }
    await tx.update(onlineOrders).set({ status: "CANCELLED", cancelReason: reason }).where(eq(onlineOrders.id, order.id));
    return { orderNumber: order.orderNumber, invoiceId: Number(order.invoiceId), branchId: Number(inv.branchId), needsReverse: true, alreadyDone: false };
  });
  if (claim.alreadyDone) {
    return { orderId: input.onlineOrderId, orderNumber: claim.orderNumber, reversed: false, alreadyCancelled: true };
  }

  // المرحلة ②: عكس البيع (returnSale ذرّي، idempotent). الطلب مُطالَبٌ CANCELLED ⇒ لا يتدخّل confirm.
  let reversed = false;
  if (claim.needsReverse) {
    const items = await db
      .select({ id: invoiceItems.id, baseQuantity: invoiceItems.baseQuantity, returnedBaseQuantity: invoiceItems.returnedBaseQuantity })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, claim.invoiceId));
    const lines = items
      .map((i) => ({ invoiceItemId: Number(i.id), baseQuantity: Number(i.baseQuantity) - Number(i.returnedBaseQuantity ?? 0) }))
      .filter((l) => l.baseQuantity > 0);
    if (lines.length > 0) {
      // إعادة مخزون + عكس SALE + تصفير ذمّة العميل + الفاتورة RETURNED. actor.branchId=فرع الفاتورة
      // (المندوب عابرٌ للفروع). لا استرداد نقدي (paidAmount=0 مُتحقَّقٌ تحت القفل).
      await returnSale(
        { invoiceId: claim.invoiceId, lines, refund: null, restock: true, clientRequestId: `courier-fail:${input.onlineOrderId}` },
        { userId: actor.userId, branchId: claim.branchId, role: "courier" },
      );
      reversed = true;
    }
  }
  return { orderId: input.onlineOrderId, orderNumber: claim.orderNumber, reversed };
}
