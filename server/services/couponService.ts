import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  couponPrograms,
  couponRedemptions,
  couponReservations,
  coupons,
  customers,
  invoices,
  promotions,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractAffectedRows } from "../lib/insertId";
import { money, toDbMoney } from "./money";

export interface LockedCoupon {
  couponId: number;
  programId: number;
  promotionId: number;
  code: string;
  perCouponLimit: number;
  customerId: number | null;
  programName: string;
}

export function normalizeCouponCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function hashCouponCode(value: string): string {
  return createHash("sha256").update(normalizeCouponCode(value), "utf8").digest("hex");
}

function dateYmd(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

async function selectCouponContext(tx: Tx, normalizedCode: string, lock: boolean) {
  const query = tx.select({
    coupon: coupons,
    program: couponPrograms,
    promotion: promotions,
  }).from(coupons)
    .innerJoin(couponPrograms, eq(coupons.programId, couponPrograms.id))
    .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
    .where(eq(coupons.codeHash, hashCouponCode(normalizedCode)))
    .limit(1);
  return (lock ? await query.for("update") : await query)[0] ?? null;
}

/**
 * قفل ترتيب فقط لمسار dispatch: يكتسب الصفوف نفسها التي يقفلها create قبل productUnit/stock،
 * ثم يعيد lockCouponForSale الفحص الكامل re-entrantly بعد قفل الطلب الحالي.
 */
export async function prelockCouponForOnlineDispatch(tx: Tx, code: string): Promise<void> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز الكوبون مطلوب" });
  if (!await selectCouponContext(tx, normalized, true)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "رمز الكوبون غير صحيح" });
  }
}

/**
 * يفحص الكوبون وبرنامجه داخل معاملة البيع.
 * `options.lock=false` مخصّص للتسعيرة القارئة فقط: لا FOR UPDATE ولا تنظيف حجوزات منتهية؛
 * الإنشاء/الاستهلاك يبقيان على القفل افتراضياً لمنع تجاوز الحدود بالتزامن.
 */
export async function lockCouponForSale(
  tx: Tx,
  input: {
    code: string;
    branchId: number;
    customerId: number | null;
    todayYmd: string;
    /** طلب متجر يستهلك حجزه هو؛ يُستثنى هذا الحجز وحده من عدّ الحجوزات النشطة. */
    reservationOnlineOrderId?: number | null;
    /** واجهة المتجر لا تقبل قسيمة شخصية بلا إثبات جلسة مطابق للعميل المعيّن. */
    requireAuthenticatedAssignedCustomer?: boolean;
    authenticatedCustomerId?: number | null;
  },
  options: { lock?: boolean } = {},
): Promise<LockedCoupon> {
  const normalized = normalizeCouponCode(input.code);
  if (!normalized) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز الكوبون مطلوب" });

  const shouldLock = options.lock !== false;
  const row = await selectCouponContext(tx, normalized, shouldLock);

  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "رمز الكوبون غير صحيح" });
  if (row.program.branchId != null && Number(row.program.branchId) !== input.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الكوبون لا يخص هذا الفرع" });
  }
  if (row.promotion.branchId != null && Number(row.promotion.branchId) !== input.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص هذا الفرع" });
  }
  const assignedCustomerId = row.coupon.customerId == null ? null : Number(row.coupon.customerId);
  if (
    assignedCustomerId != null &&
    input.requireAuthenticatedAssignedCustomer === true &&
    input.authenticatedCustomerId !== assignedCustomerId
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الكوبون الشخصي يتطلب جلسة العميل الموثّقة" });
  }
  if (assignedCustomerId != null && assignedCustomerId !== input.customerId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الكوبون مخصص لعميل آخر" });
  }

  // القفل أعلاه يشمل صف البرنامج أيضاً، فيُسلسل قسيمتين مختلفتين من البرنامج نفسه لعميل واحد؛
  // وإلا استطاع طلبان متزامنان تجاوز perCustomerLimit مع أن كل واحد قفل صف قسيمته فقط.
  // التسعيرة lock=false قارئة محضة؛ عامل الانتهاء/مسار الإنشاء هما من يحرران الصفوف فعلياً.
  if (shouldLock) {
    await tx
      .update(couponReservations)
      .set({
        status: "RELEASED",
        releasedAt: sql`CURRENT_TIMESTAMP(3)`,
        releaseReason: "انتهت مهلة الحجز",
      })
      .where(and(
        eq(couponReservations.status, "ACTIVE"),
        sql`${couponReservations.expiresAt} IS NOT NULL AND ${couponReservations.expiresAt} <= CURRENT_TIMESTAMP(3)`,
        or(
          eq(couponReservations.couponId, row.coupon.id),
          input.customerId == null
            ? undefined
            : and(
                eq(couponReservations.programId, row.program.id),
                eq(couponReservations.customerId, input.customerId),
              ),
        ),
      ));
  }

  const ownReservationId = input.reservationOnlineOrderId ?? null;
  let consumingOwnReservation = false;
  if (ownReservationId != null) {
    if (!shouldLock) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "استهلاك حجز القسيمة يتطلب قفلاً ذرياً" });
    }
    const own = (await tx
      .select()
      .from(couponReservations)
      .where(and(
        eq(couponReservations.onlineOrderId, ownReservationId),
        eq(couponReservations.status, "ACTIVE"),
      ))
      .for("update")
      .limit(1))[0];
    if (
      !own || Number(own.couponId) !== Number(row.coupon.id) ||
      Number(own.programId) !== Number(row.program.id) ||
      Number(own.customerId) !== Number(input.customerId) ||
      (own.expiresAt != null && own.expiresAt.getTime() <= Date.now())
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "حجز القسيمة غير موجود أو انتهت صلاحيته" });
    }
    consumingOwnReservation = true;
  }

  // الحجز النشط وعدٌ سبق فحصه وتسعيره. REDEEMED قد يعني أن وعداً legacy آخر سبق إلى
  // dispatch؛ نفي بالحجز المملوك ولا نعيد الحدود/التاريخ. VOID إبطال إداري صريح فيبقى مغلقاً.
  if (row.coupon.status === "VOID" || (row.coupon.status === "REDEEMED" && !consumingOwnReservation)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون مستخدم أو ملغى" });
  }
  if (!consumingOwnReservation) {
    if (row.program.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: "برنامج الكوبون غير نشط" });
    if (!row.promotion.isActive || row.promotion.applicationMode !== "COUPON") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "العرض المرتبط بالكوبون غير نشط" });
    }
    const from = dateYmd(row.program.validFrom)!;
    const to = dateYmd(row.program.validTo);
    if (input.todayYmd < from || (to != null && input.todayYmd > to)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون خارج مدة الصلاحية" });
    }
  }

  if (!consumingOwnReservation) {
    // يجب أن تكون قراءات الحدود locking/current reads. في MySQL REPEATABLE READ، SELECT count
    // عادي قد يعيد snapshot أُنشئت قبل انتظار قفل القسيمة/البرنامج، فيفوّت حجز الفائز الذي
    // التزم للتو. قراءة المعرفات FOR UPDATE ترى الحالة الحالية وتغلق النطاق المفهرس.
    const activeCouponHoldsQuery = tx
      .select({ id: couponReservations.id })
      .from(couponReservations)
      .where(and(
        eq(couponReservations.couponId, row.coupon.id),
        eq(couponReservations.status, "ACTIVE"),
        sql`(${couponReservations.expiresAt} IS NULL OR ${couponReservations.expiresAt} > CURRENT_TIMESTAMP(3))`,
      ));
    const activeCouponHolds = shouldLock
      ? await activeCouponHoldsQuery.for("update")
      : await activeCouponHoldsQuery;
    if (
      Number(row.coupon.redemptionCount) + activeCouponHolds.length >=
      Number(row.program.perCouponLimit)
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "استُنفدت مرات استخدام الكوبون" });
    }
    if (input.customerId != null) {
      const usedQuery = tx
        .select({ id: couponRedemptions.id })
        .from(couponRedemptions)
        .where(and(
          eq(couponRedemptions.programId, row.program.id),
          eq(couponRedemptions.customerId, input.customerId),
        ));
      const used = shouldLock ? await usedQuery.for("update") : await usedQuery;
      const heldQuery = tx
        .select({ id: couponReservations.id })
        .from(couponReservations)
        .where(and(
          eq(couponReservations.programId, row.program.id),
          eq(couponReservations.customerId, input.customerId),
          eq(couponReservations.status, "ACTIVE"),
          sql`(${couponReservations.expiresAt} IS NULL OR ${couponReservations.expiresAt} > CURRENT_TIMESTAMP(3))`,
        ));
      const held = shouldLock ? await heldQuery.for("update") : await heldQuery;
      if (
        used.length + held.length >=
        Number(row.program.perCustomerLimit)
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "بلغ العميل الحد المسموح لهذا البرنامج" });
      }
    }
  }
  return {
    couponId: Number(row.coupon.id),
    programId: Number(row.program.id),
    promotionId: Number(row.promotion.id),
    code: normalized,
    perCouponLimit: Number(row.program.perCouponLimit),
    customerId: assignedCustomerId,
    programName: row.program.name,
  };
}

/** يحجز استعمال القسيمة للطلب بلا زيادة redemptionCount؛ يجب استدعاؤه في معاملة إنشاء الطلب. */
export async function reserveCouponForOnlineOrder(
  tx: Tx,
  coupon: LockedCoupon,
  input: {
    onlineOrderId: number;
    customerId: number;
    branchId: number;
    discountAmount: string;
    expiresAt: Date;
  },
): Promise<void> {
  if (money(input.discountAmount).lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون لا ينطبق على أصناف الطلب" });
  }
  if (coupon.customerId != null && coupon.customerId !== input.customerId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الكوبون مخصص لعميل آخر" });
  }
  await tx.insert(couponReservations).values({
    couponId: coupon.couponId,
    programId: coupon.programId,
    onlineOrderId: input.onlineOrderId,
    customerId: input.customerId,
    branchId: input.branchId,
    discountAmount: toDbMoney(input.discountAmount),
    status: "ACTIVE",
    expiresAt: input.expiresAt,
  });
}

/** التأكيد قبل انتهاء PENDING يحوّل الحجز المؤقت إلى وعدٍ بلا مهلة حتى الإرسال أو الإلغاء. */
export async function confirmCouponReservationForOnlineOrder(tx: Tx, onlineOrderId: number): Promise<number> {
  const result = await tx
    .update(couponReservations)
    .set({ expiresAt: null })
    .where(and(
      eq(couponReservations.onlineOrderId, onlineOrderId),
      eq(couponReservations.status, "ACTIVE"),
    ));
  return extractAffectedRows(result);
}

/** إلغاء/انتهاء قبل SHIPPED يحرر الحجز فقط؛ الاسترداد بعد الإرسال سياسة مالية مستقلة. */
export async function releaseCouponReservationForOnlineOrder(
  tx: Tx,
  onlineOrderId: number | readonly number[],
  reason: string,
): Promise<number> {
  const orderIds = Array.isArray(onlineOrderId) ? [...onlineOrderId] : [onlineOrderId];
  if (!orderIds.length) return 0;
  const result = await tx
    .update(couponReservations)
    .set({
      status: "RELEASED",
      releasedAt: sql`CURRENT_TIMESTAMP(3)`,
      releaseReason: reason.trim().slice(0, 120),
    })
    .where(and(
      orderIds.length === 1
        ? eq(couponReservations.onlineOrderId, orderIds[0])
        : inArray(couponReservations.onlineOrderId, orderIds),
      eq(couponReservations.status, "ACTIVE"),
    ));
  return extractAffectedRows(result);
}

type CouponConsumptionInput = {
  invoiceId: number;
  customerId: number | null;
  branchId: number;
  discountAmount: string;
  userId: number;
};

async function recordCouponConsumption(
  tx: Tx,
  coupon: LockedCoupon,
  input: CouponConsumptionInput,
  options: { allowRedeemedOwnedReservation: boolean },
): Promise<void> {
  if (money(input.discountAmount).lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون لا ينطبق على أصناف الفاتورة" });
  await tx.insert(couponRedemptions).values({
    couponId: coupon.couponId,
    programId: coupon.programId,
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    branchId: input.branchId,
    discountAmount: toDbMoney(input.discountAmount),
    redeemedBy: input.userId,
  });
  const incremented = await tx.update(coupons).set({
    redemptionCount: sql`${coupons.redemptionCount} + 1`,
    status: sql`CASE WHEN ${coupons.redemptionCount} + 1 >= ${coupon.perCouponLimit} THEN 'REDEEMED' ELSE 'ACTIVE' END`,
  }).where(and(
    eq(coupons.id, coupon.couponId),
    options.allowRedeemedOwnedReservation
      ? inArray(coupons.status, ["ACTIVE", "REDEEMED"])
      : eq(coupons.status, "ACTIVE"),
  ));
  // كل couponRedemption يقابله increment واحد داخل المعاملة نفسها. مسار الحجز المملوك وحده
  // يسمح بصف REDEEMED (وعد legacy زائد الحد)؛ VOID وأي صف مفقود يفشلان وتُلفّ الإدخالة أعلاه.
  if (extractAffectedRows(incremented) !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة القسيمة أثناء الاستهلاك" });
  }
}

export async function consumeCoupon(
  tx: Tx,
  coupon: LockedCoupon,
  input: CouponConsumptionInput,
): Promise<void> {
  await recordCouponConsumption(tx, coupon, input, { allowRedeemedOwnedReservation: false });
}

/** الاستهلاك النهائي لحجز طلب عند SHIPPED: redemption + عدّاد + انتقال الحجز في معاملة واحدة. */
export async function consumeReservedCoupon(
  tx: Tx,
  coupon: LockedCoupon,
  input: {
    onlineOrderId: number;
    invoiceId: number;
    customerId: number;
    branchId: number;
    discountAmount: string;
    userId: number;
  },
): Promise<void> {
  const reservation = (await tx
    .select()
    .from(couponReservations)
    .where(and(
      eq(couponReservations.onlineOrderId, input.onlineOrderId),
      eq(couponReservations.status, "ACTIVE"),
    ))
    .for("update")
    .limit(1))[0];
  if (
    !reservation || Number(reservation.couponId) !== coupon.couponId ||
    Number(reservation.programId) !== coupon.programId ||
    Number(reservation.customerId) !== input.customerId ||
    (reservation.expiresAt != null && reservation.expiresAt.getTime() <= Date.now())
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "حجز القسيمة غير موجود أو انتهت صلاحيته" });
  }
  // لا يُفتح REDEEMED للاستهلاك العام: الوصول هنا مشروط بحجز ACTIVE مملوك ومقفول أعلاه.
  await recordCouponConsumption(tx, coupon, input, { allowRedeemedOwnedReservation: true });
  const transitioned = await tx
    .update(couponReservations)
    .set({ status: "REDEEMED", redeemedAt: sql`CURRENT_TIMESTAMP(3)`, expiresAt: null })
    .where(and(
      eq(couponReservations.id, Number(reservation.id)),
      eq(couponReservations.status, "ACTIVE"),
    ));
  if (extractAffectedRows(transitioned) !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّرت حالة حجز القسيمة أثناء الإرسال" });
  }
}

export interface CouponProgramPerformance {
  programId: number;
  issuedCoupons: number;
  activeCoupons: number;
  voidedCoupons: number;
  invoiceCount: number;
  redeemedDiscount: string;
  linkedNetSales: string;
  linkedGrossProfit: string;
  lastRedeemedAt: Date | null;
}

/** ملخص البرامج من الإصدارات والاستردادات الفعلية؛ الفواتير الملغاة/المصححة لا تُعدّ أداءً. */
export async function loadCouponProgramPerformance(
  tx: Tx,
  branchId: number | null,
): Promise<Map<number, CouponProgramPerformance>> {
  const couponCounts = await tx
    .select({
      programId: coupons.programId,
      issuedCoupons: sql<number>`COUNT(*)`,
      activeCoupons: sql<number>`SUM(CASE WHEN ${coupons.status} = 'ACTIVE' THEN 1 ELSE 0 END)`,
      voidedCoupons: sql<number>`SUM(CASE WHEN ${coupons.status} = 'VOID' THEN 1 ELSE 0 END)`,
    })
    .from(coupons)
    .innerJoin(couponPrograms, eq(couponPrograms.id, coupons.programId))
    .where(branchId == null ? undefined : or(isNull(couponPrograms.branchId), eq(couponPrograms.branchId, branchId)))
    .groupBy(coupons.programId);

  const redemptionRows = await tx
    .select({
      programId: couponRedemptions.programId,
      invoiceCount: sql<number>`COUNT(DISTINCT ${couponRedemptions.invoiceId})`,
      redeemedDiscount: sql<string>`COALESCE(SUM(${couponRedemptions.discountAmount}), 0)`,
      linkedNetSales: sql<string>`COALESCE(SUM(GREATEST(${invoices.total} - ${invoices.returnedTotal}, 0)), 0)`,
      // محافظ عمداً في المرتجع الجزئي: costTotal لا يُخفّض هنا، فلا نعرض ربحاً متفائلاً كاذباً.
      linkedGrossProfit: sql<string>`COALESCE(SUM(GREATEST(${invoices.total} - ${invoices.returnedTotal}, 0) - ${invoices.costTotal}), 0)`,
      lastRedeemedAt: sql<Date | null>`MAX(${couponRedemptions.redeemedAt})`,
    })
    .from(couponRedemptions)
    .innerJoin(invoices, eq(invoices.id, couponRedemptions.invoiceId))
    .where(
      and(
        branchId == null ? undefined : eq(couponRedemptions.branchId, branchId),
        notInArray(invoices.status, ["CANCELLED", "RETURNED", "SUPERSEDED"]),
      ),
    )
    .groupBy(couponRedemptions.programId);

  const result = new Map<number, CouponProgramPerformance>();
  for (const row of couponCounts) {
    const programId = Number(row.programId);
    result.set(programId, {
      programId,
      issuedCoupons: Number(row.issuedCoupons ?? 0),
      activeCoupons: Number(row.activeCoupons ?? 0),
      voidedCoupons: Number(row.voidedCoupons ?? 0),
      invoiceCount: 0,
      redeemedDiscount: "0.00",
      linkedNetSales: "0.00",
      linkedGrossProfit: "0.00",
      lastRedeemedAt: null,
    });
  }
  for (const row of redemptionRows) {
    const programId = Number(row.programId);
    const current = result.get(programId) ?? {
      programId,
      issuedCoupons: 0,
      activeCoupons: 0,
      voidedCoupons: 0,
      invoiceCount: 0,
      redeemedDiscount: "0.00",
      linkedNetSales: "0.00",
      linkedGrossProfit: "0.00",
      lastRedeemedAt: null,
    };
    result.set(programId, {
      ...current,
      invoiceCount: Number(row.invoiceCount ?? 0),
      redeemedDiscount: toDbMoney(row.redeemedDiscount),
      linkedNetSales: toDbMoney(row.linkedNetSales),
      linkedGrossProfit: toDbMoney(row.linkedGrossProfit),
      lastRedeemedAt: row.lastRedeemedAt == null ? null : new Date(row.lastRedeemedAt),
    });
  }
  return result;
}

export interface IssuedCouponDetail {
  assignedCustomerName: string | null;
  redeemedDiscount: string;
  lastInvoiceId: number | null;
  lastInvoiceNumber: string | null;
  lastInvoiceTotal: string | null;
  lastInvoiceStatus: string | null;
  lastRedeemedAt: Date | null;
}

/** تفاصيل صفحة إصدار واحدة بلا N+1: أسماء المخصص لهم + أحدث فاتورة + مجموع الاستردادات. */
export async function loadIssuedCouponDetails(
  tx: Tx,
  rows: Array<{ id: number; customerId: number | null }>,
): Promise<Map<number, IssuedCouponDetail>> {
  const couponIds = rows.map((row) => row.id);
  if (!couponIds.length) return new Map();
  const customerIds = Array.from(new Set(rows.flatMap((row) => row.customerId == null ? [] : [row.customerId])));
  const customerRows = customerIds.length
    ? await tx.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
    : [];
  const customerNames = new Map(customerRows.map((row) => [Number(row.id), row.name]));
  const redemptions = await tx
    .select({
      couponId: couponRedemptions.couponId,
      discountAmount: couponRedemptions.discountAmount,
      redeemedAt: couponRedemptions.redeemedAt,
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceTotal: invoices.total,
      invoiceStatus: invoices.status,
    })
    .from(couponRedemptions)
    .innerJoin(invoices, eq(invoices.id, couponRedemptions.invoiceId))
    .where(inArray(couponRedemptions.couponId, couponIds))
    .orderBy(desc(couponRedemptions.redeemedAt), desc(couponRedemptions.id));

  const result = new Map<number, IssuedCouponDetail>();
  for (const row of rows) {
    result.set(row.id, {
      assignedCustomerName: row.customerId == null ? null : customerNames.get(row.customerId) ?? null,
      redeemedDiscount: "0.00",
      lastInvoiceId: null,
      lastInvoiceNumber: null,
      lastInvoiceTotal: null,
      lastInvoiceStatus: null,
      lastRedeemedAt: null,
    });
  }
  for (const redemption of redemptions) {
    const couponId = Number(redemption.couponId);
    const current = result.get(couponId)!;
    const first = current.lastInvoiceId == null;
    result.set(couponId, {
      ...current,
      redeemedDiscount: toDbMoney(money(current.redeemedDiscount).plus(redemption.discountAmount)),
      lastInvoiceId: first ? Number(redemption.invoiceId) : current.lastInvoiceId,
      lastInvoiceNumber: first ? redemption.invoiceNumber : current.lastInvoiceNumber,
      lastInvoiceTotal: first ? String(redemption.invoiceTotal) : current.lastInvoiceTotal,
      lastInvoiceStatus: first ? redemption.invoiceStatus : current.lastInvoiceStatus,
      lastRedeemedAt: first ? new Date(redemption.redeemedAt) : current.lastRedeemedAt,
    });
  }
  return result;
}
