/**
 * راوتر الإقفال السنوي — reportsAdminProcedure (يقفل فترة + ينشر قيد retained earnings).
 */
import { z } from "zod";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { retryOnDup } from "../lib/retryDup";
import {
  reportsAdminProcedure,
  reportsManagerProcedure,
  router,
} from "../trpc";
import { withGovernanceTx, withTx } from "../services/tx";
import {
  approveYearEndReopen,
  closeYear,
  listSnapshots,
  listYearEndReopenRequests,
  rejectYearEndReopen,
  requestYearEndReopen,
} from "../services/yearEndService";
import { logAuditTx } from "../services/auditService";

export const yearEndRouter = router({
  close: reportsAdminProcedure
    .input(
      z
        .object({
          year: z.number().int().min(2020).max(2100),
          requestId: z.number().int().positive(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const r = await closeYear(tx, {
            year: input.year,
            requestId: input.requestId,
            branchId: null,
            closedBy: ctx.user.id,
          });
          // الإقفال السنوي وأثره التدقيقي وحدةٌ ذرية: فشل سجل التدقيق يُرجع القيد والقفل واللقطة.
          await logAuditTx(tx, ctx, {
            action: "yearEnd.close",
            entityType: "yearEndSnapshot",
            entityId: r.snapshotId,
            newValue: {
              year: r.year,
              branchId: null,
              requestId: input.requestId,
              periodLockId: r.periodLockId,
              certificateId: r.certificateId,
              certificateNumber: r.certificateNumber,
              netProfit: r.netProfit,
            },
          });
          return r;
        }),
      ),
    ),

  list: reportsManagerProcedure
    .input(
      z
        .object({
          year: z.number().int().optional(),
          branchId: z.number().int().nullable().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const rows = await withTx(async (tx) => listSnapshots(tx, input ?? {}));
      return { rows };
    }),

  reopenRequests: reportsManagerProcedure
    .input(
      z
        .object({
          year: z.number().int().min(2020).max(2100).optional(),
          snapshotId: z.number().int().positive().optional(),
          pendingOnly: z.boolean().optional(),
        })
        .strict()
        .optional(),
    )
    .query(async ({ input }) => ({
      rows: await withTx((tx) => listYearEndReopenRequests(tx, input ?? {})),
    })),

  requestReopen: reportsManagerProcedure
    .input(
      z
        .object({
          snapshotId: z.number().int().positive(),
          reason: z.string().trim().min(10).max(500),
          clientRequestId: z.string().trim().min(8).max(64),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        retryOnDup(() =>
          withGovernanceTx(async (tx) => {
            const row = await requestYearEndReopen(tx, {
              ...input,
              requestedBy: ctx.user.id,
            });
            if (!row.replayed) {
              await logAuditTx(tx, ctx, {
                action: "yearEnd.reopen.request",
                entityType: "yearEndReopenRequest",
                entityId: Number(row.id),
                newValue: {
                  snapshotId: Number(row.snapshotId),
                  certificateId: Number(row.certificateId),
                  periodId: Number(row.periodId),
                  year: row.year,
                  status: row.status,
                  requestPayloadHash: row.requestPayloadHash,
                },
              });
            }
            return row;
          }),
        ),
      ),
    ),

  approveReopen: reportsAdminProcedure
    .input(
      z
        .object({
          requestId: z.number().int().positive(),
          decisionReason: z.string().trim().min(5).max(500),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const result = await approveYearEndReopen(tx, {
            ...input,
            decidedBy: ctx.user.id,
          });
          await logAuditTx(tx, ctx, {
            action: "yearEnd.reopen.approve",
            entityType: "yearEndReopenRequest",
            entityId: result.requestId,
            newValue: result,
          });
          return result;
        }),
      ),
    ),

  rejectReopen: reportsAdminProcedure
    .input(
      z
        .object({
          requestId: z.number().int().positive(),
          decisionReason: z.string().trim().min(5).max(500),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) =>
      retryOnDeadlock(() =>
        withGovernanceTx(async (tx) => {
          const result = await rejectYearEndReopen(tx, {
            ...input,
            decidedBy: ctx.user.id,
          });
          await logAuditTx(tx, ctx, {
            action: "yearEnd.reopen.reject",
            entityType: "yearEndReopenRequest",
            entityId: result.requestId,
            newValue: result,
          });
          return result;
        }),
      ),
    ),
});
