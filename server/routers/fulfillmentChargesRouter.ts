import { z } from "zod";
import {
  router,
  deliveryReadProcedure,
  deliveryCashierProcedure,
  deliveryManagerProcedure,
} from "../trpc";
import { FULFILLMENT_CHARGE_CATEGORIES } from "../../shared/fulfillment";
import { positiveMoneyString, nonNegMoneyString } from "../lib/schemas";
import { resolveActorBranchId } from "../lib/branchAuthority";
import type { TrpcContext } from "../context";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
  completeFulfillmentCharge,
  collectFulfillmentCharges,
  refundFulfillmentCharge,
  refundFulfillmentChargeExcess,
  refundFulfillmentCourierExcess,
  settleFulfillmentChargePayee,
  recordFulfillmentChargeCourierCollection,
  remitFulfillmentChargeCourier,
} from "../services/fulfillment/charges";
import {
  getFulfillmentCharge,
  listFulfillmentCharges,
  lookupFulfillmentChargeOptions,
  listFulfillmentCourierExcess,
} from "../services/fulfillment/chargeQueries";
import {
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
} from "../services/posExternalPayment";

const id = z.number().int().positive(),
  key = z.string().trim().min(8).max(80);
const transition = z.object({ id, clientRequestId: key, expectedVersion: id });
const tender = z.object({
  method: z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]),
  cashBucket: z.enum(["DRAWER", "TREASURY"]).nullish(),
  shiftId: id.nullish(),
  reference: z.string().trim().max(100).nullish(),
  externalPaymentAttemptId: id.nullish(),
  externalPaymentDeviceId: z.string().trim().max(120).nullish(),
});
const allocations = z
  .array(
    z.object({
      chargeId: id,
      expectedVersion: id,
      amount: positiveMoneyString,
    }),
  )
  .min(1)
  .max(50);
function actor(ctx: TrpcContext, branchId?: number) {
  return {
    userId: ctx.user!.id,
    branchId:
      branchId === undefined
        ? Number(ctx.user!.branchId ?? 0)
        : resolveActorBranchId({ user: ctx.user! }, branchId),
    role: ctx.user!.role,
    isOwner: ctx.user!.isOwner,
  };
}

export const fulfillmentChargesRouter = router({
  list: deliveryReadProcedure
    .input(
      z.object({
        branchId: id,
        search: z.string().max(200).optional(),
        requestId: id.optional(),
        customerId: id.optional(),
        category: z.enum(FULFILLMENT_CHARGE_CATEGORIES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      listFulfillmentCharges(input, actor(ctx, input.branchId)),
    ),
  listCourierExcess: deliveryReadProcedure
    .input(
      z.object({
        branchId: id,
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      listFulfillmentCourierExcess(input, actor(ctx, input.branchId)),
    ),
  get: deliveryReadProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getFulfillmentCharge(input.id, actor(ctx))),
  lookup: deliveryReadProcedure
    .input(z.object({ branchId: id, search: z.string().max(200).optional() }))
    .query(({ ctx, input }) =>
      lookupFulfillmentChargeOptions(input, actor(ctx, input.branchId)),
    ),
  create: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        requestId: id.nullish(),
        customerId: id.nullish(),
        category: z.enum(FULFILLMENT_CHARGE_CATEGORIES),
        description: z.string().trim().min(1).max(2000),
        amount: nonNegMoneyString,
        externalCost: nonNegMoneyString,
        payeeSupplierId: id.nullish(),
        payeePartyId: id.nullish(),
        payeeUserId: id.nullish(),
        payeeName: z.string().trim().max(255).nullish(),
        payeePhone: z.string().trim().max(24).nullish(),
        reason: z.string().trim().max(2000).nullish(),
        clientRequestId: key,
      }),
    )
    .mutation(({ ctx, input }) =>
      createFulfillmentCharge(input, actor(ctx, input.branchId)),
    ),
  approve: deliveryManagerProcedure
    .input(transition)
    .mutation(({ ctx, input }) => approveFulfillmentCharge(input, actor(ctx))),
  complete: deliveryManagerProcedure
    .input(
      transition.extend({
        evidence: z.string().trim().min(5).max(2000),
      }),
    )
    .mutation(({ ctx, input }) => completeFulfillmentCharge(input, actor(ctx))),
  collect: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        clientRequestId: key,
        allocations,
        amount: positiveMoneyString,
        tender,
      }),
    )
    .mutation(({ ctx, input }) =>
      collectFulfillmentCharges(input, actor(ctx, input.branchId)),
    ),
  refund: deliveryManagerProcedure
    .input(
      transition.extend({
        originalPaymentId: id,
        amount: positiveMoneyString,
        reason: z.string().trim().min(5).max(2000),
        reference: z.string().trim().max(100).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => refundFulfillmentCharge(input, actor(ctx))),
  refundExcess: deliveryManagerProcedure
    .input(
      transition.extend({
        originalReceiptId: id,
        amount: positiveMoneyString,
        reason: z.string().trim().min(5).max(2000),
        reference: z.string().trim().max(100).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      refundFulfillmentChargeExcess(input, actor(ctx)),
    ),
  settlePayee: deliveryCashierProcedure
    .input(transition.extend({ amount: positiveMoneyString, tender }))
    .mutation(({ ctx, input }) =>
      settleFulfillmentChargePayee(input, actor(ctx)),
    ),
  refundCourierExcess: deliveryManagerProcedure
    .input(
      z
        .object({
          id: id.optional(),
          fulfillmentRequestId: id.optional(),
          expectedVersion: id,
          clientRequestId: key,
          originalExcessEntryId: id,
          consignmentId: id,
          amount: positiveMoneyString,
          reason: z.string().trim().min(5).max(2000),
          tender,
        })
        .refine(
          (value) =>
            (value.id == null) !== (value.fulfillmentRequestId == null),
          { message: "حدد مصدراً واحداً لرد الأمانة" },
        ),
    )
    .mutation(({ ctx, input }) =>
      refundFulfillmentCourierExcess(input, actor(ctx)),
    ),
  recordCourierCollection: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        clientRequestId: key,
        allocations,
        partyId: id,
        consignmentId: id,
      }),
    )
    .mutation(({ ctx, input }) =>
      recordFulfillmentChargeCourierCollection(
        input,
        actor(ctx, input.branchId),
      ),
    ),
  remitCourier: deliveryCashierProcedure
    .input(
      transition.extend({
        originalPaymentId: id,
        amount: positiveMoneyString,
        tender,
      }),
    )
    .mutation(({ ctx, input }) =>
      remitFulfillmentChargeCourier(input, actor(ctx)),
    ),
  initiateExternalPayment: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        method: z.enum(["CARD", "TRANSFER", "WALLET"]),
        amount: positiveMoneyString,
        reference: z.string().trim().min(1).max(100),
        requestId: key,
        deviceId: z.string().trim().min(1).max(120),
      }),
    )
    .mutation(({ ctx, input }) =>
      initiateExternalPaymentAttempt(
        { ...input, channel: "SALES_COLLECTION" },
        actor(ctx, input.branchId),
      ),
    ),
  confirmExternalPayment: deliveryCashierProcedure
    .input(
      z.object({
        branchId: id,
        attemptId: id,
        deviceId: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(({ ctx, input }) =>
      confirmExternalPaymentAttempt(
        { ...input, channel: "SALES_COLLECTION" },
        actor(ctx, input.branchId),
      ),
    ),
});
