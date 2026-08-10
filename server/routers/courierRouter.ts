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
import { confirmConsignmentDelivery, confirmCourierDelivery, failCourierDelivery, listMyDeliveries } from "../services/deliveryService";
import { isDupEntry } from "@shared/errorMap.ar";

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
   * تأكيد تسليم إرسالية استقبال — ختمٌ تشغيليّ بحت (courierDeliveredAt) لا يمسّ المال.
   * التسوية تبقى بيد الموظّف عبر توريد المندوب (delivery.recordRemittance) دون تغيير.
   */
  confirmConsignmentDelivery: courierProcedure
    .input(z.object({ consignmentId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await confirmConsignmentDelivery({ consignmentId: input.consignmentId }, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "courier.confirmConsignmentDelivery",
        entityType: "deliveryConsignment",
        entityId: input.consignmentId,
        newValue: { deliveredAt: res.deliveredAt, alreadyDelivered: res.alreadyDelivered ?? false },
      });
      return res;
    }),

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
