import { z } from "zod";
import {
  createCustomerNote,
  deleteCustomerNote,
  dueTodayCustomerNotes,
  listCustomerNotes,
  resolveCustomerNote,
  updateCustomerNote,
} from "../services/customerNoteService";
import { logAudit } from "../services/auditService";
import { customersCashierProcedure, customersManagerProcedure, customersReadProcedure, router } from "../trpc";

const followUpDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ المتابعة غير صالح")
  .nullish();

/**
 * ملاحظات متابعة العملاء — شريحة كاملة: list / dueToday / create / resolve / update / delete.
 * لا مبالغ ولا قيد محاسبي — سجلّ عمل يومي (مكالمة/وعد بالدفع/متابعة تسليم).
 */
export const customerNoteRouter = router({
  /** قائمة ملاحظات عميل واحد. */
  list: customersReadProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        includeResolved: z.boolean().default(true),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .query(async ({ input }) => listCustomerNotes(input)),

  /** تذكيرات اليوم والمتأخرة — عبر كل العملاء، مدير فأعلى (رؤية إشرافية). */
  dueToday: customersManagerProcedure.query(async () => dueTodayCustomerNotes()),

  create: customersCashierProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        note: z.string().min(1).max(2000),
        followUpDate,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const r = await createCustomerNote(
        { customerId: input.customerId, note: input.note, followUpDate: input.followUpDate },
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role }
      );
      await logAudit(ctx, { action: "customerNote.create", entityType: "customerNote", entityId: r.id, newValue: { customerId: input.customerId } });
      return r;
    }),

  update: customersManagerProcedure
    .input(
      z.object({
        noteId: z.number().int().positive(),
        note: z.string().min(1).max(2000).optional(),
        followUpDate,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateCustomerNote(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "customerNote.update", entityType: "customerNote", entityId: input.noteId });
      return res;
    }),

  resolve: customersCashierProcedure
    .input(z.object({ noteId: z.number().int().positive(), isResolved: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await resolveCustomerNote(input.noteId, input.isResolved, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "customerNote.resolve", entityType: "customerNote", entityId: input.noteId, newValue: { isResolved: input.isResolved } });
      return res;
    }),

  delete: customersManagerProcedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deleteCustomerNote(input.noteId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "customerNote.delete", entityType: "customerNote", entityId: input.noteId });
      return res;
    }),
});
