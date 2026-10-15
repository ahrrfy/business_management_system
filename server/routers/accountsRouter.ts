// شجرة الحسابات والقيود اليومية اليدوية (P0، الدفتر المزدوج والحوكمة المالية الصارمة).
// القيود اليدوية تتبع لحوكمة الإقفال وتدقيق العمليات وفصل المهام المحاسبية.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appErrorMessage } from "@shared/errors";
import { canCrossBranches } from "../lib/branchAuthority";
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
  debit: z.string().regex(/^\d+(\.\d{1,4})?$/, "مبلغ المدين غير صالح"),
  credit: z.string().regex(/^\d+(\.\d{1,4})?$/, "مبلغ الدائن غير صالح"),
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
    .query(async ({ input, ctx }) => {
      const canCross = ctx.canCrossBranches ?? canCrossBranches(ctx.user);
      const userBranchId =
        ctx.scopedBranchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined);
      if (!canCross) {
        if (userBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا يمكن استعراض القيود اليدوية لعدم وجود فرع مسند",
              why: "حسابك غير مرتبط بفرع محدد لعزل استعراض القيود اليدوية.",
              doThis: "قم بإسناد فرع لحسابك من إدارة الموظفين أو راجع مدير النظام.",
            }),
          });
        }
        if (input?.branchId !== undefined && Number(input.branchId) !== userBranchId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا يمكن قراءة قيود فرع آخر",
              why: "صلاحيتك المحاسبية مقيّدة بفرعك المسند.",
              doThis: "اختر فرعك الحالي أو راجع الإدارة العامة.",
            }),
          });
        }
      }
      const effectiveBranchId = canCross ? input?.branchId : userBranchId;
      return listManualJournals({
        ...(input ?? {}),
        branchId: effectiveBranchId,
      });
    }),

  /** إنشاء قيد يومية يدوي متوازن مع حوكمة الفترات والترحيل المزدوج */
  createManualJournal: journalWriteProcedure
    .input(createManualJournalInputSchema)
    .mutation(async ({ input, ctx }) => {
      const canCross = ctx.canCrossBranches ?? canCrossBranches(ctx.user);
      const userBranchId =
        ctx.scopedBranchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
      if (!canCross) {
        if (userBranchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا يمكن تسجيل القيد لعدم وجود فرع مسند",
              why: "المستخدم الحالي غير مرتبط بفرع نظامي محدد لإسناد أثر القيد.",
              doThis: "قم بإسناد فرع لحسابك من إدارة الموظفين أو راجع مدير النظام.",
            }),
          });
        }
        if (input.branchId != null && Number(input.branchId) !== userBranchId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "لا يمكن تسجيل قيد يدوي لفرع آخر",
              why: "صلاحيتك المحاسبية مقيّدة بفرعك المسند ولا تخوّلك الترحيل على فرع آخر.",
              doThis: "سجّل القيد على فرعك الحالي أو راجع الإدارة العامة.",
            }),
          });
        }
      }
      const effectiveBranchId = canCross ? (input.branchId ?? userBranchId ?? null) : userBranchId;
      const actorBranchId = effectiveBranchId ?? (userBranchId ?? 0);
      return withTx(async (tx) => {
        return createManualJournal(
          tx,
          {
            clientRequestId: input.clientRequestId,
            entryDate: input.entryDate,
            branchId: effectiveBranchId,
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
