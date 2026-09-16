/**
 * منفّذو الأرصدة الجارية — عميل · مورّد/مودِع · جهة توصيل.
 *
 * التعويضُ ميكانيكيّ: الرصيدُ عدّادٌ جارٍ (`currentBalance`) يُزاد ذرّياً عبر
 * `ledgerService.adjust*Balance`، فعكسُ أثرٍ = زيادةٌ بمعكوس المتبقّي. هويّةُ الطرف تأتي من
 * `effectRowId` (صفُّ الطرف نفسه) ويُثبّتها `effectTable` — أثرٌ بلا طرفٍ مسمّى خللٌ في
 * التجسيد لا يُصلَح بتخمين.
 *
 * ⭐ **الردُّ المؤجَّل ليس هنا**: حين لا يخرج المالُ بعد (سندٌ ينتظر اعتماداً) يُبقيه منفّذُ
 * `PAID_AMOUNT` رصيداً دائناً للعميل ويسجّله أثراً مفتوحاً مستقلاً (`scope = "refund-pending"`).
 * لو وُضع هنا لَسقط كلّما كانت مساهمةُ الفاتورة في الذمّة صفراً (فاتورةٌ مسدَّدة) — فلا يصل
 * هذا المنفّذُ أصلاً لأنّ أثره غيرُ متبقٍّ.
 */
import { TRPCError } from "@trpc/server";

import { appErrorMessage } from "@shared/errors";

import type { Tx } from "../../../db";
import {
  adjustCustomerBalance,
  adjustDeliveryBalance,
  adjustSupplierBalance,
} from "../../ledgerService";
import type { EffectExecutor, PendingEffect } from "../types";

function partyIdOf(effect: PendingEffect, table: string, label: string): number {
  if (effect.effectTable !== table || effect.effectRowId == null || effect.effectRowId <= 0) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: `تعذّر عكس أثر ${label}`,
        why: `الأثر رقم ${effect.id} لا يحمل هويّة الطرف (الجدول «${effect.effectTable ?? "—"}» والصفّ «${effect.effectRowId ?? "—"}») فلا يُعرف رصيدُ مَن يُعدَّل`,
        doThis: "أوقف العمليّة وأبلغ مسؤول النظام برقم الأثر — يلزم تصحيحُ سجلّ الأثر قبل العكس",
      }),
    });
  }
  return Number(effect.effectRowId);
}

/** رصيدُ العميل (AR): موجب = العميل مدين. الأثرُ المتبقّي هو مساهمةُ المستند الحاليّة في الذمّة، وعكسُه إسقاطُها. */
export const customerBalanceExecutor: EffectExecutor = async (tx, effects) => {
  const outcomes = [];
  for (const effect of effects) {
    const customerId = partyIdOf(effect, "customers", "رصيد العميل");
    await adjustCustomerBalance(tx, customerId, effect.outstandingAmount.negated());
    outcomes.push({ status: "REVERSED" as const, effectTable: "customers", effectRowId: customerId });
  }
  return outcomes;
};

/** رصيدُ المورّد/المودِع (AP): موجب = نحن مدينون له. */
export const supplierBalanceExecutor: EffectExecutor = async (tx, effects) => {
  const outcomes = [];
  for (const effect of effects) {
    const supplierId = partyIdOf(effect, "suppliers", "رصيد المورّد");
    await adjustSupplierBalance(tx, supplierId, effect.outstandingAmount.negated());
    outcomes.push({ status: "REVERSED" as const, effectTable: "suppliers", effectRowId: supplierId });
  }
  return outcomes;
};

/** عهدةُ جهة التوصيل: موجب = الجهة مدينة للمتجر. */
export const deliveryCustodyExecutor: EffectExecutor = async (tx: Tx, effects) => {
  const outcomes = [];
  for (const effect of effects) {
    const partyId = partyIdOf(effect, "deliveryParties", "عهدة جهة التوصيل");
    await adjustDeliveryBalance(tx, partyId, effect.outstandingAmount.negated());
    outcomes.push({ status: "REVERSED" as const, effectTable: "deliveryParties", effectRowId: partyId });
  }
  return outcomes;
};
