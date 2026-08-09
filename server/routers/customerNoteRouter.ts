import { z } from "zod";
import type { AuthUser } from "../context";
import {
  createCustomerNote,
  deleteCustomerNote,
  dueTodayCustomerNotes,
  dueTodayCustomerNotesPage,
  listCustomerNotesPage,
  resolveCustomerNote,
  updateCustomerNote,
} from "../services/customerNoteService";
import { logAudit } from "../services/auditService";
import { companyBranchScope, resolveTargetBranch } from "../services/companyBranchScope";
import type { Actor } from "../services/tx";
import { customersCashierProcedure, customersManagerProcedure, customersReadProcedure, router } from "../trpc";

const followUpDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ المتابعة غير صالح")
  .nullish();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

function actorOf(user: AuthUser, targetBranchId?: number): Actor {
  const scope = companyBranchScope(user);
  return {
    userId: user.id,
    branchId: targetBranchId ?? scope.branchId ?? 0,
    role: user.role,
    isOwner: user.isOwner === true,
  };
}

/**
 * ملاحظات متابعة العملاء — شريحة كاملة: list / dueToday / create / resolve / update / delete.
 * لا مبالغ ولا قيد محاسبي — سجلّ عمل يومي (مكالمة/وعد بالدفع/متابعة تسليم).
 */
export const customerNoteRouter = router({
  /** قائمة ملاحظات عميل واحد — بحث نصّي + مدى تاريخ إنشاء + ترقيم صفحات حقيقي.
   *  listCustomerNotes (customerNoteService.ts) لا تدعم q/from/to/offset — نجلب حتى سقفها الأقصى
   *  (٥٠٠، حجمٌ يوميّ معقول لملاحظات عميل واحد) ونُصفّي/نُرقّم هنا بدل تعديل الخدمة. */
  list: customersReadProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        includeResolved: z.boolean().default(true),
        limit: z.number().int().positive().max(500).default(100),
        offset: z.number().int().min(0).default(0).optional(),
        q: z.string().max(500).optional(),
        from: ymd.optional(),
        to: ymd.optional(),
      })
    )
    .query(({ input, ctx }) => listCustomerNotesPage(input, companyBranchScope(ctx.user))),

  /** تذكيرات اليوم والمتأخرة — ضمن فرع المدير، والشركة كاملة للأدمن/المالك. */
  dueToday: customersManagerProcedure.query(async ({ ctx }) => dueTodayCustomerNotes(companyBranchScope(ctx.user))),

  /** Complete paginated CRM reminders; the legacy array remains bounded for compatibility. */
  dueTodayPage: customersManagerProcedure
    .input(
      z.object({
        limit: z.number().int().positive().max(200).default(100),
        offset: z.number().int().min(0).default(0),
        q: z.string().max(500).optional(),
      }),
    )
    .query(({ input, ctx }) => dueTodayCustomerNotesPage(input, companyBranchScope(ctx.user))),

  create: customersCashierProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        note: z.string().min(1).max(2000),
        followUpDate,
        // مدير الفرع يُثبّت خادمياً على فرعه؛ الأدمن/المالك يحددان الفرع صراحةً.
        // لا fallback صامتاً إلى الفرع ١ لأي حساب بلا فرع.
        branchId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveTargetBranch(companyBranchScope(ctx.user), input.branchId, { required: true });
      const r = await createCustomerNote(
        { customerId: input.customerId, note: input.note, followUpDate: input.followUpDate },
        actorOf(ctx.user, branchId!)
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
      const res = await updateCustomerNote(input, actorOf(ctx.user));
      await logAudit(ctx, { action: "customerNote.update", entityType: "customerNote", entityId: input.noteId });
      return res;
    }),

  resolve: customersCashierProcedure
    .input(z.object({ noteId: z.number().int().positive(), isResolved: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await resolveCustomerNote(input.noteId, input.isResolved, actorOf(ctx.user));
      await logAudit(ctx, { action: "customerNote.resolve", entityType: "customerNote", entityId: input.noteId, newValue: { isResolved: input.isResolved } });
      return res;
    }),

  delete: customersManagerProcedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deleteCustomerNote(input.noteId, actorOf(ctx.user));
      await logAudit(ctx, { action: "customerNote.delete", entityType: "customerNote", entityId: input.noteId });
      return res;
    }),
});
