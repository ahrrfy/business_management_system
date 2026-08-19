import { z } from "zod";
import { productStudioManagerProcedure, productStudioReadProcedure, productStudioWriteProcedure, router } from "../trpc";
import { approveStudioTask, assignStudioTask, bulkAssignStudioTasks, createStudioCampaign, createStudioCampaignBacklog, bindStudioProcessingCandidate, getStudioCandidatePreview, getStudioSourcePreview, getStudioDashboard, getStudioCampaignAnalytics, listStudioAssignees, listStudioCampaigns, listStudioProducts, listStudioProductImages, listStudioTasks, rejectStudioTask, previewStudioCampaignBacklog, resolveStudioBarcode, revertStudioTask, saveStudioDraft, sendStudioDueNotifications, submitStudioCandidate, transitionStudioCampaign, updateStudioTaskSchedule, type ProductStudioActor } from "../services/productStudioService";

function actor(ctx: {
  user: {
    id: number;
    branchId?: number | null;
    role: string;
    isOwner?: boolean;
  };
}): ProductStudioActor {
  return {
    userId: Number(ctx.user.id),
    branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
    role: ctx.user.role,
    isOwner: ctx.user.isOwner === true,
  };
}

const taskId = z.number().int().positive();
const expectedRevision = z.number().int().positive();
const priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const campaignId = z.number().int().positive();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const adminOverrideReason = z.string().trim().min(5).max(500).optional();

export const productStudioRouter = router({
  dashboard: productStudioReadProcedure.query(({ ctx }) => getStudioDashboard(actor(ctx))),
  products: productStudioReadProcedure
    .input(
      z.object({
        search: z.string().trim().max(80).default(""),
        cursor: z.string().max(500).nullable().optional(),
        includeInactive: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => listStudioProducts(actor(ctx), input)),
  resolveBarcode: productStudioReadProcedure.input(z.object({ barcode: z.string().trim().min(1).max(64) })).query(({ ctx, input }) => resolveStudioBarcode(actor(ctx), input.barcode)),
  productImages: productStudioReadProcedure.input(z.object({ productId: z.number().int().positive() })).query(({ input }) => listStudioProductImages(input.productId)),
  assignees: productStudioManagerProcedure.query(({ ctx }) => listStudioAssignees(actor(ctx))),
  tasks: productStudioReadProcedure
    .input(
      z.object({
        scope: z.enum(["QUEUE", "MINE", "REVIEW", "HISTORY"]),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(1_000).nullable().optional(),
        statuses: z
          .array(z.enum(["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "APPROVED", "REJECTED", "FAILED", "REVERTED"]))
          .max(7)
          .optional(),
        priority: z.array(priority).max(4).optional(),
        overdue: z.boolean().optional(),
        assigneeId: z.number().int().positive().optional(),
        productId: z.number().int().positive().optional(),
        campaignId: campaignId.optional(),
        unassigned: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => listStudioTasks(actor(ctx), input)),
  campaigns: productStudioReadProcedure.query(({ ctx }) => listStudioCampaigns(actor(ctx))),
  createCampaign: productStudioManagerProcedure
    .input(
      z.object({
        name: z.string().trim().min(3).max(180),
        branchId: z.number().int().positive().optional(),
        status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
        startsAt: z.coerce.date().nullable().optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => createStudioCampaign(actor(ctx), input)),
  transitionCampaign: productStudioManagerProcedure
    .input(z.object({
      campaignId,
      status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]),
      startsAt: z.coerce.date().nullable().optional(),
      dueAt: z.coerce.date().nullable().optional(),
    }))
    .mutation(({ ctx, input }) => transitionStudioCampaign(actor(ctx), input)),
  previewCampaignBacklog: productStudioManagerProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => previewStudioCampaignBacklog(actor(ctx), input.campaignId)),
  createCampaignBacklog: productStudioManagerProcedure.input(z.object({ campaignId })).mutation(({ ctx, input }) => createStudioCampaignBacklog(actor(ctx), input.campaignId)),
  campaignAnalytics: productStudioReadProcedure.input(z.object({ campaignId })).query(({ ctx, input }) => getStudioCampaignAnalytics(actor(ctx), input.campaignId)),
  sendDueNotifications: productStudioManagerProcedure.input(z.object({ horizonHours: z.number().int().min(1).max(168).default(24) })).mutation(({ ctx, input }) => sendStudioDueNotifications(actor(ctx), new Date(), input.horizonHours)),
  candidatePreview: productStudioReadProcedure.input(z.object({ taskId })).query(({ ctx, input }) => {
    ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
    ctx.res.setHeader("Pragma", "no-cache");
    return getStudioCandidatePreview(actor(ctx), input.taskId);
  }),
  sourcePreview: productStudioReadProcedure.input(z.object({ taskId })).query(({ ctx, input }) => {
    ctx.res.setHeader("Cache-Control", "private, no-store, max-age=0");
    ctx.res.setHeader("Pragma", "no-cache");
    return getStudioSourcePreview(actor(ctx), input.taskId);
  }),
  assign: productStudioManagerProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        assigneeId: z.number().int().positive(),
        sourceImageId: z.number().int().positive().nullable().optional(),
        priority: priority.optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => assignStudioTask(actor(ctx), input)),
  bulkAssign: productStudioManagerProcedure
    .input(
      z.object({
        productIds: z.array(z.number().int().positive()).min(1).max(100),
        assigneeId: z.number().int().positive(),
        priority: priority.optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => bulkAssignStudioTasks(actor(ctx), input)),
  updateSchedule: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        expectedRevision,
        priority,
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateStudioTaskSchedule(actor(ctx), input)),
  saveDraft: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        proposedName: nullableText(255),
        proposedDescription: nullableText(5_000),
        proposedMarketingCopy: nullableText(3_000),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => saveStudioDraft(actor(ctx), input)),
  bindProcessingProof: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        processingReceipt: z.string().uuid(),
        candidateDataUrl: z.string().max(1_300_000),
        adminOverrideReason,
      }),
    )
    .mutation(({ ctx, input }) => bindStudioProcessingCandidate(actor(ctx), input)),
  submitCandidate: productStudioWriteProcedure
    .input(
      z.object({
        taskId,
        originalDataUrl: z.string().max(1_300_000).nullable().optional(),
        processedDataUrl: z.string().max(1_300_000),
        thumbnailDataUrl: z.string().max(180_000),
        mode: z.enum(["FLATTEN", "CUT"]),
        processingReceipt: z.string().uuid().nullable().optional(),
        proposedName: nullableText(255),
        proposedDescription: nullableText(5_000),
        proposedMarketingCopy: nullableText(3_000),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => submitStudioCandidate(actor(ctx), input)),
  approve: productStudioManagerProcedure.input(z.object({ taskId, adminOverrideReason, expectedRevision })).mutation(({ ctx, input }) => approveStudioTask(actor(ctx), input.taskId, input.adminOverrideReason, input.expectedRevision)),
  reject: productStudioManagerProcedure
    .input(
      z.object({
        taskId,
        reason: z.string().trim().min(5).max(500),
        adminOverrideReason,
        expectedRevision,
      }),
    )
    .mutation(({ ctx, input }) => rejectStudioTask(actor(ctx), input.taskId, input.reason, input.adminOverrideReason, input.expectedRevision)),
  revert: productStudioManagerProcedure.input(z.object({ taskId, expectedRevision })).mutation(({ ctx, input }) => revertStudioTask(actor(ctx), input.taskId, input.expectedRevision)),
});
