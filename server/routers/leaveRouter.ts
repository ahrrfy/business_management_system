/* ============================================================================
 * موجّه tRPC للإجازات — وحدة الموارد البشرية (server/routers/leaveRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق.
 * يُركَّب من قائد التكامل تحت المسار trpc.leaves.
 * ========================================================================== */
import { z } from "zod";
import { LEAVE_TYPES } from "@shared/hr";
import { logAudit } from "../services/auditService";
import * as svc from "../services/leaveService";
import { protectedProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const LEAVE_TYPE_KEYS = LEAVE_TYPES.map((t) => t.key) as [string, ...string[]];

export const leaveRouter = router({
  list: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          status: z.enum(["pending", "approved", "rejected"]).optional(),
          type: z.enum(LEAVE_TYPE_KEYS).optional(),
        })
        .optional(),
    )
    .query(({ input }) => svc.listLeaves(input)),

  balances: hrRead.query(() => svc.balances()),

  create: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        leaveType: z.enum(LEAVE_TYPE_KEYS),
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح"),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح"),
        days: z.number().int().positive("عدد الأيام يجب أن يكون أكبر من صفر"),
        reason: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const lv = await svc.createLeave(input as svc.LeaveInput);
      await logAudit(ctx, {
        action: "leave.create",
        entityType: "leaveRequest",
        entityId: lv?.id,
        newValue: { employeeId: input.employeeId, leaveType: input.leaveType, from: input.fromDate, to: input.toDate, days: input.days },
      });
      return lv;
    }),

  decide: hrWrite
    .input(
      z.object({
        id: z.number().int().positive(),
        decision: z.enum(["approved", "rejected"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const lv = await svc.decideLeave(input.id, input.decision, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "leave.decide",
        entityType: "leaveRequest",
        entityId: input.id,
        newValue: { decision: input.decision },
      });
      return lv;
    }),
});
