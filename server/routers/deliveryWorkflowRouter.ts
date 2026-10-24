import { z } from "zod";
import {
  WORKFLOW_SOURCE_KINDS,
  WORKFLOW_STATIONS,
} from "../../shared/deliveryWorkflow";
import { nonNegMoneyString } from "../lib/schemas";
import {
  deliveryCashierProcedure,
  deliveryReadProcedure,
  router,
} from "../trpc";
import {
  previewWorkflowScan,
  previewWorkflowSource,
} from "../services/delivery/workflow/preview";
import {
  dispatchWorkflowBatch,
  previewWorkflowBatch,
} from "../services/delivery/workflow/dispatch";
import { mutateWorkflowAssignment } from "../services/delivery/workflow/assignment";
import { confirmWorkflowDelivery } from "../services/delivery/workflow/collection";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { receiveWorkflowReturn } from "../services/delivery/workflow/returns";

const source = z.object({
  kind: z.enum(WORKFLOW_SOURCE_KINDS),
  id: z.number().int().positive(),
  expectedVersion: z.string().min(1).max(128),
});
const branchId = z.number().int().positive().optional();
const clientRequestId = z.string().trim().min(8).max(56);
function actorOf(ctx: {
  user: { id: number; branchId?: number | null; role?: string };
}) {
  return {
    userId: ctx.user.id,
    branchId: ctx.user.branchId ?? 0,
    role: ctx.user.role,
  };
}
export const deliveryWorkflowRouter = router({
  receiveReturn: deliveryCashierProcedure
    .input(
      z.object({
        source,
        branchId,
        evidence: z.string().trim().min(5).max(2000),
        inspected: z.literal(true),
        receivedConsignmentIds: z
          .array(z.number().int().positive())
          .min(1)
          .max(30)
          .optional(),
        clientRequestId,
      }),
    )
    .mutation(({ input, ctx }) =>
      retryOnDeadlock(() => receiveWorkflowReturn(input, actorOf(ctx))),
    ),
  confirmDelivery: deliveryCashierProcedure
    .input(
      z.object({
        source,
        branchId,
        evidence: z.string().trim().min(3).max(255),
        clientRequestId,
      }),
    )
    .mutation(({ input, ctx }) =>
      retryOnDeadlock(() => confirmWorkflowDelivery(input, actorOf(ctx))),
    ),
  previewBySource: deliveryReadProcedure
    .input(
      z.object({
        source: z.object({
          kind: z.enum(WORKFLOW_SOURCE_KINDS),
          id: z.number().int().positive(),
        }),
        station: z.enum(WORKFLOW_STATIONS),
        branchId,
      }),
    )
    .query(({ input, ctx }) => previewWorkflowSource(input, actorOf(ctx))),
  preview: deliveryReadProcedure
    .input(
      z.object({
        raw: z.string().trim().min(1).max(2048),
        station: z.enum(WORKFLOW_STATIONS),
        branchId,
      }),
    )
    .query(({ input, ctx }) => previewWorkflowScan(input, actorOf(ctx))),
  previewBatch: deliveryReadProcedure
    .input(
      z.object({
        sources: z.array(source).min(1).max(30),
        branchId,
        deliveryFee: nonNegMoneyString.optional(),
        feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]).optional(),
      }),
    )
    .query(({ input, ctx }) => previewWorkflowBatch(input, actorOf(ctx))),
  dispatchBatch: deliveryCashierProcedure
    .input(
      z.object({
        sources: z.array(source).min(1).max(30),
        branchId,
        partyId: z.number().int().positive(),
        assignedUserId: z.number().int().positive().optional(),
        deliveryFee: nonNegMoneyString,
        feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]),
        recipientName: z.string().trim().min(2).max(255),
        recipientPhone: z.string().trim().min(5).max(32),
        deliveryAddress: z.string().trim().min(3).max(2000),
        externalTrackingRef: z.string().trim().max(100).optional(),
        notes: z.string().max(2000).optional(),
        clientRequestId,
      }),
    )
    .mutation(({ input, ctx }) =>
      retryOnDeadlock(() => dispatchWorkflowBatch(input, actorOf(ctx))),
    ),
  assignment: deliveryCashierProcedure
    .input(
      z.object({
        source,
        branchId,
        action: z.enum(["cancelAssignment", "reassign", "declareReturn"]),
        reason: z.string().trim().min(3).max(500),
        clientRequestId,
        partyId: z.number().int().positive().optional(),
        assignedUserId: z.number().int().positive().optional(),
        externalTrackingRef: z.string().trim().max(100).optional(),
        physicalHeldConfirmed: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      retryOnDeadlock(() => mutateWorkflowAssignment(input, actorOf(ctx))),
    ),
});
