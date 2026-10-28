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
  cancelAftercareExecution,
  confirmAftercareDelivery,
  createAftercareCase,
  dispatchAftercareExecution,
  declareAftercareExecutionReturn,
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
  resolveAftercareActor,
} from "../services/fulfillment/aftercareQueries";
import {
  approveAftercareSettlement,
  postAftercareSettlement,
  previewAftercareSettlement,
  requestAftercareSettlement,
  withdrawAftercareSettlement,
} from "../services/fulfillment/aftercareSettlement";
import {
  getComponentRightsSettlement,
  postComponentRights,
  confirmComponentRightsRefund,
} from "../services/fulfillment/componentRights";

const id = z.number().int().positive();
const key = z.string().trim().min(8).max(80);
const text = z.string().trim().min(3).max(2000);
const identity = z.object({
  id,
  expectedVersion: id,
  clientRequestId: key,
  branchId: id.optional(),
});
const source = z.object({
  branchId: id.optional(),
  invoiceId: id.optional(),
  workOrderId: id.optional(),
});
const rightsRefund = z.object({
  amount: positiveMoneyString,
  method: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]),
  shiftId: id.nullish(),
  reference: z.string().trim().max(255).nullish(),
  pendingExternal: z.boolean().optional(),
});
const settlementInput = z.object({
  branchId: id.optional(),
  id,
  expectedVersion: id,
  reason: text,
  evidence: text,
  physicalHeldConfirmed: z.boolean(),
  decisions: z
    .array(
      z.object({
        executionLineId: id,
        usableBaseQuantity: z.number().int().nonnegative(),
        consumedBaseQuantity: z.number().int().nonnegative(),
        damagedBaseQuantity: z.number().int().nonnegative(),
        evidence: text,
      }),
    )
    .max(1000),
  sourceRights: z
    .array(
      z.object({
        invoiceItemId: id,
        originalBundleComponentId: id.nullable(),
        componentVariantId: id,
        baseQuantity: id,
        originalMovementId: id,
        usableBaseQuantity: z.number().int().nonnegative(),
        damagedBaseQuantity: z.number().int().nonnegative(),
        commercialAmount: nonNegMoneyString,
        originalIssueValue: nonNegMoneyString,
        costEvidence: text,
        costEvidenceReference: z.string().trim().min(3).max(2000),
      }),
    )
    .max(100),
});

export const fulfillmentAftercareRouter = router({
  resolveExecution: deliveryReadProcedure
    .input(z.object({ executionId: id, branchId: id.optional() }))
    .query(async ({ input, ctx }) =>
      resolveAftercareExecution(
        input.executionId,
        await resolveAftercareActor(ctx.user, input),
      ),
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
    .query(async ({ input, ctx }) =>
      listAftercareCases(
        { ...input, branchId: ctx.scopedBranchId ?? input.branchId },
        await resolveAftercareActor(ctx.user, input),
      ),
    ),
  get: deliveryReadProcedure
    .input(z.object({ id, branchId: id.optional() }))
    .query(async ({ input, ctx }) =>
      getAftercareCase(
        input.id,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
  preview: deliveryReadProcedure
    .input(
      source.extend({
        sourceKind: z.enum(["INVOICE", "WORK_ORDER"]).optional(),
        sourceReference: z.string().trim().min(1).max(255).optional(),
      }),
    )
    .query(async ({ input, ctx }) =>
      previewAftercareSource(
        input,
        await resolveAftercareActor(ctx.user, input),
      ),
    ),
  products: deliveryReadProcedure
    .input(z.object({ branchId: id, search: z.string().max(100).optional() }))
    .query(async ({ input, ctx }) =>
      aftercareAvailableProducts(
        input,
        await resolveAftercareActor(ctx.user, input),
      ),
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
    .mutation(async ({ input, ctx }) =>
      createAftercareCase(input, await resolveAftercareActor(ctx.user, input)),
    ),
  approve: deliveryCashierProcedure
    .input(identity)
    .mutation(async ({ input, ctx }) =>
      approveAftercareCase(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
  prepare: deliveryCashierProcedure
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
    .mutation(async ({ input, ctx }) =>
      prepareAftercareExecution(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
  dispatch: deliveryCashierProcedure
    .input(
      identity.extend({
        partyId: id,
        assignedUserId: id.optional(),
        externalTrackingRef: z.string().trim().max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      dispatchAftercareExecution(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          executionId: input.id,
        }),
      ),
    ),
  confirm: deliveryCashierProcedure
    .input(
      identity.extend({
        proof: text,
        result: z.enum(["DELIVERED", "FAILED", "RETURNED"]),
        feeEarned: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      confirmAftercareDelivery(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          executionId: input.id,
        }),
      ),
    ),
  payFee: deliveryCashierProcedure
    .input(
      identity.extend({
        amount: positiveMoneyString,
        cashBucket: z.enum(["DRAWER", "TREASURY"]),
        shiftId: id.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      payAftercareDeliveryFee(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          executionId: input.id,
        }),
      ),
    ),
  cancel: deliveryCashierProcedure
    .input(identity.extend({ reason: text }))
    .mutation(async ({ input, ctx }) =>
      cancelAftercareCase(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
  cancelExecution: deliveryCashierProcedure
    .input(
      identity.extend({ reason: text, physicalHeldConfirmed: z.boolean() }),
    )
    .mutation(async ({ input, ctx }) =>
      cancelAftercareExecution(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          executionId: input.id,
        }),
      ),
    ),
  declareReturn: deliveryCashierProcedure
    .input(identity.extend({ reason: text }))
    .mutation(async ({ input, ctx }) =>
      declareAftercareExecutionReturn(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          executionId: input.id,
        }),
      ),
    ),
  settlementPreview: deliveryCashierProcedure
    .input(settlementInput)
    .query(async ({ input, ctx }) =>
      previewAftercareSettlement(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
  settlementRequest: deliveryCashierProcedure
    .input(
      settlementInput.extend({
        previewHash: z.string().length(64),
        clientRequestId: key,
      }),
    )
    .mutation(async ({ input, ctx }) =>
      requestAftercareSettlement(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
  approveSettlement: deliveryCashierProcedure
    .input(identity)
    .mutation(async ({ input, ctx }) =>
      approveAftercareSettlement(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          settlementId: input.id,
        }),
      ),
    ),
  settlementPost: deliveryCashierProcedure
    .input(identity)
    .mutation(async ({ input, ctx }) =>
      postAftercareSettlement(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          settlementId: input.id,
        }),
      ),
    ),
  settlementWithdraw: deliveryCashierProcedure
    .input(identity.extend({ reason: text }))
    .mutation(async ({ input, ctx }) =>
      withdrawAftercareSettlement(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          settlementId: input.id,
        }),
      ),
    ),
  rightsPreview: deliveryReadProcedure
    .input(z.object({ settlementId: id, branchId: id.optional() }))
    .query(async ({ input, ctx }) =>
      getComponentRightsSettlement(
        input,
        await resolveAftercareActor(ctx.user, input),
      ),
    ),
  rightsPost: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id.optional(),
        settlementId: id,
        rightIndex: z.number().int().nonnegative(),
        clientRequestId: key,
        refund: rightsRefund.optional(),
        refunds: z.array(rightsRefund).min(1).max(10).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      postComponentRights(input, await resolveAftercareActor(ctx.user, input)),
    ),
  rightsConfirmRefund: deliveryCashierProcedure
    .input(
      z.object({
        receiptId: id,
        branchId: id.optional(),
        reference: z.string().trim().min(3).max(255),
        clientRequestId: key,
      }),
    )
    .mutation(async ({ input, ctx }) =>
      confirmComponentRightsRefund(
        input,
        await resolveAftercareActor(ctx.user, input),
      ),
    ),
  resolve: deliveryCashierProcedure
    .input(identity.extend({ resolution: text }))
    .mutation(async ({ input, ctx }) =>
      resolveAftercareCase(
        input,
        await resolveAftercareActor(ctx.user, {
          branchId: input.branchId,
          caseId: input.id,
        }),
      ),
    ),
});
