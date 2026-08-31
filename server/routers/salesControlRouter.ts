import { z } from "zod";
import { SALES_CONTROL_STATUSES } from "@shared/salesControl";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import {
  approveSalesControlRequest,
  listSalesControlRequests,
  rejectSalesControlRequest,
  requestSalesControl,
} from "../services/sale/controlRequests";
import { router, salesCashierProcedure, salesManagerProcedure, salesReadProcedure } from "../trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

const paymentMethod = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)").nullable();
const requestIdentity = z.object({
  requestKey: z.string().trim().min(1).max(120),
  invoiceId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
});
const correctionLine = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/).refine((value) => Number(value) > 0 && Number(value) <= 1_000_000),
  unitPriceOverride: nonNegMoneyString.optional(),
  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  discountAmount: nonNegMoneyString.optional(),
  promotionId: z.number().int().positive().optional(),
  isGift: z.boolean().optional(),
});
const correctionPayload = z.object({
  customerId: z.number().int().positive().nullish(),
  contactName: z.string().trim().max(255).nullish(),
  contactPhone: z.string().trim().max(32).nullish(),
  priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).nullish(),
  lines: z.array(correctionLine).min(1),
  invoiceDiscount: nonNegMoneyString.nullish(),
  deliveryFee: nonNegMoneyString.nullish(),
  taxRatePercent: z.string().regex(/^\d+(\.\d{1,2})?$/).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(5000).nullish(),
  additionalPayment: z.object({
    amount: positiveMoneyString,
    method: paymentMethod,
    reference: z.string().trim().min(1).max(100).nullish(),
    externalPaymentAttemptId: z.number().int().positive().nullish(),
    externalPaymentDeviceId: z.string().trim().min(1).max(64).nullish(),
  }).nullish(),
  overpayHandling: z.enum(["CREDIT", "CASH_REFUND"]).optional(),
  overpayRefundShiftId: z.number().int().positive().nullish(),
}).superRefine((input, refinement) => {
  const payment = input.additionalPayment;
  if (!payment) return;
  if (payment.method !== "CASH" && !payment.externalPaymentAttemptId) {
    refinement.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["additionalPayment", "externalPaymentAttemptId"],
      message: "أكّد محاولة الدفع الخارجي قبل إرسال الطلب",
    });
  }
  if (payment.method !== "CASH" && !payment.externalPaymentDeviceId) {
    refinement.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["additionalPayment", "externalPaymentDeviceId"],
      message: "جهاز محاولة الدفع مطلوب",
    });
  }
  if (payment.method === "CASH" && (payment.externalPaymentAttemptId || payment.externalPaymentDeviceId)) {
    refinement.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["additionalPayment", "externalPaymentAttemptId"],
      message: "الدفع النقدي لا يحمل محاولة خارجية",
    });
  }
});

function actor(ctx: { user: { id: number; branchId?: number | null; role: string } }) {
  return {
    userId: ctx.user.id,
    branchId: Number(ctx.user.branchId ?? 0),
    role: ctx.user.role,
  };
}

export const salesControlRouter = router({
  requestDueDateChange: salesManagerProcedure
    .input(requestIdentity.extend({ dueDate }))
    .mutation(({ input, ctx }) => requestSalesControl({
      requestKey: input.requestKey,
      invoiceId: input.invoiceId,
      requestType: "SALES_DUE_DATE_CHANGE",
      reason: input.reason,
      payload: { dueDate: input.dueDate },
    }, actor(ctx))),

  requestExchange: salesCashierProcedure
    .input(requestIdentity.extend({ payload: correctionPayload }))
    .mutation(({ input, ctx }) => requestSalesControl({
      ...input,
      requestType: "SALES_EXCHANGE",
    }, actor(ctx))),

  list: salesReadProcedure
    .input(z.object({
      status: z.enum(SALES_CONTROL_STATUSES).optional(),
      mine: z.boolean().optional(),
    }).optional())
    .query(({ input, ctx }) => {
      const canReview = moduleAccessAllowed(
        ctx.user.role as RoleKey,
        (ctx.user.permissionsOverride ?? null) as PermissionMap | null,
        "sales",
        "FULL",
        ["manager"],
      );
      return listSalesControlRequests(actor(ctx), {
        status: input?.status,
        mine: canReview ? input?.mine : true,
      });
    }),

  approve: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reviewNote: z.string().trim().max(500).nullish(),
    }))
    .mutation(({ input, ctx }) => approveSalesControlRequest(
      input.requestId,
      actor(ctx),
      input.reviewNote,
    )),

  reject: salesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(({ input, ctx }) => rejectSalesControlRequest(
      input.requestId,
      input.reason,
      actor(ctx),
    )),
});
