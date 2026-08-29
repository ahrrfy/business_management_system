import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAuditTx } from "../services/auditService";
import {
  approveStatutoryProfile,
  createStatutoryProfile,
  getStatutoryActivationReadiness,
  getStatutoryProfileDetail,
  listStatutoryProfiles,
  replaceStatutoryAccounts,
  replaceStatutoryMappings,
} from "../services/accounting/statutoryAccounting";
import {
  getStatutoryAccountLedger,
  getStatutoryAccountLedgerExport,
  getStatutoryAccountantPack,
  getStatutoryBalanceSheet,
  getStatutoryGeneralJournal,
  getStatutoryIncomeStatement,
  getStatutoryTrialBalance,
} from "../services/accounting/statutoryReports";
import { companyBranchScope } from "../services/companyBranchScope";
import { withTx } from "../services/tx";
import { reportViewerProcedure, reportsAdminProcedure, router } from "../trpc";

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "التاريخ غير صالح تقويمياً");
const hasExclusiveProfileSelection = (value: {
  profileId?: number;
  profileScope?: "ACTIVE" | "ALL_APPROVED";
}) => !(value.profileId != null && value.profileScope != null);
const reportPeriod = z
  .object({
    from: ymd,
    to: ymd,
    profileId: z.number().int().positive().optional(),
    profileScope: z.enum(["ACTIVE", "ALL_APPROVED"]).optional(),
  })
  .refine((value) => value.from <= value.to, {
    path: ["to"],
    message: "تاريخ النهاية يجب ألا يسبق البداية",
  })
  .refine(hasExclusiveProfileSelection, {
    path: ["profileScope"],
    message: "لا يمكن جمع profileId مع profileScope",
  });
const accountType = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
const accountLedgerPeriod = z
  .object({
    from: ymd,
    to: ymd,
    accountId: z.number().int().positive(),
    profileId: z.number().int().positive().optional(),
  })
  .refine((value) => value.from <= value.to, {
    path: ["to"],
    message: "تاريخ النهاية يجب ألا يسبق البداية",
  });
const journalPeriod = z
  .object({
    from: ymd,
    to: ymd,
    profileId: z.number().int().positive().optional(),
    profileScope: z.enum(["ACTIVE", "ALL_APPROVED"]).optional(),
  })
  .refine((value) => value.from <= value.to, {
    path: ["to"],
    message: "تاريخ النهاية يجب ألا يسبق البداية",
  })
  .refine(hasExclusiveProfileSelection, {
    path: ["profileScope"],
    message: "لا يمكن جمع profileId مع profileScope",
  });

const STATUTORY_EXPORT_ROW_LIMIT = 10_000;

export function requireCompleteExport<
  T extends { available: true; pagination: { hasMore: boolean } },
>(report: T, entityLabel: string) {
  if (report.pagination.hasMore) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `${entityLabel} يتجاوز ${STATUTORY_EXPORT_ROW_LIMIT.toLocaleString("en-US")} سطر؛ قسّم الفترة ثم أعد التصدير.`,
    });
  }
  return {
    ...report,
    export: { complete: true as const, rowLimit: STATUTORY_EXPORT_ROW_LIMIT },
  };
}

export const statutoryAccountingRouter = router({
  readiness: reportViewerProcedure.query(() => getStatutoryActivationReadiness()),
  profiles: reportViewerProcedure.query(() => listStatutoryProfiles()),
  detail: reportViewerProcedure
    .input(z.object({ profileId: z.number().int().positive() }))
    .query(({ input }) => getStatutoryProfileDetail(input.profileId)),
  trialBalance: reportViewerProcedure
    .input(reportPeriod)
    .query(({ input, ctx }) =>
      getStatutoryTrialBalance({ ...input, branchId: companyBranchScope(ctx.user).branchId }),
    ),
  incomeStatement: reportViewerProcedure
    .input(reportPeriod)
    .query(({ input, ctx }) =>
      getStatutoryIncomeStatement({ ...input, branchId: companyBranchScope(ctx.user).branchId }),
    ),
  balanceSheet: reportViewerProcedure
    .input(
      z.object({
        asOf: ymd,
        profileId: z.number().int().positive().optional(),
        profileScope: z.enum(["ACTIVE", "ALL_APPROVED"]).optional(),
      }).refine(hasExclusiveProfileSelection, {
        path: ["profileScope"],
        message: "لا يمكن جمع profileId مع profileScope",
      }),
    )
    .query(({ input, ctx }) =>
      getStatutoryBalanceSheet({ ...input, branchId: companyBranchScope(ctx.user).branchId }),
    ),
  accountLedger: reportViewerProcedure
    .input(
      z.intersection(accountLedgerPeriod, z.object({
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })),
    )
    .query(({ input, ctx }) =>
      getStatutoryAccountLedger({ ...input, branchId: companyBranchScope(ctx.user).branchId }),
    ),
  accountLedgerExport: reportViewerProcedure
    .input(accountLedgerPeriod)
    .query(async ({ input, ctx }) => {
      const report = await getStatutoryAccountLedgerExport({
        ...input,
        branchId: companyBranchScope(ctx.user).branchId,
      });
      if (!report.available) return report;
      return requireCompleteExport(report, "كشف الحساب");
    }),
  generalJournal: reportViewerProcedure
    .input(
      z.intersection(journalPeriod, z.object({
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })),
    )
    .query(({ input, ctx }) =>
      getStatutoryGeneralJournal({ ...input, branchId: companyBranchScope(ctx.user).branchId }),
    ),
  accountantPack: reportViewerProcedure
    .input(
      z.object({ from: ymd, to: ymd }).refine((value) => value.from <= value.to, {
        path: ["to"],
        message: "تاريخ النهاية يجب ألا يسبق البداية",
      }),
    )
    .query(({ input, ctx }) =>
      getStatutoryAccountantPack({
        ...input,
        branchId: companyBranchScope(ctx.user).branchId,
      }),
    ),

  createProfile: reportsAdminProcedure
    .input(
      z.object({
        profileKey: z.string().trim().min(2).max(64),
        version: z.number().int().positive(),
        name: z.string().trim().min(3).max(160),
        authorityReference: z.string().trim().min(3).max(255),
        effectiveFrom: ymd,
      }),
    )
    .mutation(({ input, ctx }) =>
      withTx(async (tx) => {
        const result = await createStatutoryProfile(tx, input, ctx.user.id);
        await logAuditTx(tx, ctx, {
          action: "statutory.profile.create",
          entityType: "statutoryAccountingProfile",
          entityId: result.id,
          newValue: input,
        });
        return result;
      }),
    ),

  replaceAccounts: reportsAdminProcedure
    .input(
      z.object({
        profileId: z.number().int().positive(),
        accounts: z
          .array(
            z.object({
              code: z.string().trim().min(1).max(30),
              name: z.string().trim().min(2).max(160),
              type: accountType,
              normalBalance: z.enum(["DEBIT", "CREDIT"]),
              parentCode: z.string().trim().max(30).nullish(),
              isPosting: z.boolean().optional(),
              sortOrder: z.number().int().min(0).optional(),
              notes: z.string().trim().max(500).nullish(),
            }),
          )
          .min(1)
          .max(1500),
      }),
    )
    .mutation(({ input, ctx }) =>
      withTx(async (tx) => {
        const result = await replaceStatutoryAccounts(tx, input.profileId, input.accounts);
        await logAuditTx(tx, ctx, {
          action: "statutory.accounts.replace",
          entityType: "statutoryAccountingProfile",
          entityId: input.profileId,
          newValue: { imported: result.imported },
        });
        return result;
      }),
    ),

  replaceMappings: reportsAdminProcedure
    .input(
      z.object({
        profileId: z.number().int().positive(),
        mappings: z
          .array(
            z.object({
              internalAccountId: z.number().int().positive(),
              statutoryAccountId: z.number().int().positive(),
              rationale: z.string().trim().max(500).nullish(),
            }),
          )
          .max(1500),
      }),
    )
    .mutation(({ input, ctx }) =>
      withTx(async (tx) => {
        const result = await replaceStatutoryMappings(
          tx,
          input.profileId,
          input.mappings,
          ctx.user.id,
        );
        await logAuditTx(tx, ctx, {
          action: "statutory.mappings.replace",
          entityType: "statutoryAccountingProfile",
          entityId: input.profileId,
          newValue: { mapped: result.mapped },
        });
        return result;
      }),
    ),

  approveProfile: reportsAdminProcedure
    .input(
      z.object({
        profileId: z.number().int().positive(),
        accountantName: z.string().trim().min(3).max(150),
        approvalReference: z.string().trim().min(3).max(255),
      }),
    )
    .mutation(({ input, ctx }) =>
      withTx(async (tx) => {
        const result = await approveStatutoryProfile(tx, input, ctx.user.id);
        await logAuditTx(tx, ctx, {
          action: "statutory.profile.approve",
          entityType: "statutoryAccountingProfile",
          entityId: input.profileId,
          newValue: {
            accountantName: input.accountantName,
            approvalReference: input.approvalReference,
            contentHash: result.contentHash,
          },
        });
        return result;
      }),
    ),
});
