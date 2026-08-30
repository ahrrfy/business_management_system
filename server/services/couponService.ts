import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  couponPrograms,
  couponRedemptions,
  coupons,
  customers,
  invoices,
  promotions,
} from "../../drizzle/schema";
import type { Tx } from "../db";
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

/**
 * يقفل الكوبون وبرنامجه داخل معاملة البيع؛ لذلك لا يمكن لطلبين استهلاك آخر استخدام معاً.
 *
 * `options.lock = false` (فحص الحمل ٣١/٨/٢٦) للمسار **القارئ فقط** (تسعيرة المتجر المجهولة):
 * كل الفحوص أدناه تبقى كما هي، لكن بلا `FOR UPDATE`. القفل الحصريّ في مسار قراءةٍ كان يُسلسل
 * كلّ زائرٍ يكتب الرمز نفسه خلف الآخر على صفٍّ واحد بلا أيّ استهلاكٍ يحميه — والحماية الحقيقية
 * من الاستهلاك المزدوج تقع في مسار الإنشاء وحده (حيث يبقى القفل افتراضياً).
 */
export async function lockCouponForSale(
  tx: Tx,
  input: { code: string; branchId: number; customerId: number | null; todayYmd: string },
  options: { lock?: boolean } = {},
): Promise<LockedCoupon> {
  const normalized = normalizeCouponCode(input.code);
  if (!normalized) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز الكوبون مطلوب" });

  const couponQuery = tx.select({
    coupon: coupons,
    program: couponPrograms,
    promotion: promotions,
  }).from(coupons)
    .innerJoin(couponPrograms, eq(coupons.programId, couponPrograms.id))
    .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
    .where(eq(coupons.codeHash, hashCouponCode(normalized)))
    .limit(1);
  const row = (options.lock === false ? await couponQuery : await couponQuery.for("update"))[0];

  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "رمز الكوبون غير صحيح" });
  if (row.coupon.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون مستخدم أو ملغى" });
  if (row.program.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: "برنامج الكوبون غير نشط" });
  if (!row.promotion.isActive || row.promotion.applicationMode !== "COUPON") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "العرض المرتبط بالكوبون غير نشط" });
  }
  if (row.program.branchId != null && Number(row.program.branchId) !== input.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الكوبون لا يخص هذا الفرع" });
  }
  if (row.promotion.branchId != null && Number(row.promotion.branchId) !== input.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "العرض لا يخص هذا الفرع" });
  }
  const from = dateYmd(row.program.validFrom)!;
  const to = dateYmd(row.program.validTo);
  if (input.todayYmd < from || (to != null && input.todayYmd > to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون خارج مدة الصلاحية" });
  }
  const assignedCustomerId = row.coupon.customerId == null ? null : Number(row.coupon.customerId);
  if (assignedCustomerId != null && assignedCustomerId !== input.customerId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الكوبون مخصص لعميل آخر" });
  }
  if (Number(row.coupon.redemptionCount) >= Number(row.program.perCouponLimit)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "استُنفدت مرات استخدام الكوبون" });
  }
  if (input.customerId != null) {
    const used = (await tx.select({ count: sql<number>`count(*)` }).from(couponRedemptions).where(and(
      eq(couponRedemptions.programId, row.program.id),
      eq(couponRedemptions.customerId, input.customerId),
    )))[0];
    if (Number(used?.count ?? 0) >= Number(row.program.perCustomerLimit)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "بلغ العميل الحد المسموح لهذا البرنامج" });
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

export async function consumeCoupon(
  tx: Tx,
  coupon: LockedCoupon,
  input: { invoiceId: number; customerId: number | null; branchId: number; discountAmount: string; userId: number },
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
  await tx.update(coupons).set({
    redemptionCount: sql`${coupons.redemptionCount} + 1`,
    status: sql`CASE WHEN ${coupons.redemptionCount} + 1 >= ${coupon.perCouponLimit} THEN 'REDEEMED' ELSE 'ACTIVE' END`,
  }).where(and(eq(coupons.id, coupon.couponId), eq(coupons.status, "ACTIVE")));
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
