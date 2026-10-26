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
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  bundleComponents,
  couponPrograms,
  couponReservations,
  customers,
  deliveryParties,
  deliveryPricingRules,
  deliveryZones,
  invoices,
  onlineOrderItems,
  onlineOrders,
  productPrices,
  productUnits,
  productVariants,
  productImages,
  products,
  promotions,
  shifts,
  storeSettings as storeSettingsTable,
  users,
} from "../../../drizzle/schema";
import { alias } from "drizzle-orm/mysql-core";
import { getDb, type DB } from "../../db";
import { money, round2 } from "../money";
import { withTx } from "../tx";
import { decodeDataUrl, orderCustomizationAssetUrl, productImageUrl } from "../../imageRoute";
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
  resolveDeliveryFee,
  totalOnlineOrderQuote,
  type StorefrontPricingBenefitType,
} from "../onlineOrderService";
import { normalizeIraqPhoneE164 } from "../../lib/phone";
import { orderStatusLabel } from "@shared/onlineOrderStatus";
import { GOVERNORATES, governorateById, isBaghdadGovernorate } from "@shared/governorates";
import { computeDeliveryFee, type DeliveryPricingRuleInput } from "@shared/deliveryPricing";
import type { OnlineOrderLifecycle } from "@shared/onlineOrderLifecycle";
import { currentOnlineOrderStatus, loadOnlineOrderLifecycles } from "./onlineOrderTracking";

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
  branchId: number;
  orderNumber: string;
  status: string;
  lifecycle?: OnlineOrderLifecycle | null;
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
  claimedByUserId?: number | null;
  unclaimedOnly?: boolean;
}): Promise<OnlineOrderRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const conds = [];
  if (opts.scopedBranchId != null) conds.push(eq(onlineOrders.branchId, opts.scopedBranchId));
  if (opts.status) conds.push(eq(currentOnlineOrderStatus, opts.status));
  if (opts.claimedByUserId != null) conds.push(eq(onlineOrders.claimedByUserId, opts.claimedByUserId));
  if (opts.unclaimedOnly) conds.push(sql`${onlineOrders.claimedByUserId} IS NULL`);
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
      branchId: onlineOrders.branchId,
      orderNumber: onlineOrders.orderNumber,
      status: currentOnlineOrderStatus,
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

  const lifecycles = await loadOnlineOrderLifecycles(db, rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    branchId: Number(r.branchId),
    orderNumber: r.orderNumber,
    status: r.status,
    lifecycle: lifecycles.get(Number(r.id)) ?? null,
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
  const currentOrders = db
    .select({ status: currentOnlineOrderStatus.as("currentStatus") })
    .from(onlineOrders)
    .where(scopedBranchId != null ? eq(onlineOrders.branchId, scopedBranchId) : undefined)
    .as("currentOrders");
  const rows = await db
    .select({ status: currentOrders.status, n: sql<number>`COUNT(*)` })
    .from(currentOrders)
    .groupBy(currentOrders.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export interface EditableDeliveryZoneOption {
  id: string;
  name: string;
  deliveryFee: number;
  isActive: boolean;
  displayOrder: number;
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
  retailUnitPrice?: string;
  total: string;
  hasCustomization: boolean;
  customizationSummary: string | null;
  logoAssetUrl?: string | null;
  previewAssetUrl?: string | null;
}
export interface OnlineOrderDetail extends OnlineOrderRow {
  branchId: number;
  addressText: string | null;
  customerNotes: string | null;
  subtotal: string;
  pricingBenefitType: StorefrontPricingBenefitType;
  pricingBenefitLabel: string | null;
  pricingBenefitDiscount: string;
  couponFreeShipping: boolean;
  deliveryZones: EditableDeliveryZoneOption[];
  deliveryPartyName: string | null;
  /** يوقّع الخادم هذا الرمز ليُستعمل QR كوصلة عامة غير قابلة للتخمين. */
  labelToken: string;
  items: OnlineOrderDetailItem[];
}

const ORDER_NOTE_SEPARATOR = "\nملاحظة:";
const LEADING_ORDER_NOTE_PREFIX = "ملاحظة:";

function stripOrderNoteSegment(rawAddress: string | null | undefined): string {
  const raw = rawAddress?.trim() ?? "";
  if (!raw) return "";
  const sepIdx = raw.indexOf(ORDER_NOTE_SEPARATOR);
  if (sepIdx >= 0) {
    return raw.slice(0, sepIdx).trim();
  }
  if (raw.startsWith(LEADING_ORDER_NOTE_PREFIX)) {
    return "";
  }
  return raw;
}

function extractOrderNoteSegment(rawAddress: string | null | undefined): string {
  const raw = rawAddress?.trim() ?? "";
  if (!raw) return "";
  const sepIdx = raw.indexOf(ORDER_NOTE_SEPARATOR);
  if (sepIdx >= 0) {
    return raw.slice(sepIdx + ORDER_NOTE_SEPARATOR.length).trim();
  }
  if (raw.startsWith(LEADING_ORDER_NOTE_PREFIX)) {
    return raw.slice(LEADING_ORDER_NOTE_PREFIX.length).trim();
  }
  return "";
}

/**
 * يدمج العنوان وملاحظات التوصيل في `shippingAddress` دون تراكم مقاطع `\nملاحظة:` المكررة
 * ودون حذف الملاحظة القائمة عند تعديل الشارع وحده (`inputNotes === undefined`).
 */
export function composeOrderShippingAddress(
  existingAddress: string | null | undefined,
  inputShippingAddress: string | null | undefined,
  inputNotes: string | null | undefined,
  existingCustomerNotes?: string | null,
): string | null {
  if (inputShippingAddress === undefined && inputNotes === undefined) {
    return existingAddress ?? null;
  }

  const baseAddress =
    inputShippingAddress === undefined
      ? stripOrderNoteSegment(existingAddress)
      : stripOrderNoteSegment(inputShippingAddress);

  let effectiveNotes = "";
  if (inputNotes !== undefined) {
    effectiveNotes = inputNotes?.trim() ?? "";
  } else {
    const embeddedInInput = extractOrderNoteSegment(inputShippingAddress);
    if (embeddedInInput) {
      effectiveNotes = embeddedInInput;
    } else if (inputShippingAddress != null && inputShippingAddress.trim() !== "") {
      effectiveNotes = existingCustomerNotes?.trim() || extractOrderNoteSegment(existingAddress);
    }
  }

  if (effectiveNotes) {
    return baseAddress ? `${baseAddress}\nملاحظة: ${effectiveNotes}` : `ملاحظة: ${effectiveNotes}`;
  }
  return baseAddress || null;
}

function resolveUpdatedCustomerNotes(
  existingCustomerNotes: string | null | undefined,
  existingAddress: string | null | undefined,
  inputShippingAddress: string | null | undefined,
  inputNotes: string | null | undefined,
): string | null {
  if (inputNotes !== undefined) {
    const trimmed = inputNotes?.trim() ?? "";
    return trimmed || null;
  }
  if (inputShippingAddress !== undefined) {
    const embeddedInInput = extractOrderNoteSegment(inputShippingAddress);
    if (embeddedInInput) return embeddedInInput;
    if (inputShippingAddress != null && inputShippingAddress.trim() !== "") {
      const preserved = existingCustomerNotes?.trim() || extractOrderNoteSegment(existingAddress);
      return preserved || null;
    }
    return null;
  }
  const existing = existingCustomerNotes?.trim() || extractOrderNoteSegment(existingAddress);
  return existing || null;
}

async function loadEditableDeliveryZones(db: DB): Promise<EditableDeliveryZoneOption[]> {
  const [zoneRows, ruleRows] = await Promise.all([
    db
      .select({
        id: deliveryZones.id,
        code: deliveryZones.code,
        name: deliveryZones.name,
        isActive: deliveryZones.isActive,
        displayOrder: deliveryZones.displayOrder,
      })
      .from(deliveryZones)
      .orderBy(asc(deliveryZones.displayOrder), asc(deliveryZones.id)),
    db
      .select({
        id: deliveryPricingRules.id,
        zoneId: deliveryPricingRules.zoneId,
        ruleType: deliveryPricingRules.ruleType,
        baseFee: deliveryPricingRules.baseFee,
        perKmFee: deliveryPricingRules.perKmFee,
        perKgFee: deliveryPricingRules.perKgFee,
        minFee: deliveryPricingRules.minFee,
        maxFee: deliveryPricingRules.maxFee,
        isActive: deliveryPricingRules.isActive,
      })
      .from(deliveryPricingRules)
      .orderBy(asc(deliveryPricingRules.id)),
  ]);

  const rulesByZoneId = new Map<number, DeliveryPricingRuleInput[]>();
  for (const r of ruleRows) {
    const zId = Number(r.zoneId);
    const list = rulesByZoneId.get(zId) ?? [];
    list.push({
      id: Number(r.id),
      ruleType: r.ruleType,
      baseFee: r.baseFee,
      perKmFee: r.perKmFee ?? null,
      perKgFee: r.perKgFee ?? null,
      minFee: r.minFee ?? null,
      maxFee: r.maxFee ?? null,
      isActive: Boolean(r.isActive),
    });
    rulesByZoneId.set(zId, list);
  }

  const zoneByCode = new Map<string, (typeof zoneRows)[number]>();
  for (const z of zoneRows) {
    zoneByCode.set(z.code.trim(), z);
  }

  const knownGovIds = new Set<string>(GOVERNORATES.map((g) => g.id));
  const standardZones: EditableDeliveryZoneOption[] = GOVERNORATES.map((gov, idx) => {
    const zone = zoneByCode.get(gov.id);
    if (!zone) {
      return {
        id: gov.id,
        name: gov.name,
        deliveryFee: gov.deliveryFee,
        isActive: true,
        displayOrder: 1000 + idx,
      };
    }
    const rules = rulesByZoneId.get(Number(zone.id)) ?? [];
    // نحتفظ بقراءة قاعدة التسعير حتى لو أُوقفت المنطقة لاحقاً كي يعرض الطلب القائم عليها أجرتها الحقيقية
    const quote = computeDeliveryFee(rules);
    const fee = quote ? Number(round2(money(quote.fee))) : gov.deliveryFee;
    return {
      id: gov.id,
      name: zone.name.trim() || gov.name,
      deliveryFee: fee,
      isActive: Boolean(zone.isActive),
      displayOrder: Number(zone.displayOrder ?? idx),
    };
  });

  const customZones: EditableDeliveryZoneOption[] = zoneRows
    .filter((z) => Boolean(z.code.trim()) && !knownGovIds.has(z.code.trim()))
    .map((z, idx) => {
      const code = z.code.trim();
      const rules = rulesByZoneId.get(Number(z.id)) ?? [];
      const quote = computeDeliveryFee(rules);
      const fee = quote ? Number(round2(money(quote.fee))) : 0;
      return {
        id: code,
        name: z.name.trim() || code,
        deliveryFee: fee,
        isActive: Boolean(z.isActive),
        displayOrder: Number(z.displayOrder ?? 2000 + idx),
      };
    });

  return [...standardZones, ...customZones].sort((a, b) => a.displayOrder - b.displayOrder);
}

/** تفاصيل طلب (للملصق/العرض) — الطلب + العميل + البنود. */
export async function getOnlineOrder(id: number, scopedBranchId: number | null): Promise<OnlineOrderDetail | null> {
  const db = getDb();
  if (!db) return null;
  const claimedUsers = alias(users, "claimedUsers");
  const preparedUsers = alias(users, "preparedUsers");
  const retailPrices = alias(productPrices, "detailRetailPrices");
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: currentOnlineOrderStatus,
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
        pricingBenefitType: onlineOrders.pricingBenefitType,
        pricingBenefitLabel: onlineOrders.pricingBenefitLabel,
        pricingBenefitDiscount: onlineOrders.pricingBenefitDiscount,
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
        customerNotes: onlineOrders.customerNotes,
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
  const [lifecycleMap, items, editableZones, couponPromoRow] = await Promise.all([
    loadOnlineOrderLifecycles(db, [id]),
    db
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
        retailPrice: retailPrices.price,
        total: onlineOrderItems.total,
        customizationSnapshot: onlineOrderItems.customizationSnapshot,
      })
      .from(onlineOrderItems)
      .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
      .leftJoin(
        retailPrices,
        and(
          eq(retailPrices.productUnitId, onlineOrderItems.productUnitId),
          eq(retailPrices.priceTier, "RETAIL"),
        ),
      )
      .leftJoin(productImages, and(eq(productImages.productId, products.id), eq(productImages.isPrimary, true)))
      .where(eq(onlineOrderItems.onlineOrderId, id)),
    loadEditableDeliveryZones(db),
    order.couponCode
      ? db
          .select({ freeShipping: promotions.freeShipping })
          .from(couponReservations)
          .innerJoin(couponPrograms, eq(couponReservations.programId, couponPrograms.id))
          .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
          .where(
            and(
              eq(couponReservations.onlineOrderId, id),
              eq(couponReservations.status, "ACTIVE"),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const lifecycle = lifecycleMap.get(id) ?? null;
  const couponFreeShipping = Boolean(couponPromoRow[0]?.freeShipping);
  const resolvedCustomerNotes = order.customerNotes?.trim()
    ? order.customerNotes.trim()
    : extractOrderNoteSegment(order.addressText) || null;
  return {
    id: Number(order.id),
    orderNumber: order.orderNumber,
    status: order.status,
    lifecycle,
    branchId: Number(order.branchId),
    customerName: order.customerName ?? null,
    customerPhone: order.customerPhone ?? null,
    governorate: order.governorate ?? null,
    addressText: order.addressText ?? null,
    customerNotes: resolvedCustomerNotes,
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
    pricingBenefitType: (order.pricingBenefitType as StorefrontPricingBenefitType | null) ?? "NONE",
    pricingBenefitLabel: order.pricingBenefitLabel ?? null,
    pricingBenefitDiscount: String(order.pricingBenefitDiscount ?? "0.00"),
    couponFreeShipping,
    deliveryZones: editableZones,
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
      retailUnitPrice: String(i.retailPrice ?? i.unitPrice),
      total: String(i.total),
      hasCustomization: i.customizationSnapshot != null,
      customizationSummary: i.customizationSnapshot?.values
        .map((value) => `${value.label}: ${value.displayValue}`)
        .join(" • ") || null,
      logoAssetUrl: i.customizationSnapshot?.logoAssetKey
        ? orderCustomizationAssetUrl(i.customizationSnapshot.logoAssetKey)
        : null,
      previewAssetUrl: i.customizationSnapshot?.previewAssetKey
        ? orderCustomizationAssetUrl(i.customizationSnapshot.previewAssetKey)
        : null,
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
    const patch: Record<string, any> = { status: input.status };
    if (input.status === "CANCELLED") {
      patch.cancelReason = input.cancelReason?.trim() ? input.cancelReason.trim().slice(0, 500) : null;
    } else if (input.status === "CONFIRMED") {
      // من يثبت الطلب يستلمه تلقائياً للتجهيز إذا لم يكن مستلماً بالفعل لمنع تشتت المسؤولية
      if (order.claimedByUserId == null && _actorUserId) {
        patch.claimedByUserId = _actorUserId;
        patch.claimedAt = sql`CURRENT_TIMESTAMP(3)`;
      }
    }
    await tx.update(onlineOrders).set(patch).where(eq(onlineOrders.id, input.id));
    if (input.status === "CANCELLED") {
      await releaseCouponReservationForOnlineOrder(
        tx,
        input.id,
        input.cancelReason?.trim() || "أُلغي الطلب قبل الإرسال",
      );
    }
    if (input.status === "DELIVERED" && order.customerId != null) {
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

    // 4. Resolve or update customer details if provided (CF-05: never mutate shared CRM phone/phone2/phone3 across orders; rebind order to matching/new customer record when phone changes)
    let targetCustomerId: number | undefined = order.customerId != null ? Number(order.customerId) : undefined;
    if (order.customerId != null && (input.customerName != null || input.customerPhone != null)) {
      const currentCustomerId = Number(order.customerId);
      const [existingCustomer] = await tx
        .select({
          id: customers.id,
          name: customers.name,
          phone: customers.phone,
          phone2: customers.phone2,
          phone3: customers.phone3,
          whatsapp: customers.whatsapp,
          clientRequestId: customers.clientRequestId,
        })
        .from(customers)
        .where(eq(customers.id, currentCustomerId))
        .limit(1);

      const normalizeOrderPhone = (raw: string): string =>
        normalizeIraqPhoneE164(
          raw
            .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
            .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))),
        );

      const existingPhones = existingCustomer
        ? [
            existingCustomer.phone,
            existingCustomer.phone2,
            existingCustomer.phone3,
            existingCustomer.whatsapp,
          ]
            .filter((p): p is string => Boolean(p && p.trim()))
            .map((p) => {
              try {
                return normalizeOrderPhone(p.trim());
              } catch {
                return p.trim();
              }
            })
        : [];

      const trimmedNewName = input.customerName?.trim() || "";
      const rawNewPhone = input.customerPhone?.trim() || "";
      const normalizedPhone = rawNewPhone ? normalizeOrderPhone(rawNewPhone) : null;

      if (normalizedPhone && !existingPhones.includes(normalizedPhone)) {
        if (order.couponCode != null) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "لا يمكن تغيير رقم هاتف طلب مرتبط بكوبون خصم",
              why: `الطلب مرتبط بالكوبون (${order.couponCode}) وتغيير رقم الهاتف ينقل الطلب إلى سجل زبون مختلف`,
              doThis: "أبقِ رقم هاتف صاحب الطلب الأصلي أو ألغِ الطلب وأنشئ طلباً جديداً للزبون الآخر",
            }),
          });
        }
        const phoneVariants = Array.from(
          new Set(
            [
              normalizedPhone,
              rawNewPhone,
              ...(normalizedPhone.startsWith("+964")
                ? [
                    `0${normalizedPhone.slice(4)}`,
                    `964${normalizedPhone.slice(4)}`,
                    `00964${normalizedPhone.slice(4)}`,
                    normalizedPhone.slice(4),
                  ]
                : []),
            ].filter(Boolean),
          ),
        );
        const normDigits = normalizedPhone.replace(/\D/g, "");
        const digitVariants = Array.from(
          new Set(
            [
              normDigits,
              normDigits ? `00${normDigits}` : "",
              ...(normalizedPhone.startsWith("+964")
                ? [`0${normalizedPhone.slice(4)}`, normalizedPhone.slice(4)]
                : []),
            ].filter(Boolean),
          ),
        );
        const digitPredicates =
          digitVariants.length > 0
            ? (() => {
                const digitSqlList = sql.join(
                  digitVariants.map((d) => sql`${d}`),
                  sql`, `,
                );
                return [
                  sql`REGEXP_REPLACE(COALESCE(${customers.phone}, ''), '[^0-9]', '') IN (${digitSqlList})`,
                  sql`REGEXP_REPLACE(COALESCE(${customers.phone2}, ''), '[^0-9]', '') IN (${digitSqlList})`,
                  sql`REGEXP_REPLACE(COALESCE(${customers.phone3}, ''), '[^0-9]', '') IN (${digitSqlList})`,
                  sql`REGEXP_REPLACE(COALESCE(${customers.whatsapp}, ''), '[^0-9]', '') IN (${digitSqlList})`,
                ];
              })()
            : [];

        // ١) قراءة المرشحين بدون FOR UPDATE لتجنّب قفل الجدول الكامل وأقفال الفجوات المتصادمة عبر REGEXP_REPLACE
        const candidateCustomers = await tx
          .select({
            id: customers.id,
            isActive: customers.isActive,
            phone: customers.phone,
            phone2: customers.phone2,
            phone3: customers.phone3,
            whatsapp: customers.whatsapp,
          })
          .from(customers)
          .where(
            and(
              isNull(customers.deletedAt),
              or(
                inArray(customers.phone, phoneVariants),
                inArray(customers.phone2, phoneVariants),
                inArray(customers.phone3, phoneVariants),
                inArray(customers.whatsapp, phoneVariants),
                ...digitPredicates,
              )!,
            ),
          )
          .orderBy(desc(customers.isActive), desc(customers.id));

        const matchedCustomer = candidateCustomers.find((c) =>
          [c.phone, c.phone2, c.phone3, c.whatsapp].some((p) => {
            if (!p || !p.trim()) return false;
            try {
              return normalizeOrderPhone(p.trim()) === normalizedPhone;
            } catch {
              return false;
            }
          }),
        );

        let resolvedExistingCustomer = false;
        if (matchedCustomer) {
          const [lockedMatched] = await tx
            .select({
              id: customers.id,
              isActive: customers.isActive,
              deletedAt: customers.deletedAt,
              phone: customers.phone,
              phone2: customers.phone2,
              phone3: customers.phone3,
              whatsapp: customers.whatsapp,
            })
            .from(customers)
            .where(eq(customers.id, matchedCustomer.id))
            .limit(1)
            .for("update");
          const stillMatches =
            lockedMatched &&
            lockedMatched.deletedAt == null &&
            [
              lockedMatched.phone,
              lockedMatched.phone2,
              lockedMatched.phone3,
              lockedMatched.whatsapp,
            ].some((p) => {
              if (!p || !p.trim()) return false;
              try {
                return normalizeOrderPhone(p.trim()) === normalizedPhone;
              } catch {
                return false;
              }
            });
          if (stillMatches && lockedMatched) {
            if (lockedMatched.isActive === false) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: appErrorMessage({
                  what: "هذا الرقم مرتبط بعميل معطّل",
                  why: "سجل العميل المرتبط برقم الهاتف الجديد غير نشط حالياً",
                  doThis: "أعد تفعيل حساب العميل أولاً من شاشة العملاء أو تحقق من رقم الهاتف المدخل",
                }),
              });
            }
            targetCustomerId = Number(lockedMatched.id);
            resolvedExistingCustomer = true;
          }
        }

        if (!resolvedExistingCustomer) {
          // ٢) تسلسل مسار الإدراج عبر قفل استشاري موحّد يمنع تعارض أقفال الفجوات المتزامنة في InnoDB
          const upsertLockName = "online-customer:upsert";
          const lockResult = (await tx.execute(
            sql`SELECT GET_LOCK(${upsertLockName}, 10) AS locked`,
          )) as unknown;
          const lockRow = Array.isArray(lockResult)
            ? (lockResult[0] as Array<{ locked?: number }> | undefined)?.[0]
            : (lockResult as { rows?: Array<{ locked?: number }> })?.rows?.[0];
          if (Number(lockRow?.locked) !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: appErrorMessage({
                what: "تعذّر تأمين سجل الزبون",
                why: "تزامن تعديل آخر على سجلات الزبائن حالياً",
                doThis: "أعد المحاولة بعد لحظات",
              }),
            });
          }
          try {
            const [currentByPhone] = await tx
              .select({
                id: customers.id,
                isActive: customers.isActive,
              })
              .from(customers)
              .where(and(eq(customers.phone, normalizedPhone), isNull(customers.deletedAt)))
              .orderBy(desc(customers.isActive), desc(customers.id))
              .limit(1)
              .for("update");
            if (currentByPhone) {
              if (currentByPhone.isActive === false) {
                throw new TRPCError({
                  code: "FORBIDDEN",
                  message: appErrorMessage({
                    what: "هذا الرقم مرتبط بعميل معطّل",
                    why: "سجل العميل المرتبط برقم الهاتف الجديد غير نشط حالياً",
                    doThis: "أعد تفعيل حساب العميل أولاً من شاشة العملاء أو تحقق من رقم الهاتف المدخل",
                  }),
                });
              }
              targetCustomerId = Number(currentByPhone.id);
            } else {
              const [inserted] = await tx.insert(customers).values({
                name: trimmedNewName || existingCustomer?.name || "عميل متجر",
                phone: normalizedPhone,
                customerType: "فرد",
                defaultPriceTier: "RETAIL",
                creditLimit: "0",
                currentBalance: "0",
                isActive: true,
              });
              targetCustomerId = Number((inserted as { insertId?: number })?.insertId ?? currentCustomerId);
            }
          } finally {
            await tx.execute(sql`SELECT RELEASE_LOCK(${upsertLockName})`).catch(() => {});
          }
        }
      } else if (existingCustomer && trimmedNewName && trimmedNewName !== existingCustomer.name) {
        const isVerifiedStorefrontAccount = Boolean(
          existingCustomer.clientRequestId && existingCustomer.clientRequestId.startsWith("firebase-phone:"),
        );
        const [otherOrder] = await tx
          .select({ id: onlineOrders.id })
          .from(onlineOrders)
          .where(and(eq(onlineOrders.customerId, currentCustomerId), ne(onlineOrders.id, order.id)))
          .limit(1);
        const [otherInvoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.customerId, currentCustomerId))
          .limit(1);
        if (!isVerifiedStorefrontAccount && !otherOrder && !otherInvoice) {
          await tx
            .update(customers)
            .set({ name: trimmedNewName })
            .where(eq(customers.id, currentCustomerId));
        } else {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "لا يمكن تعديل اسم سجل عميل مشترك أو موثّق من شاشة الطلب",
              why: "سجل العميل مرتبط بطلبات أو فواتير أخرى أو بحساب متجر موثّق، وتعديل اسمه هنا يغيّر اسم العميل في كافة السجلات",
              doThis: "عدّل بيانات العميل من شاشة إدارة العملاء إن لزم، أو أضف اسم المستلم البديل في حقل ملاحظات التوصيل",
            }),
          });
        }
      }
    }

    // 5. Governorate & address & coordinates
    const targetGovernorate = input.governorate?.trim() || order.governorate || "baghdad";
    const matchedDbZone = targetGovernorate
      ? (
          await tx
            .select({ id: deliveryZones.id, isActive: deliveryZones.isActive })
            .from(deliveryZones)
            .where(eq(deliveryZones.code, targetGovernorate))
            .limit(1)
        )[0]
      : undefined;
    if (targetGovernorate && !governorateById(targetGovernorate) && !matchedDbZone) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "المحافظة أو المنطقة المحددة غير مدعومة",
          why: `الرمز أو الاسم المحدد (${targetGovernorate}) ليس من ضمن المحافظات والمناطق المعتمدة في النظام`,
          doThis: "اختر محافظة أو منطقة صالحة من القائمة المعتمدة",
        }),
      });
    }
    if (
      matchedDbZone &&
      matchedDbZone.isActive === false &&
      targetGovernorate !== (order.governorate ?? "")
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "منطقة التوصيل المختارة موقوفة حالياً",
          why: `منطقة التوصيل (${targetGovernorate}) معطّلة في إعدادات المناطق ولا تقبل تحويل طلبات إليها`,
          doThis: "اختر منطقة توصيل مفعّلة من القائمة المعتمدة",
        }),
      });
    }
    const targetAddress = composeOrderShippingAddress(
      order.shippingAddress,
      input.shippingAddress,
      input.notes,
      order.customerNotes,
    );
    const targetCustomerNotes = resolveUpdatedCustomerNotes(
      order.customerNotes,
      order.shippingAddress,
      input.shippingAddress,
      input.notes,
    );
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

    // استعادة ميزة شحن الكوبون المحجوزة للطلب لضمان عدم فقدانها عند إعادة حساب الطلب أو تغيير العنوان
    let couponShipping: { freeShipping?: boolean; shippingDiscountAmount?: string | null } | null = null;
    let activeReservation: { id: number; programId: number } | null = null;
    if (order.couponCode) {
      const reservation = (
        await tx
          .select({
            id: couponReservations.id,
            programId: couponReservations.programId,
          })
          .from(couponReservations)
          .where(
            and(
              eq(couponReservations.onlineOrderId, order.id),
              eq(couponReservations.status, "ACTIVE"),
            ),
          )
          .limit(1)
      )[0];

      if (reservation) {
        activeReservation = { id: Number(reservation.id), programId: Number(reservation.programId) };
        const promo = (
          await tx
            .select({
              freeShipping: promotions.freeShipping,
              shippingDiscountAmount: promotions.shippingDiscountAmount,
            })
            .from(couponPrograms)
            .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
            .where(eq(couponPrograms.id, reservation.programId))
            .limit(1)
        )[0];

        if (promo?.freeShipping) {
          couponShipping = {
            freeShipping: true,
            shippingDiscountAmount: promo.shippingDiscountAmount ? String(promo.shippingDiscountAmount) : "0.00",
          };
        }
      }
    }

    let retainedDeactivatedZoneFee: ReturnType<typeof money> | null = null;
    if (
      matchedDbZone &&
      matchedDbZone.isActive === false &&
      targetGovernorate === (order.governorate ?? "")
    ) {
      const zoneRules = await tx
        .select({
          id: deliveryPricingRules.id,
          ruleType: deliveryPricingRules.ruleType,
          baseFee: deliveryPricingRules.baseFee,
          perKmFee: deliveryPricingRules.perKmFee,
          perKgFee: deliveryPricingRules.perKgFee,
          minFee: deliveryPricingRules.minFee,
          maxFee: deliveryPricingRules.maxFee,
          isActive: deliveryPricingRules.isActive,
        })
        .from(deliveryPricingRules)
        .where(eq(deliveryPricingRules.zoneId, matchedDbZone.id))
        .orderBy(asc(deliveryPricingRules.id));
      const inactiveZoneQuote = computeDeliveryFee(
        zoneRules.map((r) => ({
          id: Number(r.id),
          ruleType: r.ruleType,
          baseFee: r.baseFee,
          perKmFee: r.perKmFee ?? null,
          perKgFee: r.perKgFee ?? null,
          minFee: r.minFee ?? null,
          maxFee: r.maxFee ?? null,
          isActive: Boolean(r.isActive),
        })),
      );
      if (inactiveZoneQuote) {
        retainedDeactivatedZoneFee = round2(money(inactiveZoneQuote.fee));
      } else if (!governorateById(targetGovernorate)) {
        retainedDeactivatedZoneFee = order.deliveryFree
          ? round2(money(order.deliveryWaivedAmount ?? "0"))
          : round2(money(order.shippingCost ?? "0"));
      }
    }

    const quoteOrderTotals = async (
      lineItems: Array<{ lineTotal: string }>,
      eligibilitySubtotalStr: string,
    ) => {
      const baseQuote = await totalOnlineOrderQuote(
        tx,
        lineItems,
        targetGovernorate,
        storeSettings?.freeShippingThreshold,
        eligibilitySubtotalStr,
        storeSettings?.freeShippingThresholdGovernorates,
        couponShipping,
      );
      if (retainedDeactivatedZoneFee == null) {
        return baseQuote;
      }
      const subtotal = round2(money(baseQuote.subtotal));
      const freeThreshold = baseQuote.freeShippingThreshold
        ? money(baseQuote.freeShippingThreshold)
        : null;
      const eligibilitySubtotal = round2(money(eligibilitySubtotalStr));
      const thresholdFree = Boolean(freeThreshold && eligibilitySubtotal.gte(freeThreshold));
      const couponFree = Boolean(
        couponShipping?.freeShipping && !thresholdFree && retainedDeactivatedZoneFee.gt(0),
      );
      const deliveryFree = thresholdFree || couponFree;
      const customerDeliveryFee = deliveryFree ? round2(money(0)) : retainedDeactivatedZoneFee;
      const deliveryWaivedAmount = deliveryFree ? retainedDeactivatedZoneFee : round2(money(0));
      const couponDeliveryWaivedAmount = couponFree ? retainedDeactivatedZoneFee : round2(money(0));
      const total = round2(subtotal.plus(customerDeliveryFee));
      return {
        ...baseQuote,
        deliveryFee: customerDeliveryFee.toFixed(2),
        deliveryFree,
        deliveryWaivedAmount: deliveryWaivedAmount.toFixed(2),
        couponDeliveryWaivedAmount: couponDeliveryWaivedAmount.toFixed(2),
        couponShippingApplied: couponFree,
        total: total.toFixed(2),
      };
    };

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

      // Normalize and merge duplicate productUnitId items
      const mergedByUnit = new Map<number, number>();
      for (const it of input.items) {
        const productUnitId = Number(it.productUnitId);
        const quantity = Math.floor(Number(it.quantity));
        if (!Number.isSafeInteger(productUnitId) || productUnitId <= 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "وحدة الصنف غير صحيحة",
              why: `رقم وحدة الصنف ${productUnitId} غير صالح`,
              doThis: "اختر وحدة صحيحة من قائمة المنتجات المتاحة",
            }),
          });
        }
        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "كمية الصنف غير صحيحة",
              why: `الكمية المدخلة (${quantity}) ليست عدداً صحيحاً موجباً`,
              doThis: "أدخل كمية صحيحة أكبر من صفر لكل صنف في الطلب",
            }),
          });
        }
        mergedByUnit.set(productUnitId, (mergedByUnit.get(productUnitId) ?? 0) + quantity);
      }
      const lines = Array.from(mergedByUnit.entries()).map(([productUnitId, quantity]) => ({
        productUnitId,
        quantity,
      }));

      // Unit locks in ascending order
      const unitIds = Array.from(mergedByUnit.keys()).sort((a, b) => a - b);
      await lockProductUnitsForOnlineAllocation(tx, unitIds);

      const isBaghdad = isBaghdadGovernorate(targetGovernorate);
      const applicableThresholdStr = isBaghdad
        ? storeSettings?.freeShippingThreshold
        : (storeSettings?.freeShippingThresholdGovernorates ?? storeSettings?.freeShippingThreshold);
      const configuredThreshold = applicableThresholdStr ? money(applicableThresholdStr) : null;
      const freeThreshold = configuredThreshold?.gt(0) ? configuredThreshold : null;
      const actualDeliveryFee =
        retainedDeactivatedZoneFee ?? (await resolveDeliveryFee(tx, targetGovernorate));

      // Price lines using official online order engine (staff edits can include any active catalog unit)
      const pricing = await priceOnlineOrderLines(
        tx,
        Number(order.branchId),
        lines,
        {
          lock: true,
          allowStaffCatalogUnits: true,
          deliveryContext: {
            actualDeliveryFee,
            freeShippingThreshold: freeThreshold,
          },
        },
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

      const quoteTotals = await quoteOrderTotals(pricing.items, retailSubtotal.toFixed(2));

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

      let targetCouponCode = order.couponCode;
      if (activeReservation && couponShipping?.freeShipping && currentCouponDiscount.lte(0)) {
        if (money(quoteTotals.couponDeliveryWaivedAmount).gt(0)) {
          await tx
            .update(couponReservations)
            .set({
              discountAmount: quoteTotals.couponDeliveryWaivedAmount,
            })
            .where(eq(couponReservations.id, activeReservation.id));
        } else {
          // Destination's store threshold now grants free delivery:
          // Release reservation and detach coupon from order so customer's one-time coupon isn't burned with 0 incremental benefit.
          await tx
            .update(couponReservations)
            .set({
              status: "RELEASED",
              releasedAt: sql`CURRENT_TIMESTAMP(3)`,
              releaseReason: "شحن مجاني تلقائي من سقف المتجر",
              discountAmount: "0.00",
            })
            .where(eq(couponReservations.id, activeReservation.id));
          targetCouponCode = null;
        }
      }

      await tx
        .update(onlineOrders)
        .set({
          customerId: targetCustomerId,
          couponCode: targetCouponCode,
          pricingBenefitType: pricing.benefit.type,
          pricingBenefitLabel: pricing.benefit.label,
          pricingBenefitDiscount: pricing.benefit.discount,
          subtotal: quoteTotals.subtotal,
          shippingCost: quoteTotals.deliveryFee,
          deliveryFree: quoteTotals.deliveryFree,
          deliveryWaivedAmount: quoteTotals.deliveryWaivedAmount,
          total: grandTotal.toFixed(2),
          governorate: targetGovernorate,
          shippingAddress: targetAddress,
          customerNotes: targetCustomerNotes,
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

      const benefitDiscount = money(order.pricingBenefitDiscount ?? "0");
      const couponMerchDiscount = money(order.couponDiscount ?? "0");
      const persistedMerchandiseDiscount = benefitDiscount.gt(couponMerchDiscount)
        ? benefitDiscount
        : couponMerchDiscount;
      const retailEligibilitySubtotal = round2(
        money(order.subtotal).plus(persistedMerchandiseDiscount),
      ).toFixed(2);

      const quoteTotals = await quoteOrderTotals(existingItems, retailEligibilitySubtotal);

      // quoteTotals.total is subtotal (sum of existing item line totals, which already reflect any coupon discount) + deliveryFee.
      // Do NOT subtract couponDiscount again to prevent double coupon deduction.
      const grandTotal = money(quoteTotals.total);

      let targetCouponCode = order.couponCode;
      let detachedShippingCoupon = false;
      if (activeReservation && couponShipping?.freeShipping && money(order.couponDiscount ?? "0").lte(0)) {
        if (money(quoteTotals.couponDeliveryWaivedAmount).gt(0)) {
          await tx
            .update(couponReservations)
            .set({
              discountAmount: quoteTotals.couponDeliveryWaivedAmount,
            })
            .where(eq(couponReservations.id, activeReservation.id));
        } else {
          // Destination's store threshold now grants free delivery:
          // Release reservation and detach coupon from order so customer's one-time coupon isn't burned with 0 incremental benefit.
          await tx
            .update(couponReservations)
            .set({
              status: "RELEASED",
              releasedAt: sql`CURRENT_TIMESTAMP(3)`,
              releaseReason: "شحن مجاني تلقائي من سقف المتجر",
              discountAmount: "0.00",
            })
            .where(eq(couponReservations.id, activeReservation.id));
          targetCouponCode = null;
          detachedShippingCoupon = true;
        }
      }

      await tx
        .update(onlineOrders)
        .set({
          customerId: targetCustomerId,
          couponCode: targetCouponCode,
          ...(detachedShippingCoupon && order.pricingBenefitType === "COUPON"
            ? {
                pricingBenefitType: "NONE" as const,
                pricingBenefitLabel: null,
                pricingBenefitDiscount: "0.00",
              }
            : {}),
          shippingCost: quoteTotals.deliveryFee,
          deliveryFree: quoteTotals.deliveryFree,
          deliveryWaivedAmount: quoteTotals.deliveryWaivedAmount,
          total: grandTotal.toFixed(2),
          governorate: targetGovernorate,
          shippingAddress: targetAddress,
          customerNotes: targetCustomerNotes,
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

    if (order.status === "PENDING") {
      await enqueueStorefrontOrderStatusPush(tx, {
        orderId: input.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId == null ? null : Number(order.customerId),
        status: "CONFIRMED",
      });
    }

    return {
      success: true,
      claimedByUserId: actor.userId,
      orderNumber: order.orderNumber,
    };
  });
}

/**
 * إحياء وتأكيد طلب منتهي الحجز تلقائياً (Revive & Confirm):
 * 1. فحص توفر المخزون الفعلي (ATP) في فرع التنفيذ لجميع بنود الطلب
 * 2. احترام تريجر قاعدة البيانات trg_online_orders_expired_activation_bu عبر تحديث reservationExpiresAt
 *    إلى المستقبل (24 ساعة إضافية) والطلب PENDING في خطوة أولى
 * 3. نقل الحالة إلى CONFIRMED وإسناد استلام التجهيز للمستخدم الفاعل في خطوة ثانية
 * 4. إعادة تثبيت قسيمة الخصم إن وُجدت
 */
export async function reviveAndConfirmOnlineOrder(
  input: { id: number; scopedBranchId: number | null },
  actor: { userId: number; role?: string }
): Promise<{
  success: boolean;
  orderId: number;
  orderNumber: string;
  status: OnlineOrderStatus;
  claimedByUserId: number;
}> {
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
          doThis: "تحقّق من رقم الطلب أو أعد تحديث قائمة الطلبات",
        }),
      });
    }
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إحياء الطلب",
          why: "الطلب مسجّل على فرع آخر خارج نطاق صلاحيتك الحالية",
          doThis: "تواصل مع مدير الفرع المعني أو بدّل الفرع في النظام",
        }),
      });
    }

    if (order.status !== "CANCELLED" && order.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن إحياء الطلب في حالته الحالية",
          why: `الطلب حالياً بحالة «${order.status}» وليس حجزاً ملغى أو منتهياً`,
          doThis: "إحياء الطلب مخصص للطلبات التي انتهت مهلة حجزها التلقائي",
        }),
      });
    }

    if (order.invoiceId != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إحياء الطلب",
          why: "الطلب مرتبط بفاتورة مسبقة في النظام",
          doThis: "راجع الفاتورة المرتبطة بالطلب أو قم بإنشاء طلب جديد للزبون",
        }),
      });
    }

    // 1. فحص توفر المخزون (ATP) لجميع بنود الطلب مع مراعاة الوحدات الأساس والعروض المركبة
    const items = await tx
      .select({
        id: onlineOrderItems.id,
        variantId: onlineOrderItems.variantId,
        productUnitId: onlineOrderItems.productUnitId,
        quantity: onlineOrderItems.quantity,
        baseQuantity: onlineOrderItems.baseQuantity,
      })
      .from(onlineOrderItems)
      .where(eq(onlineOrderItems.onlineOrderId, input.id));

    if (items.length > 0) {
      const itemVariantIds = Array.from(new Set(items.map((i) => Number(i.variantId))));
      const recipes = itemVariantIds.length
        ? await tx
            .select({
              bundleVariantId: bundleComponents.bundleVariantId,
              componentVariantId: bundleComponents.componentVariantId,
              componentBaseQuantity: bundleComponents.componentBaseQuantity,
            })
            .from(bundleComponents)
            .where(inArray(bundleComponents.bundleVariantId, itemVariantIds))
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
      for (const item of items) {
        const vId = Number(item.variantId);
        const baseQty = Number(item.baseQuantity ?? item.quantity);
        const components = recipeByBundle.get(vId);
        if (components && components.length > 0) {
          for (const comp of components) {
            const required = baseQty * comp.componentBaseQuantity;
            stockRequirements.set(
              comp.componentVariantId,
              (stockRequirements.get(comp.componentVariantId) ?? 0) + required,
            );
          }
        } else {
          stockRequirements.set(
            vId,
            (stockRequirements.get(vId) ?? 0) + baseQty,
          );
        }
      }

      const requiredVariantIds = Array.from(stockRequirements.keys()).sort((a, b) => a - b);
      const availability = await loadVariantAvailability(
        tx,
        Number(order.branchId),
        requiredVariantIds,
        { lock: true, excludeOnlineOrderId: order.id }
      );

      for (const [vId, reqQty] of Array.from(stockRequirements.entries())) {
        const avail = availability.get(vId);
        if (avail?.isService) continue;
        if (!avail) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "أحد أصناف الطلب غير متاح في الفرع",
              why: `الصنف #${vId} غير معرّف أو غير متاح في فرع التنفيذ`,
              doThis: "تأكد من توفر الأصناف في الفرع أو حوّل الطلب لفرع آخر",
            }),
          });
        }
        if (reqQty > avail.availableBase) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "المخزون غير كافٍ لإحياء الطلب",
              why: `الكمية المطلوبة (${reqQty}) من الصنف #${vId} تتجاوز الرصيد الحر المتاح في الفرع (${avail.availableBase})`,
              doThis: "اطلب من الزبون تعديل الطلب أو قم بتوريد مخزون إضافي إلى الفرع",
            }),
          });
        }
      }
    }

    // 2. تحديث الخطوة الأولى (حارس التريجر trg_online_orders_expired_activation_bu):
    // التريجر يفحص OLD.reservationExpiresAt <= CURRENT_TIMESTAMP(3) عند التحويل إلى CONFIRMED.
    // لذلك يجب أولاً ضبط reservationExpiresAt في المستقبل بينما الطلب بحالة PENDING.
    await tx
      .update(onlineOrders)
      .set({
        status: "PENDING",
        cancelReason: null,
        reservationExpiresAt: sql`DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 24 HOUR)`,
      })
      .where(eq(onlineOrders.id, input.id));

    // 3. الخطوة الثانية: نقل الحالة إلى CONFIRMED وإسناد التجهيز للفاعل
    await tx
      .update(onlineOrders)
      .set({
        status: "CONFIRMED",
        claimedByUserId: actor.userId,
        claimedAt: sql`CURRENT_TIMESTAMP(3)`,
      })
      .where(eq(onlineOrders.id, input.id));

    // 4. إعادة تثبيت الكوبون إن وجد
    await confirmCouponReservationForOnlineOrder(tx, input.id);

    // 5. إشعار المتجر بتحديث الحالة
    await enqueueStorefrontOrderStatusPush(tx, {
      orderId: input.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId == null ? null : Number(order.customerId),
      status: "CONFIRMED",
    });

    return {
      success: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "CONFIRMED",
      claimedByUserId: actor.userId,
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

    const isConfirming = input.contactStatus === "CALLED_CONFIRMED" && order.status === "PENDING";
    const nextStatus = isConfirming ? "CONFIRMED" : order.status;
    const patch: Record<string, any> = {
      contactStatus: input.contactStatus,
      contactNotes: input.contactNotes !== undefined ? input.contactNotes : order.contactNotes,
      status: nextStatus,
    };
    if (isConfirming && order.claimedByUserId == null) {
      patch.claimedByUserId = actor.userId;
      patch.claimedAt = sql`CURRENT_TIMESTAMP(3)`;
    }

    await tx
      .update(onlineOrders)
      .set(patch)
      .where(eq(onlineOrders.id, input.id));

    if (isConfirming) {
      await enqueueStorefrontOrderStatusPush(tx, {
        orderId: input.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId == null ? null : Number(order.customerId),
        status: "CONFIRMED",
      });
    }

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
    // 1. استرجاع الطلبات المعلقة غير المستلمة غير منتهية الحجز (PENDING + claimedByUserId IS NULL)
    const baseConds = [
      eq(onlineOrders.status, "PENDING"),
      sql`${onlineOrders.claimedByUserId} IS NULL`,
      sql`COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR)) > CURRENT_TIMESTAMP(3)`,
    ];
    if (input.scopedBranchId != null) {
      baseConds.push(eq(onlineOrders.branchId, input.scopedBranchId));
    }

    const unassignedOrders = await tx
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        customerId: onlineOrders.customerId,
        status: onlineOrders.status,
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

    // 2. التحقق من الموظفين أصحاب الورديات المفتوحة حصراً في الفرع (Shift-Aware)
    const shiftConds = [
      eq(shifts.status, "OPEN"),
      eq(users.isActive, true),
    ];
    if (input.scopedBranchId != null) {
      shiftConds.push(eq(shifts.branchId, input.scopedBranchId));
    }
    const eligibleStaff = await tx
      .select({
        id: users.id,
        name: users.name,
        branchId: shifts.branchId,
      })
      .from(shifts)
      .innerJoin(users, eq(shifts.userId, users.id))
      .where(and(...shiftConds))
      .groupBy(users.id, users.name, shifts.branchId)
      .orderBy(asc(users.id));

    if (eligibleStaff.length === 0) {
      return { assignedCount: 0, assignments: [] };
    }

    // 3. موازنة العبء الفعلي (Least-Loaded Workload Balancing):
    // إحصاء الطلبات المفتوحة قيد التجهيز (CONFIRMED / PROCESSING) لكل موظف صاحب وردية مفتوحة
    const staffLoads = new Map<number, number>();
    for (const s of eligibleStaff) {
      staffLoads.set(s.id, 0);
    }

    const loadRows = await tx
      .select({
        claimedByUserId: onlineOrders.claimedByUserId,
        count: sql<number>`COUNT(*)`,
      })
      .from(onlineOrders)
      .where(
        and(
          inArray(onlineOrders.status, ["CONFIRMED", "PROCESSING"]),
          inArray(onlineOrders.claimedByUserId, eligibleStaff.map((s) => s.id)),
        )
      )
      .groupBy(onlineOrders.claimedByUserId);

    for (const row of loadRows) {
      if (row.claimedByUserId != null) {
        staffLoads.set(Number(row.claimedByUserId), Number(row.count));
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

      // حصر الموظفين المتاحين في نفس فرع الطلب حصراً
      const candidates = eligibleStaff.filter(
        (s) => Number(s.branchId) === Number(order.branchId)
      );
      if (candidates.length === 0) {
        continue;
      }

      // اختيار الموظف الأقل عبئاً في فرع الطلب لمنع الاحتكار والصيد الانتقائي (Cherry-picking)
      let selectedStaff = candidates[0];
      let minLoad = staffLoads.get(selectedStaff.id) ?? 0;

      for (let j = 1; j < candidates.length; j++) {
        const candidate = candidates[j];
        const load = staffLoads.get(candidate.id) ?? 0;
        if (load < minLoad) {
          minLoad = load;
          selectedStaff = candidate;
        }
      }

      staffLoads.set(selectedStaff.id, minLoad + 1);

      if (order.status === "PENDING") {
        await confirmCouponReservationForOnlineOrder(tx, order.id);
      }

      await tx
        .update(onlineOrders)
        .set({
          claimedByUserId: selectedStaff.id,
          claimedAt: assignTime,
          status: order.status === "PENDING" ? "CONFIRMED" : order.status,
        })
        .where(eq(onlineOrders.id, order.id));

      if (order.status === "PENDING") {
        await enqueueStorefrontOrderStatusPush(tx, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId: order.customerId == null ? null : Number(order.customerId),
          status: "CONFIRMED",
        });
      }

      assignments.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        assignedToUserId: selectedStaff.id,
        assignedToName: selectedStaff.name ?? "—",
      });
    }

    return {
      assignedCount: assignments.length,
      assignments,
    };
  });
}


