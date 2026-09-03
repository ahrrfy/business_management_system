import { z } from "zod";
import {
  MISSED_DAILY_COUNT_EVIDENCE_MAX,
  MISSED_DAILY_COUNT_EVIDENCE_MIN,
  MISSED_DAILY_COUNT_REASON_MAX,
  MISSED_DAILY_COUNT_REASON_MIN,
} from "../../shared/missedDailyCountException";
import {
  decideMissedDailyCountException,
  getMissedDailyCountExceptionContext,
  requestMissedDailyCountException,
} from "../services/cash/missedDailyCountException";
import { auditMetadataFromContext } from "../services/auditService";
import {
  reportViewerProcedure,
  requireModule,
  router,
  treasuryManagerProcedure,
} from "../trpc";

const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const clientRequestIdSchema = z.string().trim().min(1).max(64);
const actorFrom = (user: {
  id: number;
  branchId: number | null;
  role: string;
  isOwner?: boolean | null;
}) => ({
  userId: user.id,
  branchId: user.branchId == null ? -1 : Number(user.branchId),
  role: user.role,
  isOwner: user.isOwner === true,
});

const missedDailyCountRead = reportViewerProcedure.use(
  requireModule("treasury", "READ"),
);

export const missedDailyCountExceptionRouter = router({
  context: missedDailyCountRead
    .input(
      z.object({
        branchId: z.number().int().positive(),
        businessDate: businessDateSchema,
      }),
    )
    .query(({ input, ctx }) =>
      getMissedDailyCountExceptionContext(input, actorFrom(ctx.user)),
    ),

  request: treasuryManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        businessDate: businessDateSchema,
        carryForwardReconciliationId: z.number().int().positive(),
        reason: z
          .string()
          .trim()
          .min(MISSED_DAILY_COUNT_REASON_MIN)
          .max(MISSED_DAILY_COUNT_REASON_MAX),
        evidenceReference: z
          .string()
          .trim()
          .min(MISSED_DAILY_COUNT_EVIDENCE_MIN)
          .max(MISSED_DAILY_COUNT_EVIDENCE_MAX),
        clientRequestId: clientRequestIdSchema,
      }),
    )
    .mutation(({ input, ctx }) =>
      requestMissedDailyCountException(
        input,
        actorFrom(ctx.user),
        auditMetadataFromContext(ctx),
      ),
    ),

  decide: treasuryManagerProcedure
    .input(
      z.object({
        exceptionId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        decision: z.enum(["APPROVED", "REJECTED"]),
        note: z.string().trim().min(10).max(500),
        clientRequestId: clientRequestIdSchema,
      }),
    )
    .mutation(({ input, ctx }) =>
      decideMissedDailyCountException(
        input,
        actorFrom(ctx.user),
        auditMetadataFromContext(ctx),
      ),
    ),
});
