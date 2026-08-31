import { z } from "zod";
import {
  CASH_VARIANCE_EVENT_TYPES,
  CASH_VARIANCE_REASON_CODES,
} from "../../shared/cashVariance";
import { retryOnDup } from "../lib/retryDup";
import { logAudit } from "../services/auditService";
import {
  approveCashVarianceCase,
  getCashVarianceCase,
  listCashVarianceCases,
  listCashVarianceResponsibleUsers,
  proposeCashVarianceCase,
  rejectCashVarianceCase,
} from "../services/cashVarianceService";
import { router, treasuryManagerProcedure } from "../trpc";

const id = z.number().int().positive();
const clientRequestId = z.string().trim().min(8).max(64);

function actorOf(ctx: {
  user: { id: number; branchId: number | null; role: string };
}) {
  return {
    userId: Number(ctx.user.id),
    branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
    role: ctx.user.role,
  };
}

const decisionInput = z.object({
  caseId: id,
  expectedVersion: z.number().int().positive(),
  clientRequestId,
  note: z.string().trim().max(500).nullish(),
});

const proposalCommon = {
  sourceId: id,
  reasonCode: z.enum(CASH_VARIANCE_REASON_CODES),
  reason: z.string().trim().min(10).max(500),
  evidenceReference: z.string().trim().min(3).max(2_000),
  clientRequestId,
} as const;

const proposalInput = z.discriminatedUnion("sourceType", [
  // مسؤول العهدة مشتق حصراً من عقد المصدر؛ رفض الحقل الزائد يمنع إسنادها لغير صاحبها.
  z.object({ sourceType: z.literal("CUSTODY"), ...proposalCommon }).strict(),
  // لا يوجد عقد حيازة غير قابل للتلاعب للخزينة اليومية؛ يمنع العقد إسنادها لموظف.
  z.object({ sourceType: z.literal("DAILY_TREASURY"), ...proposalCommon }).strict(),
]);

/**
 * كل المسارات وراء FULL treasury. الخدمة تعيد فرض الفرع وSOD داخل المعاملة،
 * فلا يعتمد منشئ الحالة أو منفذ العد حتى لو كان Admin.
 */
export const cashVarianceRouter = router({
  list: treasuryManagerProcedure
    .input(
      z.object({
        branchId: id.optional(),
        status: z.enum(CASH_VARIANCE_EVENT_TYPES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }).optional(),
    )
    .query(({ input, ctx }) => listCashVarianceCases(input ?? {}, actorOf(ctx))),

  get: treasuryManagerProcedure
    .input(z.object({ caseId: id }))
    .query(({ input, ctx }) => getCashVarianceCase(input.caseId, actorOf(ctx))),

  responsibleUsers: treasuryManagerProcedure
    .input(z.object({ branchId: id }))
    .query(({ input, ctx }) => listCashVarianceResponsibleUsers(input.branchId, actorOf(ctx))),

  propose: treasuryManagerProcedure
    .input(proposalInput)
    .mutation(async ({ input, ctx }) => {
      const result = await retryOnDup(() => proposeCashVarianceCase(input, actorOf(ctx)));
      await logAudit(ctx, {
        action: "treasury.cash_variance.propose",
        entityType: "cash_variance_case",
        entityId: result.caseId,
        newValue: { sourceType: input.sourceType, sourceId: input.sourceId, reasonCode: input.reasonCode },
      });
      return result;
    }),

  approve: treasuryManagerProcedure
    .input(decisionInput)
    .mutation(async ({ input, ctx }) => {
      const result = await retryOnDup(() => approveCashVarianceCase(input, actorOf(ctx)));
      await logAudit(ctx, {
        action: "treasury.cash_variance.approve",
        entityType: "cash_variance_case",
        entityId: result.caseId,
        newValue: { version: result.version },
      });
      return result;
    }),

  reject: treasuryManagerProcedure
    .input(z.object({
      caseId: id,
      expectedVersion: z.number().int().positive(),
      clientRequestId,
      reason: z.string().trim().min(10).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await retryOnDup(() => rejectCashVarianceCase(input, actorOf(ctx)));
      await logAudit(ctx, {
        action: "treasury.cash_variance.reject",
        entityType: "cash_variance_case",
        entityId: result.caseId,
        newValue: { version: result.version, reason: input.reason },
      });
      return result;
    }),
});
