/**
 * dispatchOnlineOrder — تحويل طلب متجر مؤكَّد إلى **فاتورة حقيقية** + إسناده لجهة توصيل (إرسال).
 *
 * يعيد استخدام `createSale` المُختبَر بالكامل للجزء المالي الحسّاس: فاتورة (sourceType ONLINE) +
 * **خصم مخزون** + قيد SALE + توسيع البكجات + التكلفة WAVG + idempotency. `customerId` = عميل الطلب
 * ⇒ ذمّة العميل (COD: الزبون مدين حتى يُسدّد عند الاستلام؛ يُسجَّل السداد لاحقاً فتُصفّى الذمّة).
 * السعر مُثبَّت من لقطة الطلب (`unitPriceOverride`). ثم يُسنِد الطلب لجهة التوصيل (deliveryPartyId)
 * ويضبط الحالة SHIPPED — فتظهر في شاشة المندوب (شريحة ٥).
 *
 * لا نكتب فاتورة/مخزون/دفتر يدوياً (تجنّب خطأ مالي) — كلّه عبر createSale. الاسترداد: إن نجح
 * createSale ثم فشل تحديث الطلب، order.invoiceId مربوطٌ فوراً ⇒ إعادة المحاولة تتخطّى createSale.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { deliveryParties, invoiceItems, invoices, onlineOrderItems, onlineOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { withTx, type Actor } from "../tx";

export interface DispatchOnlineOrderInput {
  onlineOrderId: number;
  partyId: number;
}

export interface DispatchOnlineOrderResult {
  orderId: number;
  invoiceId: number;
  invoiceNumber: string;
  partyId: number;
  total: string;
  alreadyDispatched?: boolean;
}

export async function dispatchOnlineOrder(input: DispatchOnlineOrderInput, actor: Actor): Promise<DispatchOnlineOrderResult> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const order = (await db.select().from(onlineOrders).where(eq(onlineOrders.id, input.onlineOrderId)).limit(1))[0];
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });

  const elevated = actor.role === "admin" || actor.role === "manager";
  if (!elevated && Number(order.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  if (order.status === "CANCELLED") throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب ملغى" });

  const branchId = Number(order.branchId);
  const fetchInv = async (id: number) =>
    (await db.select({ n: invoices.invoiceNumber, t: invoices.total }).from(invoices).where(eq(invoices.id, id)).limit(1))[0];

  // مُرسَل مسبقاً (استرداد idempotent).
  if ((order.status === "SHIPPED" || order.status === "DELIVERED") && order.invoiceId) {
    const inv = await fetchInv(Number(order.invoiceId));
    return { orderId: order.id, invoiceId: Number(order.invoiceId), invoiceNumber: inv?.n ?? "", partyId: Number(order.deliveryPartyId ?? input.partyId), total: String(inv?.t ?? "0"), alreadyDispatched: true };
  }
  if (!order.invoiceId && order.status !== "CONFIRMED" && order.status !== "PROCESSING") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "ثبّت الطلب أولاً قبل الإرسال" });
  }

  const party = (await db.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).limit(1))[0];
  if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل غير متاحة" });
  if (!elevated && party.branchId != null && Number(party.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "جهة توصيل تخصّ فرعاً آخر" });
  }

  // ① الفاتورة + المخزون + القيد عبر createSale (تُعاد لو سبق ربطها — استرداد).
  let invoiceId: number;
  let invoiceNumber = "";
  let total = "0";
  if (order.invoiceId) {
    invoiceId = Number(order.invoiceId);
    const inv = await fetchInv(invoiceId);
    invoiceNumber = inv?.n ?? "";
    total = String(inv?.t ?? "0");
  } else {
    if (!order.customerId) throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب بلا عميل — تعذّر إصدار الفاتورة" });
    const items = await db.select().from(onlineOrderItems).where(eq(onlineOrderItems.onlineOrderId, order.id));
    if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا بنود في الطلب" });
    for (const it of items) {
      if (it.productUnitId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "بند بلا وحدة — لا يمكن الإصدار" });
    }
    const sale = await createSale(
      {
        branchId,
        customerId: Number(order.customerId), // COD ⇒ ذمّة العميل (تُصفّى عند تسجيل السداد)
        sourceType: "ONLINE",
        priceTier: "RETAIL",
        lines: items.map((it) => ({
          variantId: Number(it.variantId),
          productUnitId: Number(it.productUnitId),
          quantity: String(it.quantity),
          unitPriceOverride: String(it.unitPrice), // تثبيت سعر لقطة الطلب
        })),
        // أجرة الشحن على رأس الفاتورة كإيراد ⇒ invoice.total = subtotal + الشحن = order.total (ما وافق
        // عليه الزبون) فيُحصّل المندوب المبلغ كاملاً وتُصفّى الذمّة بلا نقصٍ (مراجعة عدائية ١٢/٧).
        deliveryFee: order.shippingCost ?? "0",
        notes: `طلب متجر ${order.orderNumber}`,
        clientRequestId: `online-dispatch:${order.id}`,
        priceOverrideApproved: true, // الموظف المُرسِل يُقرّ السعر المتّفق عليه مسبقاً
        // COD: العميل نقديٌّ (سقف ائتمان 0)؛ المدير المُرسِل يُقرّ الائتمان المؤقّت حتى تحصيل الدفع
        // عند الاستلام (تُصفّى الذمّة بتسجيل السداد). الإسناد لمدير فقط ⇒ التوثيق الذاتي صالح.
        creditApproved: true,
        managerOverrideByUserId: actor.userId,
      },
      actor
    );
    invoiceId = sale.invoiceId;
    invoiceNumber = sale.invoiceNumber;
    total = sale.total;
    await db.update(onlineOrders).set({ invoiceId }).where(eq(onlineOrders.id, order.id)); // ربط فوري (استرداد)
  }

  // ② مطالبة ذرّية بالطلب (SHIPPED) تحت قفل الصفّ + إعادة فحص عدم الإلغاء المتزامن (مراجعة عدائية ١٢/٧):
  //    لولاها لأمكن لإلغاءٍ متزامن أن يقع بين إنشاء الفاتورة وربطها فيُحييَ هذا التحديثُ طلباً مُلغى.
  const claim = await withTx(async (tx) => {
    const cur = (await tx.select({ status: onlineOrders.status }).from(onlineOrders).where(eq(onlineOrders.id, order.id)).for("update").limit(1))[0];
    if (cur?.status === "CANCELLED") return { cancelled: true as const };
    await tx.update(onlineOrders).set({ deliveryPartyId: input.partyId, status: "SHIPPED" }).where(eq(onlineOrders.id, order.id));
    return { cancelled: false as const };
  });

  // أُلغي أثناء الإرسال ⇒ نعكس الفاتورة المُنشأة حديثاً (إعادة مخزون + عكس بيع + تصفير ذمّة) فلا تبقى
  //    فاتورة يتيمة على طلبٍ مُلغى. idempotent بمفتاح فريد. الطلب يبقى CANCELLED (كما تركه الإلغاء).
  if (claim.cancelled) {
    const invItems = await db.select({ id: invoiceItems.id, baseQuantity: invoiceItems.baseQuantity, returnedBaseQuantity: invoiceItems.returnedBaseQuantity }).from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    const lines = invItems.map((i) => ({ invoiceItemId: Number(i.id), baseQuantity: Number(i.baseQuantity) - Number(i.returnedBaseQuantity ?? 0) })).filter((l) => l.baseQuantity > 0);
    if (lines.length > 0) {
      await returnSale({ invoiceId, lines, refund: null, restock: true, clientRequestId: `dispatch-cancelled:${order.id}` }, { userId: actor.userId, branchId, role: actor.role });
    }
    throw new TRPCError({ code: "CONFLICT", message: "أُلغي الطلب أثناء الإرسال — أُعيدت البضاعة للمخزون ولم يُرسَل" });
  }

  return { orderId: order.id, invoiceId, invoiceNumber, partyId: input.partyId, total };
}
