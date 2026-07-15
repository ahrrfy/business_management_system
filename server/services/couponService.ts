import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { couponPrograms, couponRedemptions, coupons, promotions } from "../../drizzle/schema";
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

/** يقفل الكوبون وبرنامجه داخل معاملة البيع؛ لذلك لا يمكن لطلبين استهلاك آخر استخدام معاً. */
export async function lockCouponForSale(
  tx: Tx,
  input: { code: string; branchId: number; customerId: number | null; todayYmd: string },
): Promise<LockedCoupon> {
  const normalized = normalizeCouponCode(input.code);
  if (!normalized) throw new TRPCError({ code: "BAD_REQUEST", message: "رمز الكوبون مطلوب" });

  const row = (await tx.select({
    coupon: coupons,
    program: couponPrograms,
    promotion: promotions,
  }).from(coupons)
    .innerJoin(couponPrograms, eq(coupons.programId, couponPrograms.id))
    .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
    .where(eq(coupons.codeHash, hashCouponCode(normalized)))
    .for("update")
    .limit(1))[0];

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
