import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appErrorMessage } from "@shared/errors";
import { managerApprovalSchema } from "@shared/managerApproval";
import { positiveMoneyString } from "../lib/schemas";
import { verifyManagerApproval } from "./saleRouter";
import {
  previewExcessFeeRefund,
  requestExcessFeeRefund,
} from "../services/delivery/excessFeeRefund";
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
  previewExcess: deliveryReadProcedure
    .input(
      z.object({
        branchId: id,
        documentNumber: z.string().trim().min(1).max(200),
      }),
    )
    .query(({ ctx, input }) =>
      previewExcessFeeRefund(input, actor(ctx, input.branchId)),
    ),
  requestExcess: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        sourceKind: z.enum(["INVOICE", "WORK_ORDER"]),
        sourceId: id,
        expectedReceiptId: id,
        expectedAmount: positiveMoneyString,
        reason: z.string().trim().min(3).max(500),
        clientRequestId: key,
        refundShiftId: id.nullish(),
        managerApproval: managerApprovalSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actual = actor(ctx, input.branchId),
        { managerApproval, ...request } = input;
      const approvedByManagerId = managerApproval
        ? await verifyManagerApproval(managerApproval, ctx, actual.branchId)
        : null;
      return requestExcessFeeRefund(
        { ...request, approvedByManagerId },
        actual,
      );
    }),
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
