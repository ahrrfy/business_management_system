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
import { deliveryParties, invoices, onlineOrderItems, onlineOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import type { Actor } from "../tx";

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

  // ② إسناد جهة التوصيل + الحالة SHIPPED (تظهر في شاشة المندوب).
  await db.update(onlineOrders).set({ deliveryPartyId: input.partyId, status: "SHIPPED" }).where(eq(onlineOrders.id, order.id));

  return { orderId: order.id, invoiceId, invoiceNumber, partyId: input.partyId, total };
}
