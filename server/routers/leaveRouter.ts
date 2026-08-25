/* ============================================================================
 * موجّه tRPC للإجازات — وحدة الموارد البشرية (server/routers/leaveRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق.
 * يُركَّب من قائد التكامل تحت المسار trpc.leaves.
 * ========================================================================== */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { LEAVE_TYPES } from "@shared/hr";
import { employees } from "../../drizzle/schema";
import { createAppNotification } from "../services/appNotificationService";
import { logAudit } from "../services/auditService";
import { requireDb } from "../services/tx";
import * as svc from "../services/leaveService";
import { branchScopedProcedure, requireModule, router } from "../trpc";

/*
 * عزل الفرع (قرار المالك ١٢/٨) — `branchScopedProcedure` يحقن `ctx.scopedBranchId`:
 * null للأدمن/المالك، وفرعُه المُسنَد لمن دونهما. كانت الوحدة بلا أيّ حاجز فرع كأختها
 * الحضور (تدقيق ١٧/٨)، والإجازة **كتابةٌ ماليّة**: المدفوعة يومُ دوامٍ كامل وغيرُ المدفوعة
 * خصمٌ، وكلتاهما تدخلان `computeAttendancePay` ⇒ تغييرُ أجرٍ في مسيّر فرعٍ لا يملكه الفاعل.
 * والإجراء وحده لا يكفي: كلُّ نقطةٍ تُمرّر `scopedBranchId` إلى خدمتها، والخدمة تُنفّذ.
 */
const hrRead = branchScopedProcedure.use(requireModule("hr", "READ"));
const hrWrite = branchScopedProcedure.use(requireModule("hr", "FULL"));

const LEAVE_TYPE_KEYS = LEAVE_TYPES.map((t) => t.key) as [string, ...string[]];
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

/** عدد الأيام (شاملاً الطرفين) بين تاريخين "YYYY-MM-DD" — تقويم UTC ثابت. */
function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.floor(ms / 86_400_000) + 1;
}

/**
 * أيام إجازةٍ [لFrom,لTo] المتقاطعة فعلياً مع شهرٍ "YYYY-MM" — بقصّ بحدود الشهر (نفس نمط
 * `generatePayroll`: LAST_DAY+LEAST/GREATEST، هنا بحساب تاريخٍ نصّي مباشر بدل SQL). إجازة عابرة
 * لشهرين كانت تُضاف بكامل طولها لكلا الشهرين (ازدواج) — الصحيح: أيام التقاطع فقط لكلٍّ.
 */
function daysInMonth(leaveFrom: string, leaveTo: string, monthPrefix: string): number {
  const [my, mm] = monthPrefix.split("-").map(Number);
  const monthStart = `${monthPrefix}-01`;
  const monthEnd = new Date(Date.UTC(my, mm, 0)).toISOString().slice(0, 10); // آخر يوم في الشهر
  const clipFrom = leaveFrom > monthStart ? leaveFrom : monthStart; // GREATEST
  const clipTo = leaveTo < monthEnd ? leaveTo : monthEnd; // LEAST
  return clipFrom > clipTo ? 0 : daysInclusive(clipFrom, clipTo);
}

export const leaveRouter = router({
  /**
   * ترقيم + مدى تاريخ فوق `leaveService.listLeaves` — الخدمة (خارج ملكية هذه الشريحة) لا تدعمهما
   * بعد، فيُطبَّقان هنا على النتيجة الكاملة المفلترة بـemployeeId/status/type (حجم الجدول لا
   * يبرّر بعد ترقيماً على مستوى SQL). `from`/`to`: تداخلٌ مع مدّة الطلب [fromDate,toDate] — نفس
   * منطق فحص التداخل في `createLeave`، لا حصرٌ صارم بالطرفين. المؤشّرات الثلاثة (pending/approved/
   * أيام الشهر) تُحسَب على المجموعة المفلترة **قبل** التقطيع بالصفحة — فتبقى صحيحة عبر كل الصفحات.
   */
  list: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          status: z.enum(["pending", "approved", "rejected"]).optional(),
          type: z.enum(LEAVE_TYPE_KEYS).optional(),
          from: dateStr.optional(),
          to: dateStr.optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const all = await svc.listLeaves({
        employeeId: input?.employeeId,
        status: input?.status,
        type: input?.type,
        scopedBranchId: ctx.scopedBranchId,
      });
      const from = input?.from;
      const to = input?.to;
      const filtered =
        from || to ? all.filter((l) => (!from || l.toDate >= from) && (!to || l.fromDate <= to)) : all;

      const monthPrefix = new Date().toISOString().slice(0, 7);
      const counts = {
        pending: filtered.filter((l) => l.status === "pending").length,
        approved: filtered.filter((l) => l.status === "approved").length,
        // مقصوصة بحدود الشهر — إجازة عابرة لشهرين تُحتسب بأيامها المتقاطعة فقط لا بطولها كاملاً.
        monthDays: filtered
          .filter((l) => l.status === "approved")
          .reduce((s, l) => s + daysInMonth(l.fromDate, l.toDate, monthPrefix), 0),
      };

      const limit = input?.limit ?? 25;
      const offset = input?.offset ?? 0;
      return {
        rows: filtered.slice(offset, offset + limit),
        total: filtered.length,
        hasMore: offset + limit < filtered.length,
        counts,
      };
    }),

  balances: hrRead.query(({ ctx }) => svc.balances(ctx.scopedBranchId)),

  /**
   * تقرير أرصدة الإجازات — لكل موظف نشط: المستخدَم والمعلّق ضمن سنةٍ محدَّدة (افتراضياً السنة
   * الحالية كاملةً — لا «اليوم» ولا نطاقاً ضيّقاً) + الرصيد المتبقي الحالي (سنوية/مرضية).
   * مصدره `leaveService.balances/listLeaves` مباشرةً لا `reportsHrService.getLeaveBalances`
   * (خارج ملكية هذه الشريحة، وسطرها الخام مجموعٌ عبر كل الزمن بلا مدى ولا رصيدٍ متبقٍّ) — بقصّ
   * أيام كل طلب بحدود السنة (نفس نمط `daysInMonth` أعلاه، بمدى سنة بدل شهر).
   */
  balanceReport: hrRead
    .input(z.object({ year: z.number().int().min(2000).max(2100).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const year = input?.year ?? new Date().getUTCFullYear();
      const yearFrom = `${year}-01-01`;
      const yearTo = `${year}-12-31`;
      // الطرفان مُقيَّدان بالفرع معاً — تقييد أحدهما وحده يُنتج صفوفاً بأرصدةٍ بلا أيامها.
      const [emps, leaves] = await Promise.all([
        svc.balances(ctx.scopedBranchId),
        svc.listLeaves({ scopedBranchId: ctx.scopedBranchId }),
      ]);

      const byEmp = new Map<number, { usedDays: number; pendingDays: number }>();
      for (const l of leaves) {
        if (l.status === "rejected") continue;
        const clipFrom = l.fromDate > yearFrom ? l.fromDate : yearFrom;
        const clipTo = l.toDate < yearTo ? l.toDate : yearTo;
        if (clipFrom > clipTo) continue; // لا تقاطع مع السنة المطلوبة إطلاقاً
        const days = daysInclusive(clipFrom, clipTo);
        const acc = byEmp.get(l.employeeId) ?? { usedDays: 0, pendingDays: 0 };
        if (l.status === "approved") acc.usedDays += days;
        else acc.pendingDays += days;
        byEmp.set(l.employeeId, acc);
      }

      const rows = emps
        .map((e) => {
          const agg = byEmp.get(e.id) ?? { usedDays: 0, pendingDays: 0 };
          return {
            employeeId: e.id,
            employeeName: e.name,
            department: e.department,
            usedDays: agg.usedDays,
            pendingDays: agg.pendingDays,
            annualLeaveBalance: e.annualLeaveBalance,
            sickLeaveBalance: e.sickLeaveBalance,
          };
        })
        .sort((a, b) => b.usedDays - a.usedDays || a.employeeId - b.employeeId);

      return { rows, year };
    }),

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
      const lv = await svc.createLeave({ ...input, scopedBranchId: ctx.scopedBranchId } as svc.LeaveInput);
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
      const lv = await svc.decideLeave(input.id, input.decision, { userId: ctx.user.id, scopedBranchId: ctx.scopedBranchId });
      await logAudit(ctx, {
        action: "leave.decide",
        entityType: "leaveRequest",
        entityId: input.id,
        newValue: { decision: input.decision },
      });
      if (lv?.employeeId) {
        const [employee] = await requireDb()
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, Number(lv.employeeId)))
          .limit(1);
        if (employee?.userId) {
          await createAppNotification({
            userId: employee.userId,
            kind: "LEAVE_STATUS",
            title: input.decision === "approved" ? "تمت الموافقة على الإجازة" : "تم تحديث طلب الإجازة",
            body: `${lv.leaveType} · ${lv.fromDate} — ${lv.toDate}`,
            route: "/hr?tab=leaves",
            eventKey: `leave:${input.id}:${input.decision}`,
            entityType: "leaveRequest",
            entityId: input.id,
          }).catch(() => undefined);
        }
      }
      return lv;
    }),

  cancel: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const lv = await svc.cancelLeave(input.id, { userId: ctx.user.id, scopedBranchId: ctx.scopedBranchId });
      await logAudit(ctx, {
        action: "leave.cancel",
        entityType: "leaveRequest",
        entityId: input.id,
        newValue: { status: "rejected", restored: true },
      });
      return lv;
    }),
});
