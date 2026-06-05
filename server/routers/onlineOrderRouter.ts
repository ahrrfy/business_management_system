import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  createOnlineOrder,
  getOnlineOrders,
  getOnlineOrderById,
  updateOrderStatus,
  cancelOrder,
  getOrdersByStatus,
  getOrdersByCustomer,
} from "../services/onlineOrderService";

export const onlineOrderRouter = router({
  /**
   * إنشاء طلب إلكتروني جديد
   */
  create: protectedProcedure
    .input(
      z.object({
        customerId: z.number(),
        items: z.array(
          z.object({
            productId: z.number(),
            quantity: z.number().min(1),
          })
        ),
        shippingAddress: z.string(),
        shippingCost: z.number().default(0),
        taxAmount: z.number().default(0),
      })
    )
    .mutation(async ({ input }) => {
      return await createOnlineOrder(input);
    }),

  /**
   * جلب قائمة الطلبات الإلكترونية
   */
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().default(50),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input }) => {
      return await getOnlineOrders(input.limit, input.offset);
    }),

  /**
   * جلب تفاصيل طلب معين
   */
  getById: protectedProcedure
    .input(z.number())
    .query(async ({ input }) => {
      return await getOnlineOrderById(input);
    }),

  /**
   * تحديث حالة الطلب
   */
  updateStatus: protectedProcedure
    .input(
      z.object({
        orderId: z.number(),
        status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]),
        trackingNumber: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return await updateOrderStatus(input);
    }),

  /**
   * إلغاء طلب
   */
  cancel: protectedProcedure
    .input(z.number())
    .mutation(async ({ input }) => {
      return await cancelOrder(input);
    }),

  /**
   * جلب الطلبات حسب الحالة
   */
  getByStatus: protectedProcedure
    .input(
      z.object({
        status: z.string(),
        limit: z.number().default(50),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input }) => {
      return await getOrdersByStatus(input.status, input.limit, input.offset);
    }),

  /**
   * جلب الطلبات حسب العميل
   */
  getByCustomer: protectedProcedure
    .input(
      z.object({
        customerId: z.number(),
        limit: z.number().default(50),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input }) => {
      return await getOrdersByCustomer(input.customerId, input.limit, input.offset);
    }),
});
