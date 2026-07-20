import { z } from "zod";
import { isDupEntry } from "@shared/errorMap.ar";
import { logAudit } from "../services/auditService";
import {
  consignmentBalancesReport,
  createConsignmentNote,
  getConsignmentNote,
  listConsignmentNotes,
  listConsignorProducts,
} from "../services/consignment/noteService";
import { consignmentReadProcedure, consignmentWriteProcedure, reportViewerProcedure, router } from "../trpc";

/**
 * بضاعة الأمانة — ش٢: سندات الإيداع/السحب/الاستبدال. راجع docs/consignment-design-2026-07-20.md.
 * السند = حركات مخزون بصفر أثر ماليّ. الفرع مقصور (requireOwnBranch عبر البوّابة).
 */
const lineSchema = z.object({
  lineDirection: z.enum(["IN", "OUT"]),
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.string().min(1),
  notes: z.string().nullish(),
});

export const consignmentRouter = router({
  list: consignmentReadProcedure
    .input(
      z.object({
        consignorId: z.number().int().positive().optional(),
        noteType: z.enum(["DEPOSIT", "WITHDRAW", "EXCHANGE"]).optional(),
        branchId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }).optional(),
    )
    .query(({ input }) => listConsignmentNotes(input ?? {})),

  get: consignmentReadProcedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .query(({ input }) => getConsignmentNote(input.noteId)),

  consignorProducts: consignmentReadProcedure
    .input(z.object({ consignorId: z.number().int().positive(), branchId: z.number().int().positive() }))
    .query(({ input }) => listConsignorProducts(input.consignorId, input.branchId)),

  // تقرير أرصدة بضاعة الأمانة — خلف بوّابة التقارير الحمراء (قيمة بالتكلفة/الحصة). §١١.
  balancesReport: reportViewerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(({ input }) => consignmentBalancesReport(input?.branchId)),

  create: consignmentWriteProcedure
    .input(
      z.object({
        noteType: z.enum(["DEPOSIT", "WITHDRAW", "EXCHANGE"]),
        consignorId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        clientRequestId: z.string().min(8).max(64).optional(),
        notes: z.string().nullish(),
        attachmentUrl: z.string().nullish(),
        lines: z.array(lineSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير admin مقصور بفرعه المُسنَد (البوّابة تفرض requireOwnBranch، ونثبّت branchId هنا أيضاً).
      const branchId = ctx.user.role === "admin" ? input.branchId : (ctx.user.branchId ?? input.branchId);
      // إعادة محاولة على تصادم رقم السند (uq_consign_note_number) — نمط idempotency البيع.
      const attempt = () =>
        createConsignmentNote({ ...input, branchId }, { userId: ctx.user.id, branchId });
      let res;
      try {
        res = await attempt();
      } catch (e) {
        if (isDupEntry(e)) res = await attempt();
        else throw e;
      }
      if (!res.idempotentReplay) {
        const action = input.noteType === "DEPOSIT" ? "consignment.deposit" : input.noteType === "WITHDRAW" ? "consignment.withdraw" : "consignment.swap";
        await logAudit(ctx, { action, entityType: "consignmentNote", entityId: res.noteId, newValue: { noteNumber: res.noteNumber, consignorId: input.consignorId, lines: input.lines.length } });
      }
      return res;
    }),
});
