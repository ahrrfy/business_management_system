import { z } from "zod";
import {
  decideWorkOrderDesignApproval,
  DESIGN_APPROVAL_EVIDENCE_TYPES,
  getCurrentWorkOrderDesignApproval,
  getWorkOrderDesignApprovalByTask,
  requestWorkOrderDesignApproval,
} from "../services/workOrder/designApproval";
import {
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
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getCurrentWorkOrderDesignApproval(
        input.workOrderId,
        actorFromContext(ctx),
      ),
    ),

  getByTask: workordersReadProcedure
    .input(z.object({ taskId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getWorkOrderDesignApprovalByTask(input.taskId, actorFromContext(ctx)),
    ),

  decide: workordersManagerProcedure
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
