/**
 * storeAdminRouter — الجهة الإدارية للمتجر الإلكتروني (متجر `/store` العلني منفصل).
 * الحالي: orders (تثبيت الطلبات + طباعة الملصق). لاحقاً: banners + settings (لوحة hPanel).
 *
 * الأدوار: قراءة الطلبات = storeReadProcedure (مقيّد فرعاً)؛ تغيير الحالة = storeFulfillProcedure
 * (مدير/كاشير/مندوب مبيعات). عزل الفرع في setStatus مشتقٌّ من دور الفاعل (مرتفع ⇒ بلا قيد).
 */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { router, storeFulfillProcedure, storeReadProcedure } from "../trpc";
import {
  getOnlineOrder,
  listOnlineOrders,
  onlineOrderStatusCounts,
  setOnlineOrderStatus,
} from "../services/storeAdmin/orderFulfillmentService";

const statusEnum = z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]);

/** الفرع المُسنَد للفاعل (مرتفع admin/manager ⇒ null بلا قيد؛ غيره ⇒ فرعه). */
function actorScopedBranch(user: { role: string; branchId: number | null }): number | null {
  const elevated = user.role === "admin" || user.role === "manager";
  return elevated ? null : (user.branchId != null ? Number(user.branchId) : null);
}

const ordersRouter = router({
  /** قائمة طلبات المتجر (اختياري: فلترة حالة). */
  list: storeReadProcedure
    .input(z.object({ status: statusEnum.nullish(), limit: z.number().int().min(1).max(300).default(100) }))
    .query(({ input, ctx }) =>
      listOnlineOrders({ scopedBranchId: ctx.scopedBranchId, status: input.status ?? null, limit: input.limit })
    ),

  /** عدّاد لكل حالة (بطاقات الإحصاء). */
  counts: storeReadProcedure.query(({ ctx }) => onlineOrderStatusCounts(ctx.scopedBranchId)),

  /** تفاصيل طلب (للملصق/العرض). */
  detail: storeReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => getOnlineOrder(input.id, ctx.scopedBranchId)),

  /** تثبيت/نقل حالة الطلب (بحارس انتقال + تدقيق). */
  setStatus: storeFulfillProcedure
    .input(z.object({ id: z.number().int().positive(), status: statusEnum }))
    .mutation(async ({ input, ctx }) => {
      const scopedBranchId = actorScopedBranch(ctx.user);
      const res = await setOnlineOrderStatus({ id: input.id, status: input.status, scopedBranchId }, ctx.user.id);
      await logAudit(ctx, {
        action: "store.order.setStatus",
        entityType: "onlineOrder",
        entityId: input.id,
        oldValue: { status: res.from },
        newValue: { status: res.to },
      });
      return res;
    }),
});

export const storeAdminRouter = router({
  orders: ordersRouter,
});
