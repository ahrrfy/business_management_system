// شجرة الحسابات والقيود اليومية اليدوية (P0، الدفتر المزدوج والحوكمة المالية الصارمة).
// القيود اليدوية تتبع لحوكمة الإقفال وتدقيق العمليات وفصل المهام المحاسبية.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { chartOfAccounts, listAccounts } from "../services/accountsService";
import {
  createManualJournal,
  listManualJournals,
} from "../services/accounting/manualJournalService";
import { journalWriteProcedure, reportViewerProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import type { RoleKey } from "@shared/permissions";

const manualJournalLineSchema = z.object({
  accountId: z.number().int().positive(),
  debit: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ المدين غير صالح: الحد الأقصى منزلتان عشريتان"),
  credit: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ الدائن غير صالح: الحد الأقصى منزلتان عشريتان"),
  customerId: z.number().int().positive().nullish(),
  supplierId: z.number().int().positive().nullish(),
});

const createManualJournalInputSchema = z.object({
  clientRequestId: z.string().max(80).optional(),
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
          search: z.string().max(100).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      return listManualJournals(input ?? {});
    }),

  /** إنشاء قيد يومية يدوي متوازن مع حوكمة الفترات والترحيل المزدوج */
  createManualJournal: journalWriteProcedure
    .input(createManualJournalInputSchema)
    .mutation(async ({ input, ctx }) => {
      const isOwnerOrAdmin =
        ctx.user.role === "admin" || (ctx.user as { isOwner?: boolean }).isOwner === true;
      if (!isOwnerOrAdmin && ctx.user.branchId != null && input.branchId != null) {
        if (Number(input.branchId) !== Number(ctx.user.branchId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "ترحيل القيد اليدوي على فرع آخر محظور",
              why: "حساب المستخدم مسند إلى فرع محدد ولا يملك صلاحية إدارة عامة لترحيل قيود على دفاتر الفروع الأخرى.",
              doThis: "اختر الفرع المسند إليك أو اطلب من المدير العام تنفيذ القيد بين الفروع.",
            }),
          });
        }
      }
      return withTx(async (tx) => {
        const actorBranchId = input.branchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : 1);
        return createManualJournal(
          tx,
          {
            clientRequestId: input.clientRequestId,
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
