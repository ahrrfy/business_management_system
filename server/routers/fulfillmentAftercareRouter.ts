import { z } from "zod";
import {
  AFTERCARE_CASE_STATUSES,
  AFTERCARE_DISPOSITIONS,
} from "../../shared/fulfillment";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import {
  deliveryCashierProcedure,
  deliveryManagerProcedure,
  deliveryReadProcedure,
  router,
} from "../trpc";
import {
  approveAftercareCase,
  cancelAftercareCase,
  confirmAftercareDelivery,
  createAftercareCase,
  dispatchAftercareExecution,
  payAftercareDeliveryFee,
  prepareAftercareExecution,
  resolveAftercareCase,
} from "../services/fulfillment/aftercare";
import {
  aftercareAvailableProducts,
  getAftercareCase,
  listAftercareCases,
  previewAftercareSource,
  resolveAftercareExecution,
} from "../services/fulfillment/aftercareQueries";

import { fulfillmentError } from "../services/fulfillment/core";

const id = z.number().int().positive();
const key = z.string().trim().min(8).max(80);
const text = z.string().trim().min(3).max(2000);
const identity = z.object({ id, expectedVersion: id, clientRequestId: key });
const source = z.object({
  invoiceId: id.optional(),
  workOrderId: id.optional(),
});
function actor(user: { id: number; branchId?: number | null; role?: string }) {
  if (
    user.branchId == null ||
    !Number.isSafeInteger(user.branchId) ||
    user.branchId <= 0
  )
    throw fulfillmentError(
      "لا يوجد فرع مسند للحساب؛ اختر فرع العمل من الإدارة قبل فتح المعالجة",
      "FORBIDDEN",
    );
  return {
    userId: user.id,
    branchId: Number(user.branchId),
    role: user.role,
  };
}

export const fulfillmentAftercareRouter = router({
  resolveExecution: deliveryReadProcedure
    .input(z.object({ executionId: id }))
    .query(({ input, ctx }) =>
      resolveAftercareExecution(input.executionId, actor(ctx.user)),
    ),
  list: deliveryReadProcedure
    .input(
      z.object({
        branchId: id.optional(),
        status: z.enum(AFTERCARE_CASE_STATUSES).optional(),
        search: z.string().max(200).optional(),
        page: id.optional(),
        pageSize: id.max(100).optional(),
      }),
    )
    .query(({ input, ctx }) =>
      listAftercareCases(
        { ...input, branchId: ctx.scopedBranchId ?? input.branchId },
        actor(ctx.user),
      ),
    ),
  get: deliveryReadProcedure
    .input(z.object({ id }))
    .query(({ input, ctx }) => getAftercareCase(input.id, actor(ctx.user))),
  preview: deliveryReadProcedure
    .input(
      source.extend({
        sourceKind: z.enum(["INVOICE", "WORK_ORDER"]).optional(),
        sourceReference: z.string().trim().min(1).max(255).optional(),
      }),
    )
    .query(({ input, ctx }) => previewAftercareSource(input, actor(ctx.user))),
  products: deliveryReadProcedure
    .input(z.object({ branchId: id, search: z.string().max(100).optional() }))
    .query(({ input, ctx }) =>
      aftercareAvailableProducts(input, actor(ctx.user)),
    ),
  create: deliveryCashierProcedure
    .input(
      source.extend({
        branchId: id,
        clientRequestId: key,
        reason: text,
        evidence: text,
        originalConsignmentId: id.optional(),
        lines: z
          .array(
            z
              .object({
                originalInvoiceItemId: id.nullish(),
                sourceWorkOrderId: id.nullish(),
                originalBundleComponentId: id.optional(),
                componentVariantId: id.nullish(),
                disposition: z.enum(AFTERCARE_DISPOSITIONS),
                baseQuantity: id,
                originalMovementId: id.optional(),
                physicalHeldConfirmed: z.boolean().optional(),
                evidence: text,
              })
              .refine(
                (line) =>
                  (line.originalInvoiceItemId != null) !==
                  (line.sourceWorkOrderId != null),
                {
                  message: "حدد سطر الفاتورة أو أمر الخدمة الخالص، لا كليهما",
                  path: ["sourceWorkOrderId"],
                },
              ),
          )
          .min(1)
          .max(100),
      }),
    )
    .mutation(({ input, ctx }) => createAftercareCase(input, actor(ctx.user))),
  approve: deliveryManagerProcedure
    .input(identity)
    .mutation(({ input, ctx }) => approveAftercareCase(input, actor(ctx.user))),
  prepare: deliveryManagerProcedure
    .input(
      identity.extend({
        recipientName: z.string().trim().min(2).max(255),
        recipientPhone: z.string().trim().min(10).max(24),
        deliveryAddress: text,
        deliveryFee: nonNegMoneyString,
        reuseExecutionId: id.optional(),
        lines: z
          .array(
            z.object({
              aftercareLineId: id,
              baseQuantity: id,
              materials: z
                .array(z.object({ variantId: id, baseQuantity: id }))
                .max(100)
                .optional(),
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .mutation(({ input, ctx }) =>
      prepareAftercareExecution(input, actor(ctx.user)),
    ),
  dispatch: deliveryManagerProcedure
    .input(
      identity.extend({
        partyId: id,
        externalTrackingRef: z.string().trim().max(100).optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      dispatchAftercareExecution(input, actor(ctx.user)),
    ),
  confirm: deliveryManagerProcedure
    .input(
      identity.extend({
        proof: text,
        result: z.enum(["DELIVERED", "FAILED", "RETURNED"]),
        feeEarned: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      confirmAftercareDelivery(input, actor(ctx.user)),
    ),
  payFee: deliveryManagerProcedure
    .input(
      identity.extend({
        amount: positiveMoneyString,
        cashBucket: z.enum(["DRAWER", "TREASURY"]),
        shiftId: id.optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      payAftercareDeliveryFee(input, actor(ctx.user)),
    ),
  cancel: deliveryManagerProcedure
    .input(identity.extend({ reason: text }))
    .mutation(({ input, ctx }) => cancelAftercareCase(input, actor(ctx.user))),
  resolve: deliveryManagerProcedure
    .input(identity.extend({ resolution: text }))
    .mutation(({ input, ctx }) => resolveAftercareCase(input, actor(ctx.user))),
});
