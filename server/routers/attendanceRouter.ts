/* ============================================================================
 * موجّه tRPC للحضور والانصراف — وحدة الموارد البشرية (server/routers/attendanceRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق (logAudit).
 * يُركَّب من قبل قائد التكامل تحت المسار trpc.attendance.
 * ========================================================================== */
import { z } from "zod";
import { logAudit } from "../services/auditService";
import * as svc from "../services/attendanceService";
import { getAttendanceReport } from "../services/reportsHrService";
import { getEmployeeStatement } from "../services/hr/employeeStatement";
import { getMonthlyAttendanceReport } from "../services/hr/monthlyAttendanceReport";
import { branchScopedProcedure, requireModule, router } from "../trpc";

/*
 * عزل الفرع (قرار المالك ١٢/٨) — `branchScopedProcedure` لا `protectedProcedure`:
 * يحقن `ctx.scopedBranchId` (null للأدمن/المالك، وفرعُه المُسنَد لمدير الفرع). كانت الوحدة
 * كلُّها بلا أيّ حاجز فرع فيقرأ مديرُ فرعٍ رواتب موظفي غيره **ويكتب لهم حضوراً** (تدقيق ١٧/٨).
 * الإجراء وحده لا يكفي: كلُّ نقطةٍ أدناه تُمرّر `scopedBranchId` إلى خدمتها، والخدمة تُنفّذ.
 */
const hrRead = branchScopedProcedure.use(requireModule("hr", "READ"));
const hrWrite = branchScopedProcedure.use(requireModule("hr", "FULL"));
/** إعدادات شركيّة لا تخصّ موظفاً: `settings/FULL` = admin وحده (manager=READ). */
const settingsWrite = branchScopedProcedure.use(requireModule("settings", "FULL"));

const periodStr = z.string().regex(/^\d{4}-\d{2}$/, "صيغة الشهر يجب أن تكون YYYY-MM");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ يجب أن تكون YYYY-MM-DD");
const timeStr = z.string().regex(/^\d{1,2}:\d{2}$/, "صيغة الوقت يجب أن تكون HH:MM");

export const attendanceRouter = router({
  list: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          period: periodStr.optional(),
          // مدى تواريخ صريح — الشاشة تفتح على اليوم بقرار المالك، والشهر خيارٌ لا افتراض.
          dateFrom: dateStr.optional(),
          dateTo: dateStr.optional(),
          source: z.enum(["fingerprint", "manual"]).optional(),
          // بحث خادميّ (اسم/تاريخ/يوم) — كان محلّياً على الصفوف المُحمَّلة وحدها.
          q: z.string().trim().min(1).optional(),
          // طابور التصحيح: أيام ينقصها إغلاق (بصمة خروج مفقودة) — تُصحَّح قبل إغلاق الشهر.
          needsReviewOnly: z.boolean().optional(),
          // ترقيم خادميّ: كانت تُحمَّل كل السجلّات المطابقة دفعةً (وبلا شهر = كل التاريخ).
          limit: z.number().int().positive().max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(({ input, ctx }) => svc.listAttendance({ ...input, scopedBranchId: ctx.scopedBranchId })),

  /** إعدادات احتساب الحضور (الوردية الليلية) — قراءة بـhr/READ. */
  settings: hrRead.query(() => svc.getAttendanceSettings()),

  /*
   * مفتاح سياسة أجرٍ **شركيّ** (يشمل الفروع كلَّها): تفعيل الأجر بالحضور وتاريخ سريانه وسقف
   * اليوم والوردية الليلية. كان خلف hr/FULL وحده فيملكه مديرُ فرعٍ — بضغطةٍ يحوّل رواتب
   * الشركة كلّها إلى الاحتساب بالساعات أو يوقفه.
   *
   * البوّابة `settings/FULL` لا `adminProcedure`: التقييد يتحقّق **عبر** خريطة الصلاحيات
   * المشتركة لا بتجاوزها (admin=FULL · manager=READ ⇒ مدير الفرع ممنوع)، فتبقى الخريطة
   * صادقةً وتستطيع الواجهة إخفاء الزرّ بها. وبوّابةُ أدمن خام كانت تُسقط بوّابة الوحدة
   * فيمسكها حارس `authz-guard` بحقّ: «كتابة admin مستجدّة» تُعمي الخريطة عن نفسها.
   */
  updateSettings: settingsWrite
    .input(
      z.object({
        attendancePayEnabled: z.boolean().optional(),
        attendancePayFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        maxDailyHours: z.number().min(1).max(24).optional(),
        nightShiftEnabled: z.boolean().optional(),
        // ساعةُ الفصل ضمن اليوم — ما قبلها يُغلق وردية أمس.
        nightShiftCutoffHour: z.number().int().min(0).max(23).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const row = await svc.updateAttendanceSettings(input, ctx.user.id);
      await logAudit(ctx, {
        action: "attendance.updateSettings",
        entityType: "hrAttendanceSettings",
        entityId: 1,
        newValue: {
          attendancePayEnabled: input.attendancePayEnabled,
          attendancePayFrom: input.attendancePayFrom,
          maxDailyHours: input.maxDailyHours,
          nightShiftEnabled: input.nightShiftEnabled,
          nightShiftCutoffHour: input.nightShiftCutoffHour,
        },
      });
      return row;
    }),

  /** مؤشّرات الشاشة — مجاميع كل المطابق للفلتر (لا الصفحة). تُستدعى بلا q: البطاقات مؤشّر
   *  الشهر/الفلتر، والبحث يُصفّي الجدول وتذييله فقط (سلوك محفوظ). */
  summary: hrRead
    .input(
      z
        .object({
          employeeId: z.number().int().positive().optional(),
          period: periodStr.optional(),
          dateFrom: dateStr.optional(),
          dateTo: dateStr.optional(),
          source: z.enum(["fingerprint", "manual"]).optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) => svc.attendanceSummary({ ...input, scopedBranchId: ctx.scopedBranchId })),

  formOptions: hrRead.query(({ ctx }) => svc.formOptions(ctx.scopedBranchId)),

  monthSummary: hrRead.input(z.object({ period: periodStr })).query(({ input, ctx }) => svc.monthSummary(input.period, ctx.scopedBranchId)),

  /**
   * كشف حضور موظف — صفٌّ لكل يوم (من ← إلى، الساعات، سعر الساعة، أجر اليوم) + المجاميع.
   * يبني على نواة المسيّر نفسها فلا ينحرف المعروض عن المدفوع. قراءة صرفة.
   */
  employeeStatement: hrRead
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        period: periodStr,
        /**
         * حدُّ نهايةٍ صريح — تستعمله شاشةُ إنهاء الخدمة لتعاين أجرَ الشهر الأخير **حتى يوم
         * العمل الأخير** لا حتى نهاية الشهر. بدونه تُقارَن تسويةُ جزءٍ من شهرٍ بأجرِ شهرٍ تامّ.
         * قراءةٌ فقط ولا يُوسّع صلاحية: نفس بوّابة `hrRead` وعزلُ الفرع كما هو.
         */
        employmentEndOverride: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
    )
    .query(({ input, ctx }) => getEmployeeStatement({ ...input, scopedBranchId: ctx.scopedBranchId })),

  /**
   * تقرير الحضور الشهريّ لكل الموظفين — صفٌّ لكل موظف بالمجاميع.
   * يُبنى بنواة المسيّر نفسها فلا ينحرف عن الكشف الفرديّ ولا عن المسيّر.
   */
  monthlyReport: hrRead
    .input(z.object({ period: periodStr, branchId: z.number().int().positive().nullish() }))
    // تضييقٌ لا توسيع: المُقيَّد بفرعه يُفرَض فرعُه مهما أرسل، والعابر (أدمن/مالك) يُصفّي بحرّية.
    .query(({ input, ctx }) =>
      getMonthlyAttendanceReport({ period: input.period, branchId: ctx.scopedBranchId ?? input.branchId ?? null }),
    ),

  /**
   * تقرير الحضور — سجلّات الحضور في نطاق تاريخ + ملخّص. hr/READ **مع عزل الفرع**.
   * كان تعليقٌ هنا يقول «hr/READ لا يحمل عزل فروعٍ أصلاً لأيّ دور» فيُطبّع المخالفة كأنها
   * تصميم — وهي تناقض قرار المالك ١٢/٨. الآن `branchId` تضييقٌ للعابر، ومَن دونه يُفرَض فرعُه.
   */
  report: hrRead
    .input(z.object({
      from: dateStr,
      to: dateStr,
      employeeId: z.number().int().positive().optional(),
      branchId: z.number().int().positive().optional(),
    }))
    .query(({ input, ctx }) =>
      getAttendanceReport({ ...input, branchId: ctx.scopedBranchId ?? input.branchId }),
    ),

  record: hrWrite
    .input(
      z.object({
        employeeId: z.number().int().positive(),
        attendanceDate: dateStr,
        hours: z.number().min(0).max(24),
        checkIn: timeStr.nullish(),
        checkOut: timeStr.nullish(),
        status: z.enum(["PRESENT", "ABSENT", "LATE", "LEAVE"]).optional(),
        // الإدخال العام يدوي حصراً؛ "fingerprint" لا يأتي إلا من تكامل الجهاز الخادمي.
        source: z.literal("manual").optional(),
        notes: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const row = await svc.recordAttendance({
        employeeId: input.employeeId,
        attendanceDate: input.attendanceDate,
        hours: input.hours,
        checkIn: input.checkIn ?? null,
        checkOut: input.checkOut ?? null,
        status: input.status,
        source: "manual",
        notes: input.notes ?? null,
        // فصل مهام: الساعات تتحوّل أجراً مباشرةً ⇒ لا يسجّل أحدٌ ساعات نفسه.
        actor: { userId: ctx.user.id, role: ctx.user.role },
        // عزل الفرع على الكتابة — الخدمة ترفض موظف فرعٍ آخر (لا تصفية صامتة).
        scopedBranchId: ctx.scopedBranchId,
      });
      await logAudit(ctx, {
        action: "attendance.record",
        entityType: "attendance",
        entityId: row?.id,
        newValue: {
          employeeId: input.employeeId,
          date: input.attendanceDate,
          hours: input.hours,
          amount: row?.amount,
          source: "manual",
        },
      });
      return row;
    }),

  /**
   * إعادة احتساب أسعار الشهر من ملفّات الموظفين الحالية — يُصلح اللقطات التي كُتبت قبل
   * ضبط الجداول (أو بعد تعديل راتب). كتابةٌ ماليّة ⇒ hr/FULL + تدقيق + حارس المسيّر المُقفَل.
   */
  recomputeRates: hrWrite
    .input(
      z.object({
        period: z.string().regex(/^\d{4}-\d{2}$/, "الشهر بصيغة YYYY-MM"),
        employeeId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // فصل مهام: سعرُ الساعة قابلٌ للتعديل من بطاقة الموظف ⇒ «ارفع سعرك ثمّ أعد الاحتساب»
      // مسارُ زيادةِ أجرٍ بفاعلٍ واحد لولا هذا التمرير (Codex P1).
      // وعزل الفرع معه: إعادة التسعير تُعيد كتابة مبالغ **كل** صفٍّ مطابق في الشهر.
      const res = await svc.recomputeMonthRates({
        ...input,
        actor: { userId: ctx.user.id, role: ctx.user.role },
        scopedBranchId: ctx.scopedBranchId,
      });
      await logAudit(ctx, {
        action: "attendance.recomputeRates",
        entityType: "attendance",
        newValue: { period: res.period, employeeId: input.employeeId ?? null, scanned: res.scanned, updated: res.updated },
      });
      return res;
    }),
});
