import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  couponPrograms,
  coupons,
  onlineOrders,
  storefrontFirstOrderCouponClaims,
} from "../../drizzle/schema";
import { appErrorMessage } from "../../shared/errors";
import { extractInsertId } from "../lib/insertId";
import { hashCouponCode } from "./couponService";
import { requireStorefrontContext } from "./storefrontContextService";
import { withTx } from "./tx";

export type StorefrontFirstOrderCouponResult = {
  outcome: "ISSUED" | "ALREADY_ISSUED";
  code: string;
  programName: string;
  validTo: Date | null;
};

function makeCustomerCouponCode(prefix: string): string {
  const safePrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "FIRST";
  const token = randomBytes(5).toString("hex").toUpperCase();
  return `${safePrefix}-${token.slice(0, 5)}-${token.slice(5)}`;
}

/**
 * طلبٌ صريح من العميل الموثّق، لا مكافأة صامتة: يصدر رمزاً شخصياً واحداً فقط
 * قبل أول طلب متجر. قيد claims والصف المقفول يحسمان الضغط المتزامن بلا كوبونات يتيمة.
 */
export async function requestStorefrontFirstOrderCoupon(
  customerId: number,
): Promise<StorefrontFirstOrderCouponResult> {
  return withTx(async (tx) => {
    const storefront = await requireStorefrontContext(tx, {
      requireOpen: false,
      lock: true,
      branchLock: "share",
    });
    const programs = await tx
      .select({
        id: couponPrograms.id,
        name: couponPrograms.name,
        codePrefix: couponPrograms.codePrefix,
        validTo: couponPrograms.validTo,
        perCouponLimit: couponPrograms.perCouponLimit,
        perCustomerLimit: couponPrograms.perCustomerLimit,
      })
      .from(couponPrograms)
      .where(and(
        eq(couponPrograms.isFirstOrderSelfService, true),
        eq(couponPrograms.status, "ACTIVE"),
        or(isNull(couponPrograms.branchId), eq(couponPrograms.branchId, storefront.branchId)),
        sql`${couponPrograms.validFrom} <= CURRENT_DATE()`,
        or(isNull(couponPrograms.validTo), sql`${couponPrograms.validTo} >= CURRENT_DATE()`),
      ))
      .orderBy(couponPrograms.id)
      .limit(2)
      .for("update");
    if (!programs.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن إصدار كوبون الطلب الأول الآن",
          why: "لا يوجد برنامج فعّال ومتاح لهذا الفرع حالياً",
          doThis: "راجع العروض لاحقاً أو تواصل مع المتجر",
        }),
      });
    }
    if (programs.length > 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لا يمكن إصدار كوبون الطلب الأول الآن",
          why: "يوجد أكثر من برنامج فعّال لهذا الغرض",
          doThis: "تواصل مع المتجر ليصحح إعداد البرامج ثم أعد الطلب",
        }),
      });
    }
    const program = programs[0]!;
    if (program.perCouponLimit !== 1 || program.perCustomerLimit !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لا يمكن إصدار كوبون الطلب الأول الآن",
          why: "إعداد البرنامج لا يفرض استخداماً واحداً للكوبون والعميل",
          doThis: "تواصل مع المتجر ليصحح إعداد البرنامج ثم أعد الطلب",
        }),
      });
    }

    const previousOrder = (await tx
      .select({ id: onlineOrders.id })
      .from(onlineOrders)
      .where(eq(onlineOrders.customerId, customerId))
      .limit(1)
      .for("update"))[0];
    if (previousOrder) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن إصدار كوبون الطلب الأول",
          why: "يوجد طلب متجر سابق مرتبط بحسابك",
          doThis: "استخدم القسائم والعروض المتاحة الأخرى في صفحة الولاء",
        }),
      });
    }

    // onDuplicateKeyUpdate ينتظر claim المتزامن ثم يعيد صفه المقفول؛ لا يغيّر أي قيمة.
    await tx.insert(storefrontFirstOrderCouponClaims).values({
      programId: Number(program.id),
      customerId,
    }).onDuplicateKeyUpdate({
      set: { customerId: sql`${storefrontFirstOrderCouponClaims.customerId}` },
    });
    const claim = (await tx
      .select({ id: storefrontFirstOrderCouponClaims.id, couponId: storefrontFirstOrderCouponClaims.couponId })
      .from(storefrontFirstOrderCouponClaims)
      .where(and(
        eq(storefrontFirstOrderCouponClaims.programId, Number(program.id)),
        eq(storefrontFirstOrderCouponClaims.customerId, customerId),
      ))
      .for("update")
      .limit(1))[0];
    if (!claim) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: appErrorMessage({ what: "تعذر تثبيت طلب الكوبون", why: "لم تحفظ قاعدة البيانات سجل الحماية المتوقع", doThis: "أعد المحاولة، وإن استمر الأمر تواصل مع المتجر" }) });

    const existing = (await tx
      .select({ id: coupons.id, code: coupons.code })
      .from(coupons)
      .where(and(
        eq(coupons.programId, Number(program.id)),
        eq(coupons.customerId, customerId),
      ))
      .orderBy(coupons.id)
      .limit(1)
      .for("update"))[0];
    if (existing) {
      if (claim.couponId == null) {
        await tx.update(storefrontFirstOrderCouponClaims)
          .set({ couponId: Number(existing.id) })
          .where(eq(storefrontFirstOrderCouponClaims.id, Number(claim.id)));
      }
      return {
        outcome: "ALREADY_ISSUED",
        code: existing.code,
        programName: program.name,
        validTo: program.validTo ?? null,
      };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = makeCustomerCouponCode(program.codePrefix);
      try {
        const couponId = extractInsertId(await tx.insert(coupons).values({
          programId: Number(program.id),
          customerId,
          code,
          codeHash: hashCouponCode(code),
          status: "ACTIVE",
        }));
        await tx.update(storefrontFirstOrderCouponClaims)
          .set({ couponId })
          .where(eq(storefrontFirstOrderCouponClaims.id, Number(claim.id)));
        return {
          outcome: "ISSUED",
          code,
          programName: program.name,
          validTo: program.validTo ?? null,
        };
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: appErrorMessage({ what: "تعذر إصدار رمز كوبون فريد", why: "تكرر تعارض نادر في توليد الرمز", doThis: "أعد المحاولة، وإن استمر الأمر تواصل مع المتجر" }) });
  });
}
