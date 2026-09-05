/**
 * منفّذ الكوبون — **يُحرَّر عند الإلغاء** (D8 في خطة v2: كان «لا يُحرَّر أبداً»).
 *
 * أثرُ الاستهلاك (`couponService.recordCouponConsumption`) ثلاثةُ كتاباتٍ ذرّية: صفُّ
 * `couponRedemptions` · `coupons.redemptionCount + 1` · وقلبُ الحالة إلى `REDEEMED` عند بلوغ
 * الحدّ. التحريرُ يعكسها الثلاثة تحت قفل صفّ الكوبون:
 *  · العدّادُ يُنقَص (ولا يهبط تحت الصفر)،
 *  · الحالةُ تعود `ACTIVE` إن كانت `REDEEMED` — و`VOID` **لا تُمسّ**: إبطالٌ إداريّ صريح يعلو
 *    على الإلغاء،
 *  · صفُّ الاسترداد **يُحذَف** لأنّ حدَّ العميل في البرنامج يُعدّ بصفوفه (`lockCouponForSale`
 *    يعدّ `couponRedemptions` للعميل) — بقاؤه كان يحرم العميل من كوبونٍ أُلغيت فاتورتُه.
 *    وحمولةُ الصفّ تُحفَظ كاملةً في صفّ REVERSE (`payloadJson`) فلا يضيع التاريخ.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";

import { appErrorMessage } from "@shared/errors";

import { couponRedemptions, coupons } from "../../../../drizzle/schema";
import type { EffectExecutor, ExecutionOutcome } from "../types";

export const couponExecutor: EffectExecutor = async (tx, effects) => {
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    if (effect.effectTable !== "couponRedemptions" || effect.effectRowId == null) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر تحرير الكوبون",
          why: `أثر الكوبون رقم ${effect.id} لا يشير إلى صفّ استردادٍ (الجدول «${effect.effectTable ?? "—"}»)`,
          doThis: "أوقف العمليّة وأبلغ مسؤول النظام برقم الأثر",
        }),
      });
    }
    const redemption = (
      await tx
        .select()
        .from(couponRedemptions)
        .where(eq(couponRedemptions.id, Number(effect.effectRowId)))
        .for("update")
        .limit(1)
    )[0];
    if (!redemption) {
      // حُرّر سلفاً بمسارٍ آخر — لا شيء يُعاد؛ الأثرُ يُغلق بمرجعه الأصليّ.
      outcomes.push({ status: "REVERSED", effectTable: "couponRedemptions", effectRowId: Number(effect.effectRowId), payloadJson: { alreadyReleased: true } });
      continue;
    }
    const coupon = (
      await tx.select().from(coupons).where(eq(coupons.id, Number(redemption.couponId))).for("update").limit(1)
    )[0];
    if (coupon) {
      await tx
        .update(coupons)
        .set({
          redemptionCount: sql`GREATEST(${coupons.redemptionCount} - 1, 0)`,
          // VOID يبقى VOID — إبطالٌ إداريّ لا يُلغيه إلغاءُ فاتورة.
          status: sql`CASE WHEN ${coupons.status} = 'REDEEMED' THEN 'ACTIVE' ELSE ${coupons.status} END`,
        })
        .where(and(eq(coupons.id, Number(coupon.id))));
    }
    await tx.delete(couponRedemptions).where(eq(couponRedemptions.id, Number(redemption.id)));
    outcomes.push({
      status: "REVERSED",
      effectTable: "couponRedemptions",
      effectRowId: Number(redemption.id),
      payloadJson: {
        released: true,
        couponId: Number(redemption.couponId),
        programId: Number(redemption.programId),
        invoiceId: Number(redemption.invoiceId),
        customerId: redemption.customerId == null ? null : Number(redemption.customerId),
        discountAmount: String(redemption.discountAmount),
        redeemedBy: Number(redemption.redeemedBy),
        redeemedAt: redemption.redeemedAt?.toISOString?.() ?? null,
        couponStatusBefore: coupon?.status ?? null,
      },
    });
  }
  return outcomes;
};
