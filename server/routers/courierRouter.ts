/**
 * courierRouter — شاشة المندوب الذاتية «توصيلاتي» (courier فقط، admin يعبُر البوّابة).
 *
 * عزل ذاتي صارم: كل نقطة تحلّ partyId من ctx.user (deliveryParties.userId) داخل الخدمة —
 * لا يمرّر العميل partyId، فلا يرى/يؤكّد مندوبٌ إلا طلباته. لا أثر مالي في القراءة؛ التأكيد
 * يُسدّد الفاتورة (ذمّة العميل↓) ويرفع عهدة المندوب (delivery.settle يُورّدها للمتجر لاحقاً).
 */
import { z } from "zod";
import { courierProcedure, router } from "../trpc";
import { logAudit } from "../services/auditService";
import { confirmConsignmentDelivery, confirmCourierDelivery, failCourierDelivery, listMyDeliveries, transitionConsignmentParcel } from "../services/deliveryService";
import { isDupEntry } from "@shared/errorMap.ar";
import { retryOnDeadlock } from "../lib/retryDeadlock";

export const courierRouter = router({
  /** توصيلاتي: قيد التوصيل + المُسلّمة حديثاً + عهدتي (غير مرتبط ⇒ linked:false). */
  myDeliveries: courierProcedure.query(({ ctx }) => listMyDeliveries(ctx.user.id)),

  /** تأكيد تسليم + تحصيل COD كاملاً لطلبٍ من توصيلاتي. */
  confirmDelivery: courierProcedure
    .input(z.object({ onlineOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id };
      let res;
      try {
        res = await confirmCourierDelivery({ onlineOrderId: input.onlineOrderId }, actor);
      } catch (e) {
        // سباق قيد مزدوج نادر (dedupeKey) ⇒ إعادة محاولة واحدة (الثانية ترى DELIVERED فتُرجِع idempotent).
        if (isDupEntry(e)) res = await confirmCourierDelivery({ onlineOrderId: input.onlineOrderId }, actor);
        else throw e;
      }
      await logAudit(ctx, {
        action: "courier.confirmDelivery",
        entityType: "onlineOrder",
        entityId: input.onlineOrderId,
        newValue: { collected: res.collected, custodyAfter: res.custodyAfter },
      });
      return res;
    }),

  /**
   * تأكيد التسليم الفعلي والتحصيل: يغلق ذمّة العميل وينقل COD إلى عهدة الجهة.
   * إدخال النقد في الدرج يبقى بيد الموظف عبر delivery.recordRemittance.
   */
  confirmConsignmentDelivery: courierProcedure
    .input(z.object({ consignmentId: z.number().int().positive(), clientRequestId: z.string().trim().min(8).max(100) }))
    .mutation(async ({ input, ctx }) => {
      const res = await retryOnDeadlock(() => confirmConsignmentDelivery(input, { userId: ctx.user.id }));
      await logAudit(ctx, {
        action: "courier.confirmConsignmentDelivery",
        entityType: "deliveryConsignment",
        entityId: input.consignmentId,
        newValue: { deliveredAt: res.deliveredAt, alreadyDelivered: res.alreadyDelivered ?? false },
      });
      return res;
    }),

  parcelTransition: courierProcedure
    .input(z.object({
      consignmentId: z.number().int().positive(),
      toStatus: z.enum(["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY", "FAILED"]),
      reason: z.string().trim().min(2).max(500).nullish(),
      clientRequestId: z.string().trim().min(8).max(100),
    }))
    .mutation(({ input, ctx }) => retryOnDeadlock(() => transitionConsignmentParcel(input, { userId: ctx.user.id }))),

  /** تعذّر التسليم (رفض الزبون): عكس بيع الطلب المرفوض + إلغاؤه (بلا تحصيل). */
  failDelivery: courierProcedure
    .input(z.object({ onlineOrderId: z.number().int().positive(), reason: z.string().trim().min(2).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id };
      let res;
      try {
        res = await failCourierDelivery({ onlineOrderId: input.onlineOrderId, reason: input.reason }, actor);
      } catch (e) {
        if (isDupEntry(e)) res = await failCourierDelivery({ onlineOrderId: input.onlineOrderId, reason: input.reason }, actor);
        else throw e;
      }
      await logAudit(ctx, {
        action: "courier.failDelivery",
        entityType: "onlineOrder",
        entityId: input.onlineOrderId,
        newValue: { reason: input.reason, reversed: res.reversed },
      });
      return res;
    }),
});
