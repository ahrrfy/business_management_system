import { z } from "zod";
import { logAudit } from "../services/auditService";
import { closeShift, getOpenShift, getShiftReport, openShift } from "../services/shiftService";
import { cashierProcedure, protectedProcedure, router } from "../trpc";

export const shiftRouter = router({
  open: cashierProcedure
    .input(z.object({ branchId: z.number().int().positive(), openingBalance: z.string().default("0") }))
    .mutation(async ({ input, ctx }) => {
      const res = await openShift(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
      await logAudit(ctx, { action: "shift.open", entityType: "shift", entityId: (res as { id?: number })?.id, newValue: { openingBalance: input.openingBalance } });
      return res;
    }),

  close: cashierProcedure
    .input(z.object({ shiftId: z.number().int().positive(), countedCash: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const res = await closeShift(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "shift.close", entityType: "shift", entityId: input.shiftId, newValue: { countedCash: input.countedCash } });
      return res;
    }),

  report: protectedProcedure
    .input(z.object({ shiftId: z.number().int().positive() }))
    .query(({ input }) => getShiftReport(input.shiftId)),

  current: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => getOpenShift(ctx.user.id, ctx.user.branchId ?? input.branchId)),
});
