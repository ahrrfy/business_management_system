import { z } from "zod";
import {
  decideWorkOrderDesignApproval,
  DESIGN_APPROVAL_EVIDENCE_TYPES,
  getCurrentWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../services/workOrder/designApproval";
import {
  requireAtomicPermission,
  router,
  workordersExecProcedure,
  workordersManagerProcedure,
  workordersReadProcedure,
} from "../trpc";

function actorFromContext(ctx: {
  user: {
    id: number;
    branchId?: number | null;
    role: string;
    permissionsOverride?: unknown;
  };
}) {
  return {
    userId: ctx.user.id,
    branchId: ctx.user.branchId == null ? 0 : Number(ctx.user.branchId),
    role: ctx.user.role,
    permissionsOverride: ctx.user.permissionsOverride,
  };
}

export const workOrderDesignApprovalRouter = router({
  request: workordersExecProcedure
    .use(requireAtomicPermission("workshop.design_approval.upload_proof"))
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        requestKey: z.string().trim().min(1).max(120),
        note: z.string().trim().max(500).nullish(),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestWorkOrderDesignApproval(input, actorFromContext(ctx)),
    ),

  getCurrent: workordersReadProcedure
    .use(requireAtomicPermission("workshop.design_approval.view"))
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getCurrentWorkOrderDesignApproval(
        input.workOrderId,
        actorFromContext(ctx),
      ),
    ),

  decide: workordersManagerProcedure
    .use(requireAtomicPermission("workshop.design_approval.approve"))
    .input(
      z.object({
        approvalId: z.number().int().positive(),
        decisionKey: z.string().trim().min(1).max(120),
        decision: z.enum(["APPROVED", "REJECTED"]),
        reason: z.string().trim().min(3).max(500),
        evidence: z.object({
          type: z.enum(DESIGN_APPROVAL_EVIDENCE_TYPES),
          reference: z.string().trim().min(3).max(500),
        }),
      }),
    )
    .mutation(({ input, ctx }) =>
      decideWorkOrderDesignApproval(input, actorFromContext(ctx)),
    ),
});
