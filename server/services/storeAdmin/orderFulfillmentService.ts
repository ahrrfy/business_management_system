/**
 * orderFulfillmentService — الجهة الإدارية لطلبات المتجر الإلكترونية (onlineOrders).
 *
 * الموظف يرى الطلبات الواردة (PENDING) ← يثبّتها (CONFIRMED) ← يجهّزها/يُرسلها ← تُسلَّم.
 * **بلا أثر مالي هنا**: تغيير الحالة فقط — تحويل الطلب إلى فاتورة + إرسالية عبر محرّك التوصيل
 * (خصم مخزون + قيد دفتر) شريحةٌ لاحقة (convertToInvoice)، حفاظاً على مبدأ «لا دفتر حتى التأكيد المالي».
 * عزل الفرع: القراءة/الكتابة مقيّدة بـscopedBranchId لغير المرتفعين (admin/manager يعبُران).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  customers,
  deliveryParties,
  invoices,
  onlineOrderItems,
  onlineOrders,
  productUnits,
  productVariants,
  products,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";
import { withTx } from "../tx";

export type OnlineOrderStatus = "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED";

/**
 * الانتقالات اليدوية المسموحة (حارس بنيوي). الطرفيّتان (DELIVERED/CANCELLED) نهائيّتان.
 * ⛔ SHIPPED ليست هدفاً يدويّاً (مراجعة عدائية ١٢/٧): الإرسال حصراً عبر dispatchOnlineOrder (يُصدر
 * الفاتورة + يخصم المخزون ثم يضبط SHIPPED مباشرةً). لو سُمح CONFIRMED/PROCESSING→SHIPPED يدوياً
 * لصار الطلب «مُرسَلاً» بلا فاتورة ولا خصم مخزون، ثم يفشل تأكيد المندوب (بلا invoiceId).
 */
const ALLOWED_TRANSITIONS: Record<OnlineOrderStatus, OnlineOrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["CANCELLED"],
  SHIPPED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

export interface OnlineOrderRow {
  id: number;
  orderNumber: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  total: string;
  deliveryFee: string;
  deliveryPartyId: number | null;
  cancelReason: string | null;
  itemCount: number;
  createdAt: Date;
}

/** قائمة طلبات المتجر (اختياري: فلترة حالة) — مقيّدة بالفرع لغير المرتفعين. */
export async function listOnlineOrders(opts: {
  scopedBranchId: number | null;
  status?: string | null;
  limit?: number;
}): Promise<OnlineOrderRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const conds = [];
  if (opts.scopedBranchId != null) conds.push(eq(onlineOrders.branchId, opts.scopedBranchId));
  if (opts.status) conds.push(eq(onlineOrders.status, opts.status as OnlineOrderStatus));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      status: onlineOrders.status,
      customerName: customers.name,
      customerPhone: customers.phone,
      governorate: onlineOrders.governorate,
      total: onlineOrders.total,
      deliveryFee: onlineOrders.shippingCost,
      deliveryPartyId: onlineOrders.deliveryPartyId,
      cancelReason: onlineOrders.cancelReason,
      createdAt: onlineOrders.createdAt,
      itemCount: sql<number>`(SELECT COUNT(*) FROM ${onlineOrderItems} WHERE ${onlineOrderItems.onlineOrderId} = ${onlineOrders.id})`,
    })
    .from(onlineOrders)
    .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
    .where(where)
    .orderBy(desc(onlineOrders.id))
    .limit(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    orderNumber: r.orderNumber,
    status: r.status,
    customerName: r.customerName ?? null,
    customerPhone: r.customerPhone ?? null,
    governorate: r.governorate ?? null,
    total: String(r.total),
    deliveryFee: String(r.deliveryFee),
    deliveryPartyId: r.deliveryPartyId != null ? Number(r.deliveryPartyId) : null,
    cancelReason: r.cancelReason ?? null,
    itemCount: Number(r.itemCount),
    createdAt: r.createdAt,
  }));
}

/** عدّاد لكل حالة (لبطاقات الإحصاء أعلى الشاشة) — مقيّد بالفرع. */
export async function onlineOrderStatusCounts(scopedBranchId: number | null): Promise<Record<string, number>> {
  const db = getDb();
  if (!db) return {};
  const rows = await db
    .select({ status: onlineOrders.status, n: sql<number>`COUNT(*)` })
    .from(onlineOrders)
    .where(scopedBranchId != null ? eq(onlineOrders.branchId, scopedBranchId) : undefined)
    .groupBy(onlineOrders.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export interface OnlineOrderDetailItem {
  productName: string;
  unitName: string;
  quantity: string;
  unitPrice: string;
  total: string;
}
export interface OnlineOrderDetail extends OnlineOrderRow {
  branchId: number;
  addressText: string | null;
  subtotal: string;
  deliveryPartyName: string | null;
  items: OnlineOrderDetailItem[];
}

/** تفاصيل طلب (للملصق/العرض) — الطلب + العميل + البنود. */
export async function getOnlineOrder(id: number, scopedBranchId: number | null): Promise<OnlineOrderDetail | null> {
  const db = getDb();
  if (!db) return null;
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        branchId: onlineOrders.branchId,
        customerName: customers.name,
        customerPhone: customers.phone,
        governorate: onlineOrders.governorate,
        addressText: onlineOrders.shippingAddress,
        subtotal: onlineOrders.subtotal,
        deliveryFee: onlineOrders.shippingCost,
        deliveryPartyId: onlineOrders.deliveryPartyId,
        deliveryPartyName: deliveryParties.name,
        cancelReason: onlineOrders.cancelReason,
        total: onlineOrders.total,
        createdAt: onlineOrders.createdAt,
      })
      .from(onlineOrders)
      .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
      .leftJoin(deliveryParties, eq(onlineOrders.deliveryPartyId, deliveryParties.id))
      .where(eq(onlineOrders.id, id))
      .limit(1)
  )[0];
  if (!order) return null;
  if (scopedBranchId != null && Number(order.branchId) !== scopedBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  const items = await db
    .select({
      productName: products.name,
      unitName: productUnits.unitName,
      quantity: onlineOrderItems.quantity,
      unitPrice: onlineOrderItems.unitPrice,
      total: onlineOrderItems.total,
    })
    .from(onlineOrderItems)
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
    .where(eq(onlineOrderItems.onlineOrderId, id));
  return {
    id: Number(order.id),
    orderNumber: order.orderNumber,
    status: order.status,
    branchId: Number(order.branchId),
    customerName: order.customerName ?? null,
    customerPhone: order.customerPhone ?? null,
    governorate: order.governorate ?? null,
    addressText: order.addressText ?? null,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.deliveryFee),
    deliveryPartyId: order.deliveryPartyId != null ? Number(order.deliveryPartyId) : null,
    deliveryPartyName: order.deliveryPartyName ?? null,
    cancelReason: order.cancelReason ?? null,
    total: String(order.total),
    itemCount: items.length,
    createdAt: order.createdAt,
    items: items.map((i) => ({
      productName: i.productName,
      unitName: i.unitName ?? "",
      quantity: String(i.quantity),
      unitPrice: String(i.unitPrice),
      total: String(i.total),
    })),
  };
}

/** تغيير حالة طلب (بحارس انتقال + عزل فرع). يعيد الحالة السابقة للتدقيق. */
export async function setOnlineOrderStatus(
  input: { id: number; status: OnlineOrderStatus; scopedBranchId: number | null; cancelReason?: string | null },
  _actorUserId: number
): Promise<{ id: number; from: string; to: OnlineOrderStatus }> {
  return withTx(async (tx) => {
    const order = (
      await tx.select().from(onlineOrders).where(eq(onlineOrders.id, input.id)).for("update").limit(1)
    )[0];
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
    }
    const from = order.status as OnlineOrderStatus;
    if (from === input.status) return { id: input.id, from, to: input.status };
    if (!ALLOWED_TRANSITIONS[from].includes(input.status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `انتقال غير مسموح: ${from} ← ${input.status}` });
    }
    // ⛔ حارس تسريب COD (مراجعة عدائية ١٢/٧): «تم التسليم» هنا تغييرُ حالةٍ بلا أثر مالي. لو كان الطلب
    // مُسنَداً لمندوب وفاتورته ما تزال بها مبلغٌ مستحقّ (COD غير محصَّل)، فإنهاؤه «مُسلَّم» يُخفي التحصيل
    // إلى الأبد (DELIVERED نهائيّة) ⇒ نقدٌ بيد المندوب خارج الدفتر. يُسلَّم ويُحصَّل حصراً عبر «توصيلاتي»
    // (confirmCourierDelivery) أو بتسجيل دفعة على الفاتورة أولاً.
    if (input.status === "DELIVERED" && order.deliveryPartyId != null && order.invoiceId != null) {
      const inv = (await tx.select({ total: invoices.total, paid: invoices.paidAmount, returned: invoices.returnedTotal }).from(invoices).where(eq(invoices.id, Number(order.invoiceId))).limit(1))[0];
      if (inv) {
        const outstanding = money(inv.total).minus(money(inv.returned ?? "0")).minus(money(inv.paid ?? "0"));
        if (outstanding.gt("0.01")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب مع مندوب ولم يُحصَّل المبلغ — يُسلَّم ويُحصَّل عبر «توصيلاتي» أو سجّل الدفعة أولاً" });
        }
      }
    }
    // ⛔ حارس يُتْم الفاتورة (مراجعة عدائية ١٢/٧): الطلب المُرسَل له فاتورة حقيقية (مخزون مخصوم + ذمّة
    // عميل + بيع مُعترَف به). إلغاؤه بتغيير حالةٍ بحت يُيتّم الفاتورة: العميل يظلّ مديناً (تُطالبه
    // تذكيرات الذمم بطلبٍ مُلغى) والمخزون لا يُعاد. الإلغاء بعد الإرسال حصراً بعكسٍ ذرّي: «تعذّر التسليم»
    // (المندوب ⇒ failCourierDelivery) أو إرجاع الفاتورة (المدير) — كلاهما يُعيد المخزون ويُصفّي الذمّة.
    if (input.status === "CANCELLED" && order.invoiceId != null) {
      const inv = (await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, Number(order.invoiceId))).limit(1))[0];
      if (inv && inv.status !== "CANCELLED" && inv.status !== "RETURNED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الطلب أُرسِل وله فاتورة — لا يُلغى بتغيير الحالة. استعمل «تعذّر التسليم» (المندوب) أو إرجاع الفاتورة (المدير) لعكس البيع والمخزون." });
      }
    }
    // نُثبِّت سبب الإلغاء (اختياريّ) عند CANCELLED فقط — كي لا يُطمَس سببٌ سبق أن سجّله المندوب في
    // مسارٍ آخر عند انتقالات غير الإلغاء. الإلغاء اليدويّ هنا محصورٌ بطلبٍ قبل الإرسال (بلا فاتورة).
    const patch =
      input.status === "CANCELLED"
        ? { status: input.status, cancelReason: input.cancelReason?.trim() ? input.cancelReason.trim().slice(0, 500) : null }
        : { status: input.status };
    await tx.update(onlineOrders).set(patch).where(eq(onlineOrders.id, input.id));
    return { id: input.id, from, to: input.status };
  });
}
