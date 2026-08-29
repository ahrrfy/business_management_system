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
  getStatutoryGeneralJournal,
  getStatutoryTrialBalance,
} from "../services/accounting/statutoryReports";
import { withTx } from "../services/tx";
import { reportViewerProcedure, reportsAdminProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ YYYY-MM-DD");
const accountType = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);

export const statutoryAccountingRouter = router({
  readiness: reportViewerProcedure.query(() => getStatutoryActivationReadiness()),
  profiles: reportViewerProcedure.query(() => listStatutoryProfiles()),
  detail: reportViewerProcedure
    .input(z.object({ profileId: z.number().int().positive() }))
    .query(({ input }) => getStatutoryProfileDetail(input.profileId)),
  trialBalance: reportViewerProcedure
    .input(
      z.object({
        from: ymd,
        to: ymd,
        profileId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input }) => getStatutoryTrialBalance(input)),
  generalJournal: reportViewerProcedure
    .input(
      z.object({
        from: ymd,
        to: ymd,
        profileId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input }) => getStatutoryGeneralJournal(input)),

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
