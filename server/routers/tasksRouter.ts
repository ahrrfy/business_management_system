// نظام المهام الموحّد — راوتر tRPC (S2). نمط workOrderRouter.ts: قراءة/كتابة تنفيذية/كتابة مديرية،
// كل الكتابات مُدقَّقة عبر logAudit.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  addComment,
  assignTask,
  assignableStaff,
  cancelTask,
  claimTask,
  createTask,
  getTask,
  listTasks,
  reopenTask,
  resolveTask,
  resumeTask,
  setWaiting,
} from "../services/tasks";
import { router, tasksManagerProcedure, tasksReadProcedure, tasksWriteProcedure } from "../trpc";

const taskKind = z.enum(["SERVICE_REQUEST", "SUPPORT", "INQUIRY", "FOLLOW_UP", "INTERNAL"]);
const taskStatus = z.enum(["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CANCELLED"]);
const taskPriority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const sourceChannel = z.enum(["WHATSAPP", "INSTAGRAM", "TIKTOK", "STORE", "PHONE", "WALK_IN", "OTHER"]);

type ReadCtx = { scopedBranchId: number | null; user: { branchId?: number | null } };

/** فرع الاستعلام: scopedBranchId يحسم الأمر لغير المرتفعين؛ المرتفع (null) يستعمل الفرع الصريح
 *  إن مُرِّر وإلا فرعه المُسنَد — نمط arRemindersRouter.scopedBranch مبسّطاً للقراءة فقط. */
function resolveBranchForQuery(ctx: ReadCtx, inputBranchId?: number): number | null {
  if (ctx.scopedBranchId != null) return ctx.scopedBranchId;
  return inputBranchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
}

export const tasksRouter = router({
  list: tasksReadProcedure
    .input(
      z
        .object({
          status: taskStatus.optional(),
          kind: taskKind.optional(),
          assignedTo: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          overdue: z.boolean().optional(),
          q: z.string().max(200).optional(),
          cursor: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listTasks({ scopedBranchId: ctx.scopedBranchId, scopedOwnerId: ctx.scopedOwnerId }, { ...input }),
    ),

  get: tasksReadProcedure
    .input(z.object({ taskId: z.number().int().positive() }))
    .query(({ ctx, input }) => getTask({ scopedBranchId: ctx.scopedBranchId, scopedOwnerId: ctx.scopedOwnerId }, input.taskId)),

  /** الموظفون القابلون للإسناد — فرع الاستعلام (فرع المستخدم لغير المرتفع، فرعه أو فرع صريح للمرتفع). */
  assignableStaff: tasksReadProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(({ ctx, input }) => {
      const branchId = resolveBranchForQuery(ctx, input?.branchId);
      if (branchId == null) return [];
      return assignableStaff(branchId);
    }),

  create: tasksWriteProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        kind: taskKind.optional(),
        title: z.string().min(1).max(200),
        description: z.string().max(4000).nullish(),
        priority: taskPriority.nullish(),
        customerId: z.number().int().positive().nullish(),
        supplierId: z.number().int().positive().nullish(),
        conversationId: z.number().int().positive().nullish(),
        linkedWorkOrderId: z.number().int().positive().nullish(),
        linkedInvoiceId: z.number().int().positive().nullish(),
        linkedQuotationId: z.number().int().positive().nullish(),
        serviceTypeId: z.number().int().positive().nullish(),
        sourceChannel: sourceChannel.nullish(),
        assignedTo: z.number().int().positive().nullish(),
        dueAt: z.string().nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع (نمط workOrders.create): غير المرتفع لا يُنشئ مهمة خارج فرعه.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && Number(ctx.user.branchId) !== input.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع إنشاء مهمة لفرع آخر" });
      }
      const res = await createTask(input, { userId: ctx.user.id, branchId: input.branchId, role: ctx.user.role });
      await logAudit(ctx, {
        action: "task.create",
        entityType: "task",
        entityId: res.taskId,
        newValue: { title: input.title, kind: input.kind ?? null, taskNumber: res.taskNumber },
      });
      return res;
    }),

  claim: tasksWriteProcedure.input(z.object({ taskId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const res = await claimTask(input.taskId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
    await logAudit(ctx, { action: "task.claim", entityType: "task", entityId: input.taskId });
    return res;
  }),

  setWaiting: tasksWriteProcedure
    .input(z.object({ taskId: z.number().int().positive(), note: z.string().max(2000).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setWaiting(input.taskId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role }, input.note ?? null);
      await logAudit(ctx, { action: "task.setWaiting", entityType: "task", entityId: input.taskId });
      return res;
    }),

  resume: tasksWriteProcedure.input(z.object({ taskId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const res = await resumeTask(input.taskId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
    await logAudit(ctx, { action: "task.resume", entityType: "task", entityId: input.taskId });
    return res;
  }),

  resolve: tasksWriteProcedure
    .input(z.object({ taskId: z.number().int().positive(), resolutionNote: z.string().max(4000).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await resolveTask(
        input.taskId,
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
        input.resolutionNote ?? null,
      );
      await logAudit(ctx, { action: "task.resolve", entityType: "task", entityId: input.taskId });
      return res;
    }),

  addComment: tasksWriteProcedure
    .input(z.object({ taskId: z.number().int().positive(), note: z.string().min(1).max(4000) }))
    .mutation(async ({ input, ctx }) => {
      const res = await addComment(input.taskId, input.note, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "task.comment", entityType: "task", entityId: input.taskId });
      return res;
    }),

  // إشرافي (مدير فأعلى): إسناد قسري/إعادة فتح/إلغاء.
  assign: tasksManagerProcedure
    .input(z.object({ taskId: z.number().int().positive(), assignedTo: z.number().int().positive().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const res = await assignTask(input.taskId, input.assignedTo, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "task.assign", entityType: "task", entityId: input.taskId, newValue: { assignedTo: input.assignedTo } });
      return res;
    }),

  reopen: tasksManagerProcedure
    .input(z.object({ taskId: z.number().int().positive(), note: z.string().max(2000).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await reopenTask(input.taskId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role }, input.note ?? null);
      await logAudit(ctx, { action: "task.reopen", entityType: "task", entityId: input.taskId });
      return res;
    }),

  cancel: tasksManagerProcedure
    .input(z.object({ taskId: z.number().int().positive(), note: z.string().min(1).max(2000) }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelTask(input.taskId, input.note, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "task.cancel", entityType: "task", entityId: input.taskId, newValue: { note: input.note } });
      return res;
    }),
});
