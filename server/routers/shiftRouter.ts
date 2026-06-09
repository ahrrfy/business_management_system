import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { closeShift, getOpenShift, getShiftReport, openShift } from "../services/shiftService";
import { branchScopedProcedure, cashierProcedure, router } from "../trpc";

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
      // سياسة #14: نمرّر دور الفاعل + فرعه ليفرض closeShift فحص الملكية/الفرع.
      const res = await closeShift(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? -1,
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "shift.close", entityType: "shift", entityId: input.shiftId, newValue: { countedCash: input.countedCash } });
      return res;
    }),

  // §٧ IDOR: كان كاشير من فرع A يستطيع `report` لوردية فرع B بمعرفة shiftId.
  // الآن نفرض ctx.scopedBranchId: إن كانت الوردية في فرع آخر ⇒ FORBIDDEN لغير المرتفعين.
  report: branchScopedProcedure
    .input(z.object({ shiftId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const report = await getShiftReport(input.shiftId);
      if (!report) return null;
      // ctx.scopedBranchId == null للمرتفعين (admin/manager): مرور حر.
      // ctx.scopedBranchId == number لغيرهم: فرض المطابقة.
      const sBranchId = (report as { branchId?: number | null })?.branchId;
      if (ctx.scopedBranchId != null && sBranchId != null && Number(sBranchId) !== ctx.scopedBranchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليس لك صلاحية على ورديات هذا الفرع" });
      }
      return report;
    }),

  // §٧: الكاشير يبقى في فرعه؛ المرتفعون يجوز لهم تمرير branchId لأي فرع. ctx.scopedBranchId
  // أقوى من ctx.user.branchId (يغلق ثغرة إن كان branchId الخام null).
  current: branchScopedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => {
      const effective = ctx.scopedBranchId ?? input.branchId;
      return getOpenShift(ctx.user.id, effective);
    }),
});
