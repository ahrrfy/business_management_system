/**
 * راوتر الإقفال السنوي — adminProcedure (يقفل فترة + ينشر قيد retained earnings).
 */
import { z } from "zod";
import { adminProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import { closeYear, listSnapshots } from "../services/yearEndService";
import { logAudit } from "../services/auditService";

export const yearEndRouter = router({
  close: adminProcedure
    .input(
      z.object({
        year: z.number().int().min(2020).max(2100),
        branchId: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const r = await withTx(async (tx) =>
        closeYear(tx, {
          year: input.year,
          branchId: input.branchId ?? null,
          closedBy: ctx.user.id,
        }),
      );
      await logAudit(ctx, {
        action: "yearEnd.close",
        entityType: "yearEndSnapshot",
        entityId: r.snapshotId,
        newValue: {
          year: r.year,
          branchId: r.branchId,
          netProfit: r.netProfit,
        },
      });
      return r;
    }),

  list: adminProcedure
    .input(
      z.object({
        year: z.number().int().optional(),
        branchId: z.number().int().nullable().optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const rows = await withTx(async (tx) => listSnapshots(tx, input ?? {}));
      return { rows };
    }),
});
