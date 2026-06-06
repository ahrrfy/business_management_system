import { z } from "zod";
import { closeShift, getOpenShift, getShiftReport, openShift } from "../services/shiftService";
import { protectedProcedure, router } from "../trpc";

export const shiftRouter = router({
  open: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive(), openingBalance: z.string().default("0") }))
    .mutation(({ input, ctx }) => openShift(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId })),

  close: protectedProcedure
    .input(z.object({ shiftId: z.number().int().positive(), countedCash: z.string() }))
    .mutation(({ input, ctx }) => closeShift(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),

  report: protectedProcedure
    .input(z.object({ shiftId: z.number().int().positive() }))
    .query(({ input }) => getShiftReport(input.shiftId)),

  current: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => getOpenShift(ctx.user.id, ctx.user.branchId ?? input.branchId)),
});
