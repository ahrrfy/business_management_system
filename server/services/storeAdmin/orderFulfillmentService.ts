/**
 * orderFulfillmentService — الجهة الإدارية لطلبات المتجر الإلكترونية (onlineOrders).
 *
 * الموظف يرى الطلبات الواردة (PENDING) ← يثبّتها (CONFIRMED) ← يجهّزها/يُرسلها ← تُسلَّم.
 * **بلا أثر مالي هنا**: تغيير الحالة فقط — تحويل الطلب إلى فاتورة + إرسالية عبر محرّك التوصيل
 * (خصم مخزون + قيد دفتر) شريحةٌ لاحقة (convertToInvoice)، حفاظاً على مبدأ «لا دفتر حتى التأكيد المالي».
 * عزل الفرع: القراءة/الكتابة مقيّدة بـscopedBranchId لغير المرتفعين (admin/manager يعبُران).
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  bundleComponents,
  customers,
  deliveryParties,
  invoices,
  onlineOrderItems,
  onlineOrders,
  productUnits,
  productVariants,
  productImages,
  products,
  storeSettings as storeSettingsTable,
  users,
} from "../../../drizzle/schema";
import { alias } from "drizzle-orm/mysql-core";
import { getDb } from "../../db";
import { money, round2 } from "../money";
import { withTx } from "../tx";
import { decodeDataUrl, productImageUrl } from "../../imageRoute";
import { onlineOrderLabelToken } from "../barcodeService";
import { awardDeliveredOnlineOrderPoints } from "./loyaltyService";
import {
  confirmCouponReservationForOnlineOrder,
  releaseCouponReservationForOnlineOrder,
} from "../couponService";
import { enqueueStorefrontOrderStatusPush } from "./storefrontPushCampaignService";
import {
  lockProductUnitsForOnlineAllocation,
  loadVariantAvailability,
} from "../catalog/variantAvailability";
import {
  priceOnlineOrderLines,
  totalOnlineOrderQuote,
} from "../onlineOrderService";
import { normalizeIraqPhoneE164 } from "../../lib/phone";
import { orderStatusLabel } from "@shared/onlineOrderStatus";
import { governorateById } from "@shared/governorates";

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
  couponCode: string | null;
  couponDiscount: string;
  deliveryFee: string;
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
  deliveryPartyId: number | null;
  cancelReason: string | null;
  latitude?: string | null;
  longitude?: string | null;
  itemCount: number;
  createdAt: Date;
  reservationExpiresAt: Date | null;
  claimedByUserId: number | null;
  claimedByName: string | null;
  claimedAt: Date | null;
  preparedByUserId: number | null;
  preparedByName: string | null;
  preparedAt: Date | null;
  fulfillmentDurationMinutes: number | null;
  contactStatus: "NOT_CONTACTED" | "WHATSAPP_SENT" | "CALLED_CONFIRMED" | "NO_ANSWER" | "RETRY";
  contactNotes: string | null;
}

/** قائمة طلبات المتجر (اختياري: فلترة حالة/مدى تاريخ + تحميل صفحات إضافية بالمؤشّر) — مقيّدة
 *  بالفرع لغير المرتفعين. **يبقى النوع المُعاد مصفوفة مسطّحة** (لا {rows,hasMore}) — يستهلكها أيضاً
 *  StoreDashboard.tsx خارج نطاق هذه الوحدة؛ تغيير الشكل يكسره. الترقيم الحقيقي في الشاشة عبر
 *  cursor + heuristic (rows.length===limit) بدل تغيير العقد. */
export async function listOnlineOrders(opts: {
  scopedBranchId: number | null;
  status?: string | null;
  /** مدى تاريخ الإنشاء (YYYY-MM-DD) — نمط buildWoFilterConds في workOrderRouter.ts. */
  from?: string;
  to?: string;
  /** مؤشّر ترقيم — id آخر صفّ في الصفحة السابقة ⇒ يجلب ما هو أقدم منه. */
  cursor?: number;
  limit?: number;
}): Promise<OnlineOrderRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const conds = [];
  if (opts.scopedBranchId != null) conds.push(eq(onlineOrders.branchId, opts.scopedBranchId));
  if (opts.status) conds.push(eq(onlineOrders.status, opts.status as OnlineOrderStatus));
  if (opts.from) {
    const from = new Date(opts.from);
    if (!isNaN(from.getTime())) conds.push(gte(onlineOrders.createdAt, from));
  }
  if (opts.to) {
    const to = new Date(opts.to);
    if (!isNaN(to.getTime())) {
      // الطرف الأعلى شامل ⇒ حدّ علوي حصري ببداية اليوم التالي.
      const next = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
      conds.push(lt(onlineOrders.createdAt, next));
    }
  }
  if (opts.cursor != null) conds.push(lt(onlineOrders.id, opts.cursor));
  const where = conds.length ? and(...conds) : undefined;

  const claimedUsers = alias(users, "claimedUsers");
  const preparedUsers = alias(users, "preparedUsers");

  const rows = await db
    .select({
      id: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      status: onlineOrders.status,
      customerName: customers.name,
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      governorate: onlineOrders.governorate,
      total: onlineOrders.total,
      couponCode: onlineOrders.couponCode,
      couponDiscount: onlineOrders.couponDiscount,
      deliveryFee: onlineOrders.shippingCost,
      deliveryFree: onlineOrders.deliveryFree,
      deliveryWaivedAmount: onlineOrders.deliveryWaivedAmount,
      deliveryPartyId: onlineOrders.deliveryPartyId,
      cancelReason: onlineOrders.cancelReason,
      latitude: onlineOrders.latitude,
      longitude: onlineOrders.longitude,
      createdAt: onlineOrders.createdAt,
      reservationExpiresAt: onlineOrders.reservationExpiresAt,
      claimedByUserId: onlineOrders.claimedByUserId,
      claimedByName: claimedUsers.name,
      claimedAt: onlineOrders.claimedAt,
      preparedByUserId: onlineOrders.preparedByUserId,
      preparedByName: preparedUsers.name,
      preparedAt: onlineOrders.preparedAt,
      fulfillmentDurationMinutes: onlineOrders.fulfillmentDurationMinutes,
      contactStatus: onlineOrders.contactStatus,
      contactNotes: onlineOrders.contactNotes,
      itemCount: sql<number>`(SELECT COUNT(*) FROM ${onlineOrderItems} WHERE ${onlineOrderItems.onlineOrderId} = ${onlineOrders.id})`,
    })
    .from(onlineOrders)
    .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
    .leftJoin(claimedUsers, eq(onlineOrders.claimedByUserId, claimedUsers.id))
    .leftJoin(preparedUsers, eq(onlineOrders.preparedByUserId, preparedUsers.id))
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
    couponCode: r.couponCode ?? null,
    couponDiscount: String(r.couponDiscount ?? "0"),
    deliveryFee: String(r.deliveryFee),
    deliveryFree: r.deliveryFree === true,
    deliveryWaivedAmount: String(r.deliveryWaivedAmount ?? "0"),
    deliveryPartyId: r.deliveryPartyId != null ? Number(r.deliveryPartyId) : null,
    cancelReason: r.cancelReason ?? null,
    itemCount: Number(r.itemCount),
    createdAt: r.createdAt,
    reservationExpiresAt: r.reservationExpiresAt ? new Date(r.reservationExpiresAt) : null,
    claimedByUserId: r.claimedByUserId != null ? Number(r.claimedByUserId) : null,
    claimedByName: r.claimedByName ?? null,
    claimedAt: r.claimedAt ? new Date(r.claimedAt) : null,
    preparedByUserId: r.preparedByUserId != null ? Number(r.preparedByUserId) : null,
    preparedByName: r.preparedByName ?? null,
    preparedAt: r.preparedAt ? new Date(r.preparedAt) : null,
    fulfillmentDurationMinutes: r.fulfillmentDurationMinutes != null ? Number(r.fulfillmentDurationMinutes) : null,
    contactStatus: (r.contactStatus as OnlineOrderRow["contactStatus"]) ?? "NOT_CONTACTED",
    contactNotes: r.contactNotes ?? null,
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
  id?: number;
  productId?: number;
  variantId?: number;
  productUnitId?: number | null;
  productName: string;
  variantLabel: string;
  imageUrl: string | null;
  unitName: string;
  quantity: string;
  unitPrice: string;
  total: string;
  hasCustomization: boolean;
  customizationSummary: string | null;
}
export interface OnlineOrderDetail extends OnlineOrderRow {
  branchId: number;
  addressText: string | null;
  subtotal: string;
  deliveryPartyName: string | null;
  /** يوقّع الخادم هذا الرمز ليُستعمل QR كوصلة عامة غير قابلة للتخمين. */
  labelToken: string;
  items: OnlineOrderDetailItem[];
}

/** تفاصيل طلب (للملصق/العرض) — الطلب + العميل + البنود. */
export async function getOnlineOrder(id: number, scopedBranchId: number | null): Promise<OnlineOrderDetail | null> {
  const db = getDb();
  if (!db) return null;
  const claimedUsers = alias(users, "claimedUsers");
  const preparedUsers = alias(users, "preparedUsers");
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        branchId: onlineOrders.branchId,
        customerName: customers.name,
        customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
        governorate: onlineOrders.governorate,
        addressText: onlineOrders.shippingAddress,
        latitude: onlineOrders.latitude,
        longitude: onlineOrders.longitude,
        subtotal: onlineOrders.subtotal,
        deliveryFee: onlineOrders.shippingCost,
        deliveryFree: onlineOrders.deliveryFree,
        deliveryWaivedAmount: onlineOrders.deliveryWaivedAmount,
        deliveryPartyId: onlineOrders.deliveryPartyId,
        deliveryPartyName: deliveryParties.name,
        cancelReason: onlineOrders.cancelReason,
        total: onlineOrders.total,
        couponCode: onlineOrders.couponCode,
        couponDiscount: onlineOrders.couponDiscount,
        createdAt: onlineOrders.createdAt,
        reservationExpiresAt: onlineOrders.reservationExpiresAt,
        claimedByUserId: onlineOrders.claimedByUserId,
        claimedByName: claimedUsers.name,
        claimedAt: onlineOrders.claimedAt,
        preparedByUserId: onlineOrders.preparedByUserId,
        preparedByName: preparedUsers.name,
        preparedAt: onlineOrders.preparedAt,
        fulfillmentDurationMinutes: onlineOrders.fulfillmentDurationMinutes,
        contactStatus: onlineOrders.contactStatus,
        contactNotes: onlineOrders.contactNotes,
      })
      .from(onlineOrders)
      .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
      .leftJoin(deliveryParties, eq(onlineOrders.deliveryPartyId, deliveryParties.id))
      .leftJoin(claimedUsers, eq(onlineOrders.claimedByUserId, claimedUsers.id))
      .leftJoin(preparedUsers, eq(onlineOrders.preparedByUserId, preparedUsers.id))
      .where(eq(onlineOrders.id, id))
      .limit(1)
  )[0];
  if (!order) return null;
  if (scopedBranchId != null && Number(order.branchId) !== scopedBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  const items = await db
    .select({
      id: onlineOrderItems.id,
      productId: products.id,
      variantId: productVariants.id,
      productUnitId: onlineOrderItems.productUnitId,
      productName: products.name,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      imageId: productImages.id,
      imageUrl: productImages.url,
      unitName: productUnits.unitName,
      quantity: onlineOrderItems.quantity,
      unitPrice: onlineOrderItems.unitPrice,
      total: onlineOrderItems.total,
      customizationSnapshot: onlineOrderItems.customizationSnapshot,
    })
    .from(onlineOrderItems)
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
    .leftJoin(productImages, and(eq(productImages.productId, products.id), eq(productImages.isPrimary, true)))
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
    latitude: order.latitude ? String(order.latitude) : null,
    longitude: order.longitude ? String(order.longitude) : null,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.deliveryFee),
    deliveryFree: order.deliveryFree === true,
    deliveryWaivedAmount: String(order.deliveryWaivedAmount ?? "0"),
    deliveryPartyId: order.deliveryPartyId != null ? Number(order.deliveryPartyId) : null,
    deliveryPartyName: order.deliveryPartyName ?? null,
    labelToken: onlineOrderLabelToken(order.orderNumber),
    cancelReason: order.cancelReason ?? null,
    total: String(order.total),
    couponCode: order.couponCode ?? null,
    couponDiscount: String(order.couponDiscount ?? "0"),
    itemCount: items.length,
    createdAt: order.createdAt,
    reservationExpiresAt: order.reservationExpiresAt ? new Date(order.reservationExpiresAt) : null,
    claimedByUserId: order.claimedByUserId != null ? Number(order.claimedByUserId) : null,
    claimedByName: order.claimedByName ?? null,
    claimedAt: order.claimedAt ? new Date(order.claimedAt) : null,
    preparedByUserId: order.preparedByUserId != null ? Number(order.preparedByUserId) : null,
    preparedByName: order.preparedByName ?? null,
    preparedAt: order.preparedAt ? new Date(order.preparedAt) : null,
    fulfillmentDurationMinutes: order.fulfillmentDurationMinutes != null ? Number(order.fulfillmentDurationMinutes) : null,
    contactStatus: (order.contactStatus as OnlineOrderRow["contactStatus"]) ?? "NOT_CONTACTED",
    contactNotes: order.contactNotes ?? null,
    items: items.map((i) => ({
      id: Number(i.id),
      productId: Number(i.productId),
      variantId: Number(i.variantId),
      productUnitId: i.productUnitId != null ? Number(i.productUnitId) : null,
      productName: i.productName,
      variantLabel: Array.from(new Set([i.variantName, i.color, i.size].map((v) => v?.trim()).filter(Boolean))).join(" — "),
      imageUrl: i.imageUrl && (!/^data:/i.test(i.imageUrl) || (i.imageId != null && decodeDataUrl(i.imageUrl)))
        ? (/^data:/i.test(i.imageUrl) ? productImageUrl(Number(i.imageId), i.imageUrl) : i.imageUrl)
        : null,
      unitName: i.unitName ?? "",
      quantity: String(i.quantity),
      unitPrice: String(i.unitPrice),
      total: String(i.total),
      hasCustomization: i.customizationSnapshot != null,
      customizationSummary: i.customizationSnapshot?.values
        .map((value) => `${value.label}: ${value.displayValue}`)
        .join(" • ") || null,
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
    if (from === "PENDING" && input.status === "CONFIRMED") {
      // صف الطلب مقفول أعلاه؛ ساعة MySQL نفسها تمنع سباق التأكيد مع عامل الانتهاء.
      const expiry = (
        await tx
          .select({
            reservationExpiresAt: sql<Date>`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR))`,
            expired: sql<number>`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR)) <= CURRENT_TIMESTAMP(3)`,
          })
          .from(onlineOrders)
          .where(eq(onlineOrders.id, input.id))
          .limit(1)
      )[0];
      if (expiry && Number(expiry.expired) === 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "انتهت مهلة حجز مخزون هذا الطلب — اطلب من الزبون إعادة الطلب حسب التوفر الحالي",
        });
      }
      // التأكيد قبل المهلة يثبت وعد القسيمة حتى الإرسال أو الإلغاء؛ لا يعاد فحص تاريخها لاحقاً
      // بوصفه استعمالاً متاحاً لطلب آخر.
      await confirmCouponReservationForOnlineOrder(tx, input.id);
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
    if (input.status === "CANCELLED") {
      await releaseCouponReservationForOnlineOrder(
        tx,
        input.id,
        input.cancelReason?.trim() || "أُلغي الطلب قبل الإرسال",
      );
    }
    if (input.status === "DELIVERED") {
      await awardDeliveredOnlineOrderPoints(tx, {
        onlineOrderId: input.id,
        customerId: Number(order.customerId),
        total: String(order.total),
      });
    }
    if (input.status !== "PENDING") {
      await enqueueStorefrontOrderStatusPush(tx, {
        orderId: input.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId == null ? null : Number(order.customerId),
        status: input.status,
      });
    }
    return { id: input.id, from, to: input.status };
  });
}

export interface UpdateOnlineOrderInput {
  id: number;
  scopedBranchId: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  shippingAddress?: string | null;
  governorate?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  notes?: string | null;
  items?: Array<{
    productUnitId: number;
    quantity: number;
  }>;
}

/** تعديل طلب المتجر (قبل الإرسال الفعلي) — تحديث العميل/العنوان/المحافظة والبنود ذرّياً مع فحص ATP */
export async function updateOnlineOrder(
  input: UpdateOnlineOrderInput,
  _actorUserId: number,
): Promise<{ id: number; total: string; subtotal: string; deliveryFee: string }> {
  return withTx(async (tx) => {
    // 1. Lock the order row
    const order = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, input.id))
        .for("update")
        .limit(1)
    )[0];
    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "الطلب غير موجود",
          why: `لم يتم العثور على طلب إلكتروني برقم #${input.id}`,
          doThis: "تأكد من رقم الطلب أو قم بتحديث قائمة الطلبات",
        }),
      });
    }

    // 2. Branch access check
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "الطلب يخص فرعاً آخر",
          why: `هذا الطلب مسجل على الفرع رقم ${order.branchId} وحسابك مقيّد بالفرع ${input.scopedBranchId}`,
          doThis: "حوّل الجلسة إلى الفرع الصحيح أو اطلب من مدير الفرع المعني تعديل الطلب",
        }),
      });
    }

    // 3. Status check: Only PENDING, CONFIRMED, PROCESSING can be edited
    const editableStatuses: OnlineOrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING"];
    if (!editableStatuses.includes(order.status as OnlineOrderStatus)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن تعديل الطلب في حالته الحالية",
          why: `حالة الطلب الحالية هي «${orderStatusLabel(order.status as OnlineOrderStatus)}»`,
          doThis: "التعديل متاح فقط للطلبات غير المرسلة (وارد، مثبَّت، قيد التجهيز)",
        }),
      });
    }

    if (order.invoiceId != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن تعديل الطلب بعد إصدار الفاتورة",
          why: `الطلب مرتبط بالفعل بالفاتورة رقم #${order.invoiceId}`,
          doThis: "لتعديل بنود مبيعات مفوترة، استخدم شاشة تعديل أو مرتجع الفواتير",
        }),
      });
    }

    // 4. Update customer details if provided and linked
    if (order.customerId != null && (input.customerName != null || input.customerPhone != null)) {
      const custPatch: Record<string, unknown> = {};
      if (input.customerName != null && input.customerName.trim()) {
        custPatch.name = input.customerName.trim();
      }
      if (input.customerPhone != null && input.customerPhone.trim()) {
        custPatch.phone = normalizeIraqPhoneE164(input.customerPhone.trim());
      }
      if (Object.keys(custPatch).length > 0) {
        await tx.update(customers).set(custPatch).where(eq(customers.id, Number(order.customerId)));
      }
    }

    // 5. Governorate & address & coordinates
    const targetGovernorate = input.governorate?.trim() || order.governorate || "baghdad";
    if (targetGovernorate && !governorateById(targetGovernorate)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "المحافظة أو المنطقة المحددة غير مدعومة",
          why: `الرمز أو الاسم المحدد (${targetGovernorate}) ليس من ضمن المحافظات والمناطق المعتمدة في النظام`,
          doThis: "اختر محافظة أو منطقة صالحة من القائمة المعتمدة",
        }),
      });
    }
    let targetAddress = input.shippingAddress !== undefined ? (input.shippingAddress?.trim() || null) : order.shippingAddress;
    if (input.notes && input.notes.trim()) {
      targetAddress = targetAddress ? `${targetAddress}\nملاحظة: ${input.notes.trim()}` : `ملاحظة: ${input.notes.trim()}`;
    }
    const targetLat = input.latitude !== undefined ? input.latitude : order.latitude;
    const targetLng = input.longitude !== undefined ? input.longitude : order.longitude;

    // Fetch store settings for freeShippingThreshold
    const storeSettings = (
      await tx
        .select({
          freeShippingThreshold: storeSettingsTable.freeShippingThreshold,
          freeShippingThresholdGovernorates: storeSettingsTable.freeShippingThresholdGovernorates,
        })
        .from(storeSettingsTable)
        .where(eq(storeSettingsTable.id, 1))
        .limit(1)
    )[0];

    // 6. Handle items update if items array provided
    if (input.items !== undefined) {
      const customizedItem = (await tx
        .select({ id: onlineOrderItems.id })
        .from(onlineOrderItems)
        .where(and(
          eq(onlineOrderItems.onlineOrderId, Number(order.id)),
          sql`${onlineOrderItems.customizationSnapshot} is not null`,
        ))
        .limit(1))[0];
      if (customizedItem) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا يمكن استبدال أصناف الطلب المخصص",
            why: "الطلب يحوي تعليمات تخصيص محفوظة لكل بند، واستبدال البنود سيمحو ما طلبه الزبون",
            doThis: "عدّل بيانات المستلم فقط، أو ألغ الطلب وأنشئ طلباً جديداً بتفاصيل التخصيص الصحيحة",
          }),
        });
      }
      if (order.couponCode != null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا يمكن تعديل بنود طلب يحمل كوبون خصم",
            why: `الطلب يحتوي على كوبون مفعّل (${order.couponCode})، وتعديل البنود يخل بشروط وقيمة الخصم المالي للكوبون`,
            doThis: "يمكنك تعديل بيانات العميل والعنوان فقط، أو إلغاء الطلب وإنشاء طلب جديد لتعديل الأصناف",
          }),
        });
      }
      if (!Array.isArray(input.items) || input.items.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "قائمة أصناف الطلب فارغة",
            why: "تم إرسال قائمة أصناف فارغة للطلب",
            doThis: "أضف صنفاً واحداً على الأقل إلى الطلب قبل الحفظ",
          }),
        });
      }

      // Normalize items
      const lines = input.items.map((it) => ({
        productUnitId: Number(it.productUnitId),
        quantity: Math.floor(Number(it.quantity)),
      }));

      for (const line of lines) {
        if (!Number.isSafeInteger(line.productUnitId) || line.productUnitId <= 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "وحدة الصنف غير صحيحة",
              why: `رقم وحدة الصنف ${line.productUnitId} غير صالح`,
              doThis: "اختر وحدة صحيحة من قائمة المنتجات المتاحة",
            }),
          });
        }
        if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "كمية الصنف غير صحيحة",
              why: `الكمية المدخلة (${line.quantity}) ليست عدداً صحيحاً موجباً`,
              doThis: "أدخل كمية صحيحة أكبر من صفر لكل صنف في الطلب",
            }),
          });
        }
      }

      // Unit locks in ascending order
      const unitIds = Array.from(new Set(lines.map((l) => l.productUnitId))).sort((a, b) => a - b);
      await lockProductUnitsForOnlineAllocation(tx, unitIds);

      // Price lines using official online order engine
      const pricing = await priceOnlineOrderLines(
        tx,
        Number(order.branchId),
        lines,
        { lock: true }
      );

      // Bundle recipe resolution
      const bundleIds = Array.from(
        new Set(pricing.items.filter((item) => item.isBundle).map((item) => item.variantId)),
      );
      if (bundleIds.length) {
        await tx
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(inArray(productVariants.id, bundleIds))
          .orderBy(asc(productVariants.id))
          .for("update");
      }
      const recipes = bundleIds.length
        ? await tx
            .select({
              bundleVariantId: bundleComponents.bundleVariantId,
              componentVariantId: bundleComponents.componentVariantId,
              componentBaseQuantity: bundleComponents.componentBaseQuantity,
            })
            .from(bundleComponents)
            .where(inArray(bundleComponents.bundleVariantId, bundleIds))
        : [];
      const recipeByBundle = new Map<number, Array<{ componentVariantId: number; componentBaseQuantity: number }>>();
      for (const row of recipes) {
        const bId = Number(row.bundleVariantId);
        const cur = recipeByBundle.get(bId) ?? [];
        cur.push({
          componentVariantId: Number(row.componentVariantId),
          componentBaseQuantity: Number(row.componentBaseQuantity),
        });
        recipeByBundle.set(bId, cur);
      }

      const stockRequirements = new Map<number, number>();
      for (const item of pricing.items) {
        if (!item.isBundle) {
          stockRequirements.set(
            item.variantId,
            (stockRequirements.get(item.variantId) ?? 0) + item.baseQuantity,
          );
          continue;
        }
        const components = recipeByBundle.get(item.variantId) ?? [];
        if (!components.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "مكونات العرض غير مكتملة",
              why: `العرض «${item.productName}» لا يحتوي على مكونات مفعلة في شجرة الوصفة`,
              doThis: "تحقق من إعداد وصفة العرض أو احذف العرض من الطلب مؤقتاً",
            }),
          });
        }
        for (const component of components) {
          const required = item.baseQuantity * component.componentBaseQuantity;
          stockRequirements.set(
            component.componentVariantId,
            (stockRequirements.get(component.componentVariantId) ?? 0) + required,
          );
        }
      }

      // Check stock availability excluding THIS online order's old allocation
      const stockAvailability = await loadVariantAvailability(
        tx,
        Number(order.branchId),
        Array.from(stockRequirements.keys()).sort((a, b) => a - b),
        { lock: true, excludeOnlineOrderId: order.id },
      );

      for (const [variantId, requiredBase] of Array.from(stockRequirements.entries())) {
        const available = stockAvailability.get(variantId);
        if (available?.isService) continue;
        if (!available) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "الصنف غير متوفر في فرع التنفيذ",
              why: `الصنف #${variantId} غير معرّف أو غير متاح في الفرع #${order.branchId}`,
              doThis: "استبدل الصنف بصنف بديل أو حوّل الطلب إلى فرع آخر يتوفر فيه المخزون",
            }),
          });
        }
        if (requiredBase > available.availableBase) {
          const item = pricing.items.find((i) => i.variantId === variantId);
          const name = item?.productName ?? `الصنف #${variantId}`;
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "الكمية المطلوبة تتجاوز المخزون المتوفر للبيع",
              why: `المطلوب (${requiredBase}) من «${name}» بينما الرصيد الحر المتاح في الفرع هو (${available.availableBase})`,
              doThis: "قلل الكمية المطلوبة لتناسب المتوفر أو قم بتسوية/تحويل مخزون إضافي إلى الفرع",
            }),
          });
        }
      }

      const retailSubtotal = round2(
        pricing.items.reduce(
          (sum, item) => sum.plus(money(item.retailUnitPrice).times(item.quantity)),
          money(0),
        ),
      );

      const quoteTotals = await totalOnlineOrderQuote(
        tx,
        pricing.items,
        targetGovernorate,
        storeSettings?.freeShippingThreshold,
        retailSubtotal.toFixed(2),
        storeSettings?.freeShippingThresholdGovernorates,
      );

      // Deduct coupon discount if order had one
      const currentCouponDiscount = money(order.couponDiscount ?? "0");
      let grandTotal = money(quoteTotals.total);
      if (currentCouponDiscount.gt(0)) {
        grandTotal = grandTotal.minus(currentCouponDiscount);
        if (grandTotal.lt(0)) grandTotal = money(0);
      }

      // Atomic replace of order items
      await tx.delete(onlineOrderItems).where(eq(onlineOrderItems.onlineOrderId, order.id));
      for (const item of pricing.items) {
        await tx.insert(onlineOrderItems).values({
          onlineOrderId: order.id,
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          quantity: String(item.quantity),
          baseQuantity: item.baseQuantity,
          unitPrice: String(item.unitPrice),
          total: String(item.lineTotal),
        });
      }

      await tx
        .update(onlineOrders)
        .set({
          subtotal: quoteTotals.subtotal,
          shippingCost: quoteTotals.deliveryFee,
          deliveryFree: quoteTotals.deliveryFree,
          deliveryWaivedAmount: quoteTotals.deliveryWaivedAmount,
          total: grandTotal.toFixed(2),
          governorate: targetGovernorate,
          shippingAddress: targetAddress,
          latitude: targetLat,
          longitude: targetLng,
          updatedAt: new Date(),
        })
        .where(eq(onlineOrders.id, order.id));

      return {
        id: order.id,
        total: grandTotal.toFixed(2),
        subtotal: quoteTotals.subtotal,
        deliveryFee: quoteTotals.deliveryFee,
      };
    } else {
      // Items were not modified, but address/governorate may have changed
      const existingItems = await tx
        .select({
          lineTotal: onlineOrderItems.total,
        })
        .from(onlineOrderItems)
        .where(eq(onlineOrderItems.onlineOrderId, order.id));

      const quoteTotals = await totalOnlineOrderQuote(
        tx,
        existingItems,
        targetGovernorate,
        storeSettings?.freeShippingThreshold,
        String(order.subtotal),
        storeSettings?.freeShippingThresholdGovernorates,
      );

      // quoteTotals.total is subtotal (sum of existing item line totals, which already reflect any coupon discount) + deliveryFee.
      // Do NOT subtract couponDiscount again to prevent double coupon deduction.
      const grandTotal = money(quoteTotals.total);

      await tx
        .update(onlineOrders)
        .set({
          shippingCost: quoteTotals.deliveryFee,
          deliveryFree: quoteTotals.deliveryFree,
          deliveryWaivedAmount: quoteTotals.deliveryWaivedAmount,
          total: grandTotal.toFixed(2),
          governorate: targetGovernorate,
          shippingAddress: targetAddress,
          latitude: targetLat,
          longitude: targetLng,
          updatedAt: new Date(),
        })
        .where(eq(onlineOrders.id, order.id));

      return {
        id: order.id,
        total: grandTotal.toFixed(2),
        subtotal: String(order.subtotal),
        deliveryFee: quoteTotals.deliveryFee,
      };
    }
  });
}

/**
 * استلام موظف للطلب لحسابه (Claiming):
 * يسجل الطلب باسم الموظف ويبدأ توقيت التجهيز لحساب عمولته وحافز السرعة،
 * ويمنع تشتت المسؤولية وحجة «مو شغلي وما ندري».
 */
export async function claimOnlineOrder(
  input: { id: number; scopedBranchId: number | null },
  actor: { userId: number; role?: string }
): Promise<{ success: boolean; claimedByUserId: number; orderNumber: string }> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return await withTx(async (tx) => {
    const order = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, input.id))
        .for("update")
        .limit(1)
    )[0];
    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "الطلب غير موجود في النظام",
          why: `لم يُعثر على سجل طلب متجر بالمعرّف ${input.id}`,
          doThis: "تحقّق من رقم الطلب أو أعد تحديث قائمة الطلبات الواردة",
        }),
      });
    }
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر استلام الطلب للتجهيز",
          why: "الطلب مسجّل على فرع آخر خارج نطاق صلاحيتك الحالية",
          doThis: "تواصل مع مدير الفرع المعني أو بدّل الفرع في النظام",
        }),
      });
    }
    if (order.status === "CANCELLED" || order.status === "DELIVERED" || order.status === "SHIPPED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن استلام هذا الطلب للتجهيز",
          why:
            order.status === "SHIPPED"
              ? "تم شحن الطلب وتسليمه للمندوب بالفعل"
              : "الطلب ملغى أو تم تسليمه للعميل مسبقاً",
          doThis: "اختر طلباً قيد الانتظار أو قيد المعالجة لتجهيزه",
        }),
      });
    }

    const elevated = actor.role === "admin" || actor.role === "manager";
    if (order.claimedByUserId && Number(order.claimedByUserId) !== actor.userId && !elevated) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "الطلب مستلم ومحجوز مسبقاً",
          why: "قام موظف آخر بالتقاط هذا الطلب لحسابه وبدأ التجهيز بالفعل",
          doThis: "اختر طلباً آخر غير مستلم أو راجع مدير الصالة لإعادة التعيين",
        }),
      });
    }

    if (order.status === "PENDING") {
      const expiry = (
        await tx
          .select({
            reservationExpiresAt: sql<Date>`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR))`,
            expired: sql<number>`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR)) <= CURRENT_TIMESTAMP(3)`,
          })
          .from(onlineOrders)
          .where(eq(onlineOrders.id, input.id))
          .limit(1)
      )[0];
      if (expiry && Number(expiry.expired) === 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر استلام الطلب للتجهيز",
            why: "انتهت مهلة حجز مخزون هذا الطلب — اطلب من الزبون إعادة الطلب حسب التوفر الحالي",
            doThis: "اطلب من الزبون إعادة الطلب حسب التوفر الحالي للمخزون",
          }),
        });
      }
      await confirmCouponReservationForOnlineOrder(tx, input.id);
    }

    await tx
      .update(onlineOrders)
      .set({
        claimedByUserId: actor.userId,
        claimedAt: order.claimedAt ?? new Date(),
        status: order.status === "PENDING" ? "CONFIRMED" : order.status,
      })
      .where(eq(onlineOrders.id, input.id));

    return {
      success: true,
      claimedByUserId: actor.userId,
      orderNumber: order.orderNumber,
    };
  });
}

/**
 * تحديث حالة التواصل والمراسلة مع العميل وتثبيت الطلب هاتفياً/واتساب
 */
export async function updateOnlineOrderContact(
  input: {
    id: number;
    contactStatus: "NOT_CONTACTED" | "WHATSAPP_SENT" | "CALLED_CONFIRMED" | "NO_ANSWER" | "RETRY";
    contactNotes?: string | null;
    scopedBranchId: number | null;
  },
  actor: { userId: number; role?: string }
): Promise<{ success: boolean; contactStatus: string }> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return await withTx(async (tx) => {
    const order = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, input.id))
        .for("update")
        .limit(1)
    )[0];
    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "الطلب غير موجود في النظام",
          why: `لم يُعثر على سجل الطلب بالمعرّف ${input.id}`,
          doThis: "أعد تحديث الصفحة وتأكد من وجود الطلب في القائمة",
        }),
      });
    }
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تحديث حالة الاتصال للطلب",
          why: "الطلب مسجّل على فرع آخر خارج نطاق صلاحيتك الحالية",
          doThis: "بدّل الفرع الحالي في الشريط العلوي للفرع المطابق",
        }),
      });
    }
    if (order.status === "CANCELLED" || order.status === "DELIVERED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديث حالة الاتصال للطلب",
          why: `الطلب حالياً بحالة «${order.status}» وهي حالة نهائية`,
          doThis: "اختر طلباً نشطاً لتحديث حالة التواصل",
        }),
      });
    }

    if (input.contactStatus === "CALLED_CONFIRMED" && order.status === "PENDING") {
      const expiry = (
        await tx
          .select({
            reservationExpiresAt: sql<Date>`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR))`,
            expired: sql<number>`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR)) <= CURRENT_TIMESTAMP(3)`,
          })
          .from(onlineOrders)
          .where(eq(onlineOrders.id, input.id))
          .limit(1)
      )[0];
      if (expiry && Number(expiry.expired) === 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تأكيد الطلب هاتفياً",
            why: "انتهت مهلة حجز مخزون هذا الطلب — اطلب من الزبون إعادة الطلب حسب التوفر الحالي",
            doThis: "اطلب من الزبون إعادة الطلب حسب التوفر الحالي للمخزون",
          }),
        });
      }
      await confirmCouponReservationForOnlineOrder(tx, input.id);
    }

    await tx
      .update(onlineOrders)
      .set({
        contactStatus: input.contactStatus,
        contactNotes: input.contactNotes !== undefined ? input.contactNotes : order.contactNotes,
        status: input.contactStatus === "CALLED_CONFIRMED" && order.status === "PENDING" ? "CONFIRMED" : order.status,
        claimedByUserId: order.claimedByUserId ?? actor.userId,
        claimedAt: order.claimedAt ?? new Date(),
      })
      .where(eq(onlineOrders.id, input.id));

    return { success: true, contactStatus: input.contactStatus };
  });
}

/**
 * إتمام تجهيز الطلب وتعليبه (Mark as Prepared):
 * يحسب سرعة التجهيز بالدقائق ويقيد الطلب للموظف المجهز ليحصل على عمولته وحافز السرعة
 */
export async function markOnlineOrderPrepared(
  input: { id: number; scopedBranchId: number | null },
  actor: { userId: number; role?: string }
): Promise<{
  success: boolean;
  durationMinutes: number;
  orderNumber: string;
  orderId?: number;
  status?: string;
  preparedAt?: Date | null;
  preparedByUserId?: number | null;
  idempotent?: boolean;
}> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return await withTx(async (tx) => {
    const order = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, input.id))
        .for("update")
        .limit(1)
    )[0];
    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "الطلب غير موجود في النظام",
          why: `لم يُعثر على سجل الطلب رقم ${input.id}`,
          doThis: "تأكد من رقم الطلب من القائمة الرئيسية وأعد المحاولة",
        }),
      });
    }
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إتمام تجهيز الطلب",
          why: "الطلب مسجّل على فرع آخر غير الفرع المصرّح لك بالعمل عليه",
          doThis: "راجع إدارة الفرع المختص أو اختر طلباً من فرعك",
        }),
      });
    }
    if (order.status === "CANCELLED" || order.status === "DELIVERED" || order.status === "SHIPPED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر وضع علامة تم التجهيز",
          why: `الطلب حالياً بحالة «${order.status}» ولا يقبل إجراء التجهيز مجدداً`,
          doThis: "اختر طلباً مفتوحاً قيد المعالجة لتسجيل اكتمال تجهيزه",
        }),
      });
    }
    if (order.status !== "CONFIRMED" && order.status !== "PROCESSING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر وضع علامة تم التجهيز",
          why: `الطلب حالياً بحالة «${order.status}» ولا يقبل إجراء التجهيز مباشرة (يجب أن يكون مثبتاً أو قيد التجهيز)`,
          doThis: "ثبّت الطلب أولاً قبل البدء بتجهيزه",
        }),
      });
    }

    const elevated = actor.role === "admin" || actor.role === "manager";
    const otherClaimed = order.claimedByUserId && Number(order.claimedByUserId) !== actor.userId;
    const otherPrepared = order.preparedByUserId && Number(order.preparedByUserId) !== actor.userId;
    if ((otherClaimed || otherPrepared) && !elevated) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "الطلب مستلم للتجهيز بواسطة موظف آخر",
          why: "قام موظف آخر باستلام هذا الطلب للتجهيز بالفعل",
          doThis: "اختر طلباً مخصصاً لك أو راجع مشرف الصالة",
        }),
      });
    }

    if (order.preparedAt) {
      return {
        success: true,
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        preparedAt: order.preparedAt,
        durationMinutes: Number(order.fulfillmentDurationMinutes ?? 1),
        preparedByUserId: order.preparedByUserId != null ? Number(order.preparedByUserId) : null,
        idempotent: true,
      };
    }

    const startTime = order.claimedAt ?? order.createdAt;
    const now = new Date();
    const durationMinutes = Math.max(1, Math.round((now.getTime() - new Date(startTime).getTime()) / 60000));

    await tx
      .update(onlineOrders)
      .set({
        preparedByUserId: actor.userId,
        preparedAt: now,
        fulfillmentDurationMinutes: durationMinutes,
        status: "PROCESSING",
        claimedByUserId: order.claimedByUserId ?? actor.userId,
        claimedAt: order.claimedAt ?? now,
      })
      .where(eq(onlineOrders.id, input.id));

    return {
      success: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "PROCESSING",
      preparedAt: now,
      durationMinutes,
      preparedByUserId: actor.userId,
      idempotent: false,
    };
  });
}

export interface LeaderboardEntry {
  userId: number;
  userName: string;
  count: number;
  avgMinutes: number;
  fastestMinutes: number;
}

/**
 * لوحة أبطال التجهيز والمنافسة اليومية والشهرية (Leaderboard):
 * يعرض عدد الطلبات المجهزة ومتوسط سرعة التجهيز لكل موظف لفتح التنافس وتحفيز الإنتاجية
 */
export async function getOnlineOrderLeaderboard(scopedBranchId: number | null): Promise<{
  today: LeaderboardEntry[];
  month: LeaderboardEntry[];
}> {
  const db = getDb();
  if (!db) return { today: [], month: [] };

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));

  const queryFor = async (since: Date) => {
    const conds = [
      sql`${onlineOrders.preparedByUserId} IS NOT NULL`,
      gte(onlineOrders.preparedAt, since),
    ];
    if (scopedBranchId != null) conds.push(eq(onlineOrders.branchId, scopedBranchId));

    const rows = await db
      .select({
        userId: onlineOrders.preparedByUserId,
        userName: users.name,
        count: sql<number>`COUNT(*)`,
        avgMinutes: sql<number>`ROUND(AVG(COALESCE(${onlineOrders.fulfillmentDurationMinutes}, 10)))`,
        fastestMinutes: sql<number>`MIN(COALESCE(${onlineOrders.fulfillmentDurationMinutes}, 10))`,
      })
      .from(onlineOrders)
      .innerJoin(users, eq(onlineOrders.preparedByUserId, users.id))
      .where(and(...conds))
      .groupBy(onlineOrders.preparedByUserId, users.name)
      .orderBy(desc(sql`COUNT(*)`), asc(sql`AVG(COALESCE(${onlineOrders.fulfillmentDurationMinutes}, 10))`))
      .limit(10);

    return rows.map((r) => ({
      userId: Number(r.userId),
      userName: r.userName ?? "—",
      count: Number(r.count),
      avgMinutes: Number(r.avgMinutes || 0),
      fastestMinutes: Number(r.fastestMinutes || 0),
    }));
  };

  const [today, month] = await Promise.all([queryFor(todayStart), queryFor(monthStart)]);
  return { today, month };
}

/**
 * التوزيع التلقائي العادل الإجباري للطلبات المعلقة (Smart Round-Robin Dispatch):
 * يفحص موظفي الاستقبال/المبيعات النشطين في الفرع، ويوزع الطلبات المعلقة بالتناوب الآلي الصارم.
 * يضمن عدالة العبء التشغيلي وفرص العمولات ومنع تراكم الطلبات أو التهرب من المسؤولية.
 */
export async function autoAssignRoundRobinOnlineOrders(
  input: { scopedBranchId: number | null },
  actor: { userId: number; role?: string }
): Promise<{
  assignedCount: number;
  assignments: Array<{ orderId: number; orderNumber: string; assignedToUserId: number; assignedToName: string }>;
}> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  return await withTx(async (tx) => {
    // 1. استرجاع الطلبات المعلقة غير المستلمة (PENDING + claimedByUserId IS NULL)
    const baseConds = [
      eq(onlineOrders.status, "PENDING"),
      sql`${onlineOrders.claimedByUserId} IS NULL`,
    ];
    if (input.scopedBranchId != null) {
      baseConds.push(eq(onlineOrders.branchId, input.scopedBranchId));
    }

    const unassignedOrders = await tx
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        branchId: onlineOrders.branchId,
        createdAt: onlineOrders.createdAt,
      })
      .from(onlineOrders)
      .where(and(...baseConds))
      .orderBy(asc(onlineOrders.createdAt))
      .for("update");

    if (unassignedOrders.length === 0) {
      return { assignedCount: 0, assignments: [] };
    }

    // 2. البحث عن موظفي الفرع المؤهلين النشطين
    const userConds = [eq(users.isActive, true)];
    if (input.scopedBranchId != null) {
      userConds.push(eq(users.branchId, input.scopedBranchId));
    }
    const eligibleStaff = await tx
      .select({
        id: users.id,
        name: users.name,
      })
      .from(users)
      .where(and(...userConds))
      .orderBy(asc(users.id));

    if (eligibleStaff.length === 0) {
      eligibleStaff.push({ id: actor.userId, name: "المستخدم الحالي" });
    }

    // 3. تطبيق Round-Robin بالتناوب انطلاقاً من آخر إسناد
    const lastClaimed = (
      await tx
        .select({ claimedByUserId: onlineOrders.claimedByUserId })
        .from(onlineOrders)
        .where(
          and(
            sql`${onlineOrders.claimedByUserId} IS NOT NULL`,
            input.scopedBranchId != null ? eq(onlineOrders.branchId, input.scopedBranchId) : undefined,
          )
        )
        .orderBy(desc(onlineOrders.claimedAt))
        .limit(1)
    )[0];

    let startIdx = 0;
    if (lastClaimed?.claimedByUserId) {
      const lastIndex = eligibleStaff.findIndex((s) => s.id === lastClaimed.claimedByUserId);
      if (lastIndex >= 0) {
        startIdx = (lastIndex + 1) % eligibleStaff.length;
      }
    }

    const assignments: Array<{
      orderId: number;
      orderNumber: string;
      assignedToUserId: number;
      assignedToName: string;
    }> = [];

    const assignTime = new Date();

    for (let i = 0; i < unassignedOrders.length; i++) {
      const order = unassignedOrders[i];
      const staff = eligibleStaff[(startIdx + i) % eligibleStaff.length];

      await tx
        .update(onlineOrders)
        .set({
          claimedByUserId: staff.id,
          claimedAt: assignTime,
        })
        .where(eq(onlineOrders.id, order.id));

      assignments.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        assignedToUserId: staff.id,
        assignedToName: staff.name ?? "—",
      });
    }

    return {
      assignedCount: assignments.length,
      assignments,
    };
  });
}


