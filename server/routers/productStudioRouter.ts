import { z } from "zod";
import {
  productStudioManagerProcedure,
  productStudioReadProcedure,
  productStudioWriteProcedure,
  router,
} from "../trpc";
import {
  approveStudioTask,
  assignStudioTask,
  bindStudioProcessingCandidate,
  getStudioCandidatePreview,
  getStudioSourcePreview,
  getStudioDashboard,
  listStudioAssignees,
  listStudioProducts,
  listStudioProductImages,
  listStudioTasks,
  rejectStudioTask,
  revertStudioTask,
  saveStudioDraft,
  submitStudioCandidate,
  type ProductStudioActor,
} from "../services/productStudioService";

function actor(ctx: { user: { id: number; branchId?: number | null; role: string; isOwner?: boolean } }): ProductStudioActor {
  return {
    userId: Number(ctx.user.id),
    branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
    role: ctx.user.role,
    isOwner: ctx.user.isOwner === true,
  };
}

const taskId = z.number().int().positive();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const productStudioRouter = router({
  dashboard: productStudioReadProcedure.query(({ ctx }) => getStudioDashboard(actor(ctx))),
  products: productStudioReadProcedure
    .input(z.object({ search: z.string().trim().max(80).default("") }))
    .query(({ input }) => listStudioProducts(input.search)),
  productImages: productStudioReadProcedure
    .input(z.object({ productId: z.number().int().positive() }))
    .query(({ input }) => listStudioProductImages(input.productId)),
  assignees: productStudioManagerProcedure.query(({ ctx }) => listStudioAssignees(actor(ctx))),
  tasks: productStudioReadProcedure
    .input(z.object({
      scope: z.enum(["QUEUE", "MINE", "REVIEW", "HISTORY"]),
      limit: z.number().int().min(1).max(200).default(100),
    }))
    .query(({ ctx, input }) => listStudioTasks(actor(ctx), input)),
  candidatePreview: productStudioReadProcedure
    .input(z.object({ taskId }))
    .query(({ ctx, input }) => {
      ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
      ctx.res.setHeader("Pragma", "no-cache");
      return getStudioCandidatePreview(actor(ctx), input.taskId);
    }),
  sourcePreview: productStudioReadProcedure
    .input(z.object({ taskId }))
    .query(({ ctx, input }) => {
      ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
      ctx.res.setHeader("Pragma", "no-cache");
      return getStudioSourcePreview(actor(ctx), input.taskId);
    }),
  assign: productStudioManagerProcedure
    .input(z.object({
      productId: z.number().int().positive(),
      assigneeId: z.number().int().positive(),
      sourceImageId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(({ ctx, input }) => assignStudioTask(actor(ctx), input)),
  saveDraft: productStudioWriteProcedure
    .input(z.object({
      taskId,
      proposedName: nullableText(255),
      proposedDescription: nullableText(5_000),
      proposedMarketingCopy: nullableText(3_000),
    }))
    .mutation(({ ctx, input }) => saveStudioDraft(actor(ctx), input)),
  bindProcessingProof: productStudioWriteProcedure
    .input(z.object({
      taskId,
      processingReceipt: z.string().uuid(),
      candidateDataUrl: z.string().max(1_300_000),
    }))
    .mutation(({ ctx, input }) => bindStudioProcessingCandidate(actor(ctx), input)),
  submitCandidate: productStudioWriteProcedure
    .input(z.object({
      taskId,
      originalDataUrl: z.string().max(1_300_000).nullable().optional(),
      processedDataUrl: z.string().max(1_300_000),
      thumbnailDataUrl: z.string().max(180_000),
      mode: z.enum(["FLATTEN", "CUT"]),
      processingReceipt: z.string().uuid().nullable().optional(),
      proposedName: nullableText(255),
      proposedDescription: nullableText(5_000),
      proposedMarketingCopy: nullableText(3_000),
    }))
    .mutation(({ ctx, input }) => submitStudioCandidate(actor(ctx), input)),
  approve: productStudioManagerProcedure
    .input(z.object({ taskId }))
    .mutation(({ ctx, input }) => approveStudioTask(actor(ctx), input.taskId)),
  reject: productStudioManagerProcedure
    .input(z.object({ taskId, reason: z.string().trim().min(5).max(500) }))
    .mutation(({ ctx, input }) => rejectStudioTask(actor(ctx), input.taskId, input.reason)),
  revert: productStudioManagerProcedure
    .input(z.object({ taskId }))
    .mutation(({ ctx, input }) => revertStudioTask(actor(ctx), input.taskId)),
});
