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
import { dispatchInvoiceInTx } from "../delivery/dispatchInvoice";
import { createSaleInTx, notifySaleCustomerAfterCommit } from "../sale/create";
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

/**
 * عكسٌ ذرّي idempotent لفاتورةٍ صدرت عن إرسال طلبٍ ثمّ وجب إلغاؤه (إعادة مخزون + عكس بيع + تصفير
 * ذمّة + عكس أجرة الشحن). يُستعمَل في مسارين: المطالبة الذرّية إن أُلغي أثناء الإرسال، واسترداد
 * اليتيم عند إعادة المحاولة بعد فشلٍ عابر/انهيار (مراجعة عدائية ١٢/٧). المفتاح
 * `dispatch-cancelled:<orderId>` يجعله آمناً للتكرار (returnSale idempotent على نفس المفتاح).
 */
async function reverseDispatchedInvoice(invoiceId: number, orderId: number, branchId: number, actor: Actor): Promise<void> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const invItems = await db
    .select({ id: invoiceItems.id, baseQuantity: invoiceItems.baseQuantity, returnedBaseQuantity: invoiceItems.returnedBaseQuantity })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId));
  const lines = invItems
    .map((i) => ({ invoiceItemId: Number(i.id), baseQuantity: Number(i.baseQuantity) - Number(i.returnedBaseQuantity ?? 0) }))
    .filter((l) => l.baseQuantity > 0);
  if (lines.length > 0) {
    await returnSale({ invoiceId, lines, refund: null, restock: true, clientRequestId: `dispatch-cancelled:${orderId}` }, { userId: actor.userId, branchId, role: actor.role });
  }
}

export async function dispatchOnlineOrder(input: DispatchOnlineOrderInput, actor: Actor): Promise<DispatchOnlineOrderResult> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const order = (await db.select().from(onlineOrders).where(eq(onlineOrders.id, input.onlineOrderId)).limit(1))[0];
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });

  // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير
  // مقيَّدٌ بفرعه — يسري على فحص فرع الطلب وفرع جهة التوصيل أدناه معاً.
  const elevated = actor.role === "admin";
  if (!elevated && Number(order.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  if (order.status === "CANCELLED") {
    // استرداد اليتيم (مراجعة عدائية ١٢/٧): لو أُلغي الطلب أثناء إرسالٍ سابق ففشل عكسُ فاتورته بعد ربطها
    // (deadlock عابر أو انهيار العملية بين الربط والعكس)، تبقى فاتورة حيّة على طلبٍ مُلغى (مخزون مخصوم
    // + ذمّة منتفخة + بيع مُعترَف به). أعِد العكس idempotently هنا بدل الرفض الأعمى الذي كان يمنع أيّ
    // تعافٍ ⇒ إعادة المحاولة (راوتر/يدوي) تُشفي اليتيم. لا فاتورة حيّة ⇒ رفضٌ عاديّ.
    if (order.invoiceId) {
      const inv = (await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.id, Number(order.invoiceId))).limit(1))[0];
      if (inv && inv.s !== "CANCELLED" && inv.s !== "RETURNED") {
        await reverseDispatchedInvoice(Number(order.invoiceId), order.id, Number(order.branchId), actor);
        throw new TRPCError({ code: "CONFLICT", message: "أُلغي الطلب أثناء الإرسال — أُعيدت البضاعة للمخزون ولم يُرسَل" });
      }
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب ملغى" });
  }

  const branchId = Number(order.branchId);
  let notifyInput: Parameters<typeof notifySaleCustomerAfterCommit>[0] | null = null;
  let notifyResult: Parameters<typeof notifySaleCustomerAfterCommit>[1] | null = null;
  const claim = await withTx(async (tx) => {
    const cur = (await tx.select().from(onlineOrders).where(eq(onlineOrders.id, order.id)).for("update").limit(1))[0];
    if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    if (cur.status === "CANCELLED") return { cancelled: true as const, invoiceId: cur.invoiceId != null ? Number(cur.invoiceId) : null };
    if ((cur.status === "SHIPPED" || cur.status === "DELIVERED") && cur.invoiceId) {
      const inv = (await tx.select({ n: invoices.invoiceNumber, t: invoices.total }).from(invoices).where(eq(invoices.id, Number(cur.invoiceId))).limit(1))[0];
      return {
        cancelled: false as const,
        result: { orderId: Number(cur.id), invoiceId: Number(cur.invoiceId), invoiceNumber: inv?.n ?? "", partyId: Number(cur.deliveryPartyId), total: String(inv?.t ?? "0"), alreadyDispatched: true },
      };
    }
    if (!cur.invoiceId && cur.status !== "CONFIRMED" && cur.status !== "PROCESSING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "ثبّت الطلب أولاً قبل الإرسال" });
    }

    let invoiceId: number;
    let invoiceNumber: string;
    let total: string;
    if (cur.invoiceId) {
      invoiceId = Number(cur.invoiceId);
      const inv = (await tx.select({ n: invoices.invoiceNumber, t: invoices.total }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1))[0];
      if (!inv) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "فاتورة الطلب المرتبطة غير موجودة" });
      invoiceNumber = inv.n;
      total = String(inv.t);
    } else {
      if (!cur.customerId) throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب بلا عميل — تعذّر إصدار الفاتورة" });
      const items = await tx.select().from(onlineOrderItems).where(eq(onlineOrderItems.onlineOrderId, cur.id));
      if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا بنود في الطلب" });
      if (items.some((it) => it.productUnitId == null)) throw new TRPCError({ code: "BAD_REQUEST", message: "بند بلا وحدة — لا يمكن الإصدار" });
      const saleInput = {
        branchId,
        customerId: Number(cur.customerId),
        sourceType: "ONLINE" as const,
        priceTier: "RETAIL" as const,
        lines: items.map((it) => ({
          variantId: Number(it.variantId),
          productUnitId: Number(it.productUnitId),
          quantity: String(it.quantity),
          unitPriceOverride: String(it.unitPrice),
        })),
        notes: `طلب متجر ${cur.orderNumber}`,
        clientRequestId: `online-dispatch:${cur.id}`,
        priceOverrideApproved: true,
        creditApproved: false,
      };
      const sale = await createSaleInTx(tx, saleInput, actor);
      invoiceId = sale.invoiceId;
      invoiceNumber = sale.invoiceNumber;
      total = sale.total;
      await tx.update(onlineOrders).set({ invoiceId }).where(eq(onlineOrders.id, cur.id));
      notifyInput = saleInput;
      notifyResult = sale;
    }

    await dispatchInvoiceInTx(tx, {
      invoiceId,
      partyId: input.partyId,
      deliveryFee: String(cur.shippingCost ?? "0"),
      feeCollection: "COURIER",
      deliveryAddress: cur.shippingAddress ?? null,
      onlineOrderId: Number(cur.id),
      clientRequestId: `online-parcel:${cur.id}`,
    }, actor);
    await tx.update(onlineOrders).set({ deliveryPartyId: input.partyId, status: "SHIPPED" }).where(eq(onlineOrders.id, cur.id));
    return {
      cancelled: false as const,
      result: { orderId: Number(cur.id), invoiceId, invoiceNumber, partyId: input.partyId, total },
    };
  });

  if (claim.cancelled) {
    if (claim.invoiceId) await reverseDispatchedInvoice(claim.invoiceId, order.id, branchId, actor);
    throw new TRPCError({ code: "CONFLICT", message: "أُلغي الطلب أثناء الإرسال — لم يُرسَل" });
  }
  if (notifyInput && notifyResult) {
    try { await notifySaleCustomerAfterCommit(notifyInput, notifyResult); } catch { /* post-commit notification is best effort */ }
  }
  return claim.result;
}
