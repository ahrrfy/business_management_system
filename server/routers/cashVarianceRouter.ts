import { z } from "zod";
import {
  CASH_VARIANCE_EVENT_TYPES,
  CASH_VARIANCE_EVIDENCE_MAX_BYTES,
  CASH_VARIANCE_EVIDENCE_MIME_TYPES,
  CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH,
  CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH,
  CASH_VARIANCE_REASON_CODES,
  CASH_VARIANCE_REASON_CODES_BY_SOURCE,
} from "../../shared/cashVariance";
import { retryOnDup } from "../lib/retryDup";
import { auditMetadataFromContext } from "../services/auditService";
import {
  approveCashVarianceCase,
  getCashVarianceCase,
  listCashVarianceCases,
  listCashVarianceResponsibleUsers,
  proposeCashVarianceCase,
  registerCashVarianceEvidence,
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
  evidenceDocumentId: id,
  reason: z.string().trim().min(10).max(500),
  evidenceReference: z.string().trim()
    .min(CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH)
    .max(CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH),
  clientRequestId,
} as const;

const proposalInput = z.discriminatedUnion("sourceType", [
  // مسؤول العهدة مشتق حصراً من عقد المصدر؛ رفض الحقل الزائد يمنع إسنادها لغير صاحبها.
  z.object({
    sourceType: z.literal("CUSTODY"),
    reasonCode: z.enum(CASH_VARIANCE_REASON_CODES),
    ...proposalCommon,
  }).strict(),
  // لا يوجد عقد حيازة غير قابل للتلاعب للخزينة اليومية؛ يمنع العقد إسنادها لموظف.
  z.object({
    sourceType: z.literal("DAILY_TREASURY"),
    reasonCode: z.enum(CASH_VARIANCE_REASON_CODES_BY_SOURCE.DAILY_TREASURY),
    ...proposalCommon,
  }).strict(),
]);

/**
 * كل المسارات وراء FULL treasury. الخدمة تعيد فرض الفرع وSOD داخل المعاملة،
 * فلا يعتمد منشئ الحالة أو منفذ العد حتى لو كان Admin.
 */
export const cashVarianceRouter = router({
  registerEvidence: treasuryManagerProcedure
    .input(z.object({
      branchId: id,
      fileName: z.string().trim().min(1).max(255),
      dataUrl: z.string().min(32).max(Math.ceil(CASH_VARIANCE_EVIDENCE_MAX_BYTES / 3) * 4 + 128)
        .refine((value) => CASH_VARIANCE_EVIDENCE_MIME_TYPES.some((mime) => value.startsWith(`data:${mime};base64,`)), "نوع الملف غير مسموح"),
      clientRequestId,
    }))
    .mutation(({ input, ctx }) => retryOnDup(() => registerCashVarianceEvidence(
      input,
      actorOf(ctx),
      auditMetadataFromContext(ctx),
    ))),

  list: treasuryManagerProcedure
    .input(
      z.object({
        branchId: id.optional(),
        status: z.enum(CASH_VARIANCE_EVENT_TYPES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.object({
          createdAt: z.coerce.date(),
          id,
        }).optional(),
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
    .mutation(({ input, ctx }) => retryOnDup(() => proposeCashVarianceCase(
      input, actorOf(ctx), auditMetadataFromContext(ctx),
    ))),

  approve: treasuryManagerProcedure
    .input(decisionInput)
    .mutation(({ input, ctx }) => retryOnDup(() => approveCashVarianceCase(
      input, actorOf(ctx), auditMetadataFromContext(ctx),
    ))),

  reject: treasuryManagerProcedure
    .input(z.object({
      caseId: id,
      expectedVersion: z.number().int().positive(),
      clientRequestId,
      reason: z.string().trim().min(10).max(500),
    }))
    .mutation(({ input, ctx }) => retryOnDup(() => rejectCashVarianceCase(
      input, actorOf(ctx), auditMetadataFromContext(ctx),
    ))),
});
