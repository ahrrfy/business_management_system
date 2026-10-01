// شجرة الحسابات والقيود اليومية اليدوية (P0، الدفتر المزدوج والحوكمة المالية الصارمة).
// القيود اليدوية تتبع لحوكمة الإقفال وتدقيق العمليات وفصل المهام المحاسبية.
import { z } from "zod";
import { chartOfAccounts, listAccounts } from "../services/accountsService";
import {
  createManualJournal,
  listManualJournals,
} from "../services/accounting/manualJournalService";
import { reportViewerProcedure, reportsManagerProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import type { RoleKey } from "@shared/permissions";

const manualJournalLineSchema = z.object({
  accountId: z.number().int().positive(),
  debit: z.string().regex(/^\d+(\.\d{1,4})?$/, "مبلغ المدين غير صالح"),
  credit: z.string().regex(/^\d+(\.\d{1,4})?$/, "مبلغ الدائن غير صالح"),
  notes: z.string().max(500).nullish(),
  customerId: z.number().int().positive().nullish(),
  supplierId: z.number().int().positive().nullish(),
});

const createManualJournalInputSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ القيد يجب أن يكون بصيغة YYYY-MM-DD"),
  branchId: z.number().int().positive().nullish(),
  notes: z.string().min(5, "يجب كتابة بيان للقيد لا يقل عن 5 أحرف").max(1000),
  lines: z.array(manualJournalLineSchema).min(2, "القيد يجب أن يحتوي على سطرين على الأقل"),
});

export const accountsRouter = router({
  /** الشجرة مجموعةً حسب النوع (لعرض الواجهة). */
  tree: reportViewerProcedure.query(() => chartOfAccounts()),

  /** كل الحسابات مسطّحةً مرتّبة. */
  list: reportViewerProcedure.query(() => listAccounts()),

  /** استعراض القيود اليدوية مع سطورها */
  listManualJournals: reportViewerProcedure
    .input(
      z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          branchId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return listManualJournals(input ?? {});
    }),

  /** إنشاء قيد يومية يدوي متوازن مع حوكمة الفترات والترحيل المزدوج */
  createManualJournal: reportsManagerProcedure
    .input(createManualJournalInputSchema)
    .mutation(async ({ input, ctx }) => {
      return withTx(async (tx) => {
        const actorBranchId = input.branchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : 1);
        return createManualJournal(
          tx,
          {
            entryDate: input.entryDate,
            branchId: input.branchId ?? ctx.user.branchId ?? null,
            notes: input.notes,
            lines: input.lines,
          },
          {
            userId: ctx.user.id,
            branchId: actorBranchId,
            role: ctx.user.role as RoleKey,
            isOwner: ctx.user.role === "admin" || (ctx.user as { isOwner?: boolean }).isOwner === true,
          },
          {
            user: ctx.user,
            req: ctx.req,
          },
        );
      });
    }),
});
