// اِستقبال (تكامل التوصيل، ٤/٨): تصنيف/إعادة تصنيف طريقة التسليم (استلام مباشر ⇄ توصيل) — قبل
// التسليم/الإرسال فقط. يغطي السيناريو (ج): زبون قال «آتي أستلم» ثم غيّر رأيه (أو العكس).
//
// لا يُعدَّل salePrice هنا أبداً — الفرق السعري عند إعادة التصنيف مسؤولية الموظّف (قرار المالك:
// تنبيهٌ واجهيٌّ غير حاجز فقط، لا تعديل تلقائي لمبلغ التزم به العميل مسبقاً).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { workOrders } from "../../../drizzle/schema";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import { refundUnspentWorkOrderFeeHeld } from "./deliveryFeeRefund";

export interface UpdateWorkOrderDeliveryMethodInput {
  workOrderId: number;
  hasDelivery: boolean;
  deliveryAddress?: string | null;
  deliveryPhone?: string | null;
  deliveryCost?: string | null;
  /** درج ردّ أمانة الأجرة عند الانتقال لاستلام مباشر (يُلزَم فقط حين يتعدّد الدرج المفتوح). */
  refundShiftId?: number | null;
}

export async function updateWorkOrderDeliveryMethod(
  input: UpdateWorkOrderDeliveryMethodInput,
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    // بعد التسليم/الإرسال: workOrders.status ينتقل ذرّياً إلى DELIVERED ضمن نفس معاملة
    // deliverWorkOrder/dispatchToDelivery — فحص الحالة هنا كافٍ وحيد لمنع تعديل أمرٍ خرج من الطابور.
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: wo.status === "DELIVERED" ? "الأمر مُسلَّم/مُرسَل بالفعل — لا يمكن تعديل طريقة التسليم" : "لا يمكن تعديل أمرٍ ملغى",
      });
    }
    if (input.hasDelivery && !input.deliveryAddress?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان التوصيل مطلوب عند تفعيل التوصيل" });
    }

    // مراجعة عدائية (٤/٨): deliveryCost كان يُصفَّر دائماً حين لا يُمرَّره المستدعي — غير ضارّ حالياً
    // (المستدعي الوحيد Reclassify Dialog يرسله دائماً صراحةً) لكنه فخّ بيانات لأيّ مستدعٍ مستقبلي
    // يتوقّع دلالة «لم يُذكَر = يبقى كما هو». undefined ⇒ يبقى المخزَّن؛ أيّ قيمة صريحة (حتى null) ⇒ تُطبَّق.
    const deliveryCost =
      input.deliveryCost !== undefined
        ? input.deliveryCost
          ? round2(money(input.deliveryCost)).toFixed(2)
          : "0.00"
        : wo.deliveryCost;

    // مراجعة عدائية نهائية (١٠/٨): الانتقال إلى **استلام مباشر** يردّ أمانة أجرة التوصيل
    // المقبوضة (COUNTER) غير المصروفة — وإلّا علِقت في الدرج للأبد (deliverWorkOrder التالي لا
    // يمسّها). idempotent (dedupeKey) فلا تُردّ مرّتين، ونِتُّها صفر إن لم تكن هناك أمانة.
    let refundedFee = "0.00";
    if (!input.hasDelivery) {
      refundedFee = await refundUnspentWorkOrderFeeHeld(tx, {
        workOrderId: Number(wo.id),
        branchId: Number(wo.branchId),
        refundShiftId: input.refundShiftId ?? null,
        actor,
        reason: "ردّ أمانة أجرة توصيل (تحوّل لاستلام مباشر)",
      });
    }

    await tx
      .update(workOrders)
      .set({
        hasDelivery: !!input.hasDelivery,
        deliveryAddress: input.deliveryAddress?.trim() || null,
        deliveryPhone: input.deliveryPhone?.trim() || null,
        deliveryCost,
      })
      .where(eq(workOrders.id, Number(wo.id)));

    return { workOrderId: Number(wo.id), hasDelivery: !!input.hasDelivery, refundedFee };
  });
}
