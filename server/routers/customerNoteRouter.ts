import { TRPCError } from "@trpc/server";
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
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

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
    .query(async ({ input }) => {
      const all = await listCustomerNotes({
        customerId: input.customerId,
        includeResolved: input.includeResolved,
        limit: 500,
      });
      let rows = all;
      const q = input.q?.trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.note.toLowerCase().includes(q));
      if (input.from) rows = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) >= input.from!);
      if (input.to) rows = rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) <= input.to!);
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      const page = rows.slice(offset, offset + limit);
      return { rows: page, total: rows.length };
    }),

  /** تذكيرات اليوم والمتأخرة — عبر كل العملاء، مدير فأعلى (رؤية إشرافية). */
  dueToday: customersManagerProcedure.query(async () => dueTodayCustomerNotes()),

  create: customersCashierProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        note: z.string().min(1).max(2000),
        followUpDate,
        // فرع اختياري — يلزم فقط حين لا فرع مُسنَد للمستخدم (أدمن/مدير بلا فرع). createCustomerNote
        // يكتب branchId فعلياً على الملاحظة (خلافاً لبقية إجراءات هذا الراوتر التي تتجاهل actor.branchId)
        // ⇒ التثبيت الصامت `?? 1` كان يُسيء نسب ملاحظة مدير بلا فرع للفرع ١ (نمط PR #288 محظور — §٤ ق١١).
        branchId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = ctx.user.branchId != null ? Number(ctx.user.branchId) : input.branchId;
      if (branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "حدّد الفرع (branchId) — لا فرع مُسنَد لحسابك." });
      }
      const r = await createCustomerNote(
        { customerId: input.customerId, note: input.note, followUpDate: input.followUpDate },
        { userId: ctx.user.id, branchId, role: ctx.user.role }
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
