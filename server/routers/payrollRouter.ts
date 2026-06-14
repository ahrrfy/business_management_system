/* ============================================================================
 * موجّه tRPC للرواتب — وحدة الموارد البشرية (server/routers/payrollRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قائد التكامل تحت namespace: trpc.payroll
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import * as svc from "../services/payrollService";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const period = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الشهر يجب أن يكون بصيغة YYYY-MM");

export const payrollRouter = router({
  list: hrRead.query(() => svc.listRuns()),

  get: hrRead
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => svc.getRun(input.id)),

  latest: hrRead.query(() => svc.latestRun()),

  generate: hrWrite
    .input(z.object({ period }))
    .mutation(async ({ input, ctx }) => {
      try {
        const run = await svc.generatePayroll(input.period, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0 });
        await logAudit(ctx, {
          action: "payroll.generate",
          entityType: "payrollRun",
          entityId: run?.id,
          newValue: { period: input.period, employeeCount: run?.employeeCount, totalNet: run?.totalNet },
        });
        return run;
      } catch (err: any) {
        // القيد الفريد على الشهر يحمي من سباق توليد مزدوج.
        if (err?.code === "ER_DUP_ENTRY") throw new TRPCError({ code: "CONFLICT", message: `يوجد مسيّر رواتب لشهر ${input.period} بالفعل` });
        throw err;
      }
    }),

  updateItem: hrWrite
    .input(
      z.object({
        itemId: z.number().int().positive(),
        overtime: moneyStr.nullish(),
        deductions: moneyStr.nullish(),
        note: z.string().trim().max(255).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { itemId, ...rest } = input;
      const run = await svc.updateItem(itemId, rest);
      await logAudit(ctx, {
        action: "payroll.updateItem",
        entityType: "payrollItem",
        entityId: itemId,
        newValue: { overtime: input.overtime ?? null, deductions: input.deductions ?? null },
      });
      return run;
    }),

  approve: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const run = await svc.approveRun(input.id);
      await logAudit(ctx, { action: "payroll.approve", entityType: "payrollRun", entityId: input.id, newValue: { period: run?.period } });
      return run;
    }),

  pay: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const run = await svc.payRun(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0 });
      await logAudit(ctx, { action: "payroll.pay", entityType: "payrollRun", entityId: input.id, newValue: { period: run?.period, totalNet: run?.totalNet } });
      return run;
    }),

  cancel: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.cancelRun(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 0 });
      await logAudit(ctx, { action: "payroll.cancel", entityType: "payrollRun", entityId: input.id, newValue: { status: res.status } });
      return res;
    }),
});
