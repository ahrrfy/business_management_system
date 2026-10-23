import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appErrorMessage } from "@shared/errors";
import {
  deliveryCashierProcedure,
  deliveryReadProcedure,
  ownerProcedure,
  router,
} from "../trpc";
import {
  approveDeliveryPaymentRefund,
  listDeliveryPaymentRefunds,
  requestReturnedInvoiceFeeRefund,
} from "../services/delivery/paymentRefunds";
function actor(
  ctx: { user: { id: number; role: string; branchId?: number | null } },
  requested: number,
) {
  const branchId = ctx.user.role === "admin" ? requested : ctx.user.branchId;
  if (branchId == null || branchId !== requested)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر الوصول لرد التوصيل",
        why: "الفرع المطلوب لا يطابق فرع الحساب",
        doThis: "اختر الفرع المسند لحسابك أو اطلب إسناد الفرع الصحيح",
      }),
    });
  return { userId: ctx.user.id, branchId, role: ctx.user.role };
}
const id = z.number().int().positive(),
  key = z.string().trim().min(1).max(80);
export const deliveryFeeRefundRouter = router({
  list: deliveryReadProcedure
    .input(z.object({ branchId: id }))
    .query(({ ctx, input }) =>
      listDeliveryPaymentRefunds(input, actor(ctx, input.branchId)),
    ),
  request: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        consignmentId: id,
        reason: z.string().trim().min(3).max(500),
        clientRequestId: key,
        refundShiftId: id.nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      requestReturnedInvoiceFeeRefund(input, actor(ctx, input.branchId)),
    ),
  approve: ownerProcedure
    .input(
      z.object({
        branchId: id,
        receiptId: id,
        providerReference: z.string().trim().min(3).max(100),
        clientRequestId: key,
      }),
    )
    .mutation(({ ctx, input }) =>
      approveDeliveryPaymentRefund(input, actor(ctx, input.branchId)),
    ),
});
