import { z } from "zod";
import { FULFILLMENT_REQUEST_STATUSES } from "../../shared/fulfillment";
import { nonNegMoneyString } from "../lib/schemas";
import {
  deliveryCashierProcedure,
  deliveryReadProcedure,
  router,
} from "../trpc";
import {
  createFulfillmentRequest,
  updateFulfillmentRequest,
  readyFulfillmentRequest,
  cancelFulfillmentRequest,
  releaseFulfillmentRequest,
  reassignFulfillmentRequest,
} from "../services/fulfillment/requests";
import {
  getFulfillmentRequest,
  listFulfillmentRequests,
  listFulfillmentRequestCandidates,
} from "../services/fulfillment/requestQueries";
import type { Actor } from "../services/tx";

const id = z.number().int().positive();
const source = z.union([
  z.object({ invoiceId: id }).strict(),
  z.object({ workOrderId: id }).strict(),
]);
const key = z.string().trim().min(8).max(80);
const transition = z.object({ id, expectedVersion: id, clientRequestId: key });
const fields = z.object({
  branchId: id,
  customerId: id.nullish(),
  recipientName: z.string().trim().min(2).max(255),
  recipientPhone: z.string().min(7).max(32),
  deliveryAddress: z.string().trim().min(3).max(4000),
  partyId: id.nullish(),
  deliveryFee: nonNegMoneyString,
  feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]),
  partialReleaseAllowed: z.boolean().optional(),
  futureFeeDecision: z.string().max(2000).nullish(),
  notes: z.string().max(4000).nullish(),
  sources: z.array(source).max(30),
});
const actorOf = (user: {
  id: number;
  branchId?: number | null;
  role?: string;
  isOwner?: boolean;
}): Actor => ({
  userId: user.id,
  branchId: Number(user.branchId ?? 0),
  role: user.role,
  isOwner: user.isOwner,
});

export const fulfillmentRequestsRouter = router({
  reassign: deliveryCashierProcedure
    .input(
      transition.extend({
        consignmentId: id,
        partyId: id.optional(),
        externalTrackingRef: z.string().max(100).optional(),
        assignedUserId: id.optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      reassignFulfillmentRequest(input, actorOf(ctx.user)),
    ),
  list: deliveryReadProcedure
    .input(
      z
        .object({
          branchId: id.optional(),
          status: z.enum(FULFILLMENT_REQUEST_STATUSES).optional(),
          search: z.string().max(200).optional(),
          limit: id.max(100).optional(),
          offset: z.number().int().nonnegative().optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) =>
      listFulfillmentRequests(input ?? {}, actorOf(ctx.user)),
    ),
  get: deliveryReadProcedure
    .input(z.object({ id }))
    .query(({ input, ctx }) =>
      getFulfillmentRequest(input.id, actorOf(ctx.user)),
    ),
  candidates: deliveryReadProcedure
    .input(
      z.object({
        branchId: id.optional(),
        customerId: id.nullish(),
        search: z.string().max(200).optional(),
        invoiceId: id.optional(),
        workOrderId: id.optional(),
        limit: id.max(100).optional(),
      }),
    )
    .query(({ input, ctx }) =>
      listFulfillmentRequestCandidates(input, actorOf(ctx.user)),
    ),
  create: deliveryCashierProcedure
    .input(fields.extend({ clientRequestId: key }))
    .mutation(({ input, ctx }) =>
      createFulfillmentRequest(input, actorOf(ctx.user)),
    ),
  update: deliveryCashierProcedure
    .input(fields.merge(transition))
    .mutation(({ input, ctx }) =>
      updateFulfillmentRequest(input, actorOf(ctx.user)),
    ),
  ready: deliveryCashierProcedure
    .input(transition)
    .mutation(({ input, ctx }) =>
      readyFulfillmentRequest(input, actorOf(ctx.user)),
    ),
  cancel: deliveryCashierProcedure
    .input(transition.extend({ reason: z.string().trim().min(3).max(2000) }))
    .mutation(({ input, ctx }) =>
      cancelFulfillmentRequest(input, actorOf(ctx.user)),
    ),
  release: deliveryCashierProcedure
    .input(
      transition.extend({
        itemIds: z.array(id).min(1).max(30).optional(),
        partialReleaseConfirmed: z.boolean().optional(),
        futureFeeDecision: z.string().trim().min(3).max(2000).optional(),
        subsequentDeliveryFee: nonNegMoneyString.optional(),
        subsequentFeeCollection: z
          .enum(["COURIER", "COUNTER", "SHOP"])
          .optional(),
        externalTrackingRef: z.string().max(160).optional(),
        assignedUserId: id.optional(), collectCreditOnDelivery: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      releaseFulfillmentRequest(input, actorOf(ctx.user)),
    ),
});
