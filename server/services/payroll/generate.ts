// توليد مسيّر الرواتب الشهري (draft) — الدالّة الذرّية الرئيسية: رأس + بند لكل موظف غير منتهي
// الخدمة (نشط/في إجازة)، بالتقاط تشغيلة العمولات المعتمدة لنفس الشهر، تطبيق المكوّنات القانونية،
// استقطاع السلفة المقترح، وخصم الإجازة بلا راتب (أو نموذج الأجر بالحضور عند تفعيله).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  attendance,
  commissionRunLines,
  commissionRuns,
  employees,
  hrAttendanceSettings,
  leaveRequests,
  payrollItems,
  payrollRuns,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { suggestDeductionsTx } from "../advancesService";
import { computeAttendancePay, DEFAULT_WORK_SCHEDULE, type AttendancePayResult, type WorkSchedule } from "../hr/attendancePay";
import { money, round2, toDbMoney } from "../money";
import { computeLegalComponents, getPayrollLegalSettings } from "../payrollLegalService";
import { applyDuePromotions } from "../promotionService";
import { type Actor, withTx } from "../tx";
import { assertPeriod, computeNet, countDaysWithin, expandSpans, recomputeRunTotals } from "./helpers";
import { getRun } from "./queries";

export async function generatePayroll(period: string, actor: Actor) {
  const p = assertPeriod(period);
  return withTx(async (tx) => {
    // رفض التكرار: مسيّر واحد لكل شهر (القاعدة تفرض UNIQUE أيضاً، نتحقّق مبكراً برسالة عربية).
    const [exists] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(eq(payrollRuns.period, p)).limit(1);
    if (exists) throw new TRPCError({ code: "CONFLICT", message: `يوجد مسيّر رواتب لشهر ${p} بالفعل` });

    // كنسة الترقيات المستحقّة (تدقيق ١٧/٧): تُطبّق الترقيات المعتمَدة المؤجَّلة (effectiveDate مستقبليّ
    // عند الاعتماد) التي بلغ تاريخُها آخرَ يوم في فترة المسيّر — **قبل** قراءة الرواتب أدناه ⇒ تسري
    // الزيادة في شهرها. (لا أثر إن لم توجد ترقياتٌ مستحقّة.)
    const [py, pm] = p.split("-").map(Number);
    const periodEndYmd = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);
    /*
     * حارس الشهر المستقبليّ: `applyDuePromotions` تُطبّق الترقيات المؤجَّلة التي بلغ تاريخُها
     * نهاية الفترة — **بأثرٍ دائم على employees.salary**. فخطأٌ مطبعيّ في الشهر (2027-08 بدل
     * 2026-08) كان يُقدّم زياداتٍ مؤجَّلةً سنةً كاملة، وحذفُ المسودّة لا يتراجع عنها.
     * الشهر الجاري هو أقصى ما يُولَّد؛ ما بعده لا معنى له تشغيلياً أصلاً.
     */
    const currentPeriod = new Date().toISOString().slice(0, 7);
    if (p > currentPeriod) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يُولَّد مسيّر لشهر لم يبدأ بعد (${p}). أقصى شهر متاح: ${currentPeriod}.`,
      });
    }
    await applyDuePromotions(tx, periodEndYmd);

    // كل الموظفين غير منتهي الخدمة (نشطون + في إجازة).
    const emps = await tx
      .select({
        id: employees.id,
        payType: employees.payType,
        salary: employees.salary,
        allowances: employees.allowances,
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
        hireDate: employees.hireDate,
        terminationDate: employees.terminationDate,
        workSchedule: employees.workSchedule,
        attendanceExempt: employees.attendanceExempt,
      })
      .from(employees)
      .where(
        and(
          sql`(${employees.hireDate} IS NULL OR ${employees.hireDate} <= ${periodEndYmd})`,
          sql`(${employees.terminationDate} IS NULL OR ${employees.terminationDate} >= ${`${p}-01`})`,
          sql`(${employees.employmentStatus} <> 'terminated' OR ${employees.terminationDate} IS NOT NULL)`,
        ),
      )
      .orderBy(employees.id);

    // commissions (٦/٧/٢٦): التقاط تشغيلة العمولات **المعتمدة** لنفس الشهر — بند «عمولة» لكل
    // موظف داخل نفس المعاملة (قفل رأس التشغيلة يمنع سباق إلغاء الاعتماد أثناء التوليد).
    // uq_payroll_period + ON DELETE SET NULL على payrollRunId يضمنان الالتقاط مرّة واحدة بالضبط:
    // حذف مسودة المسيّر يفكّ الربط تلقائياً فيلتقطها التوليد التالي بلا ازدواج.
    const [commissionRun] = await tx
      .select()
      .from(commissionRuns)
      .where(and(eq(commissionRuns.period, p), eq(commissionRuns.status, "approved")))
      .for("update");
    const commissionByEmp = new Map<number, Decimal>();
    if (commissionRun) {
      if (commissionRun.payrollRunId != null) {
        // دفاعي — لا يبلغه مسار سليم (مسيّر الشهر فريد والفكّ تلقائي مع حذف مسودته).
        throw new TRPCError({ code: "CONFLICT", message: "تشغيلة العمولات مرتبطة بمسيّر آخر — فكّ الربط أولاً." });
      }
      const cLines = await tx
        .select({ employeeId: commissionRunLines.employeeId, commissionAmount: commissionRunLines.commissionAmount })
        .from(commissionRunLines)
        .where(eq(commissionRunLines.runId, Number(commissionRun.id)));
      for (const l of cLines) commissionByEmp.set(Number(l.employeeId), money(l.commissionAmount));
    }

    // اكتمال التسوية: موظف له سطر عمولة لكنه خارج قائمة التوليد (فُصل بعد أن باع) يُلحق
    // ببند أجرٍ صفري كي تُصرف عمولته المستحقة مرّة واحدة ولا تضيع.
    const listedIds = new Set(emps.map((e) => Number(e.id)));
    const zeroGrossIds = new Set<number>();
    const missingIds = Array.from(commissionByEmp.keys()).filter((id) => money(commissionByEmp.get(id) ?? 0).gt(0) && !listedIds.has(id));
    if (missingIds.length > 0) {
      const extra = await tx
        .select({
          id: employees.id,
          payType: employees.payType,
          salary: employees.salary,
          allowances: employees.allowances,
          firstName: employees.firstName,
          fatherName: employees.fatherName,
          grandfatherName: employees.grandfatherName,
          lastName: employees.lastName,
          hireDate: employees.hireDate,
          terminationDate: employees.terminationDate,
          workSchedule: employees.workSchedule,
          attendanceExempt: employees.attendanceExempt,
        })
        .from(employees)
        .where(inArray(employees.id, missingIds));
      for (const e of extra) {
        zeroGrossIds.add(Number(e.id));
        emps.push(e);
      }
    }

    // الحارس بعد الاكتمال عمداً: منشأة كلُّ من تبقّى فيها مفصولون ذوو عمولات معتمدة
    // يجب أن تستطيع توليد مسيّر تسويتهم (بنود أجرٍ صفري بعمولة) — كان الحارس المبكر يمنعها.
    if (emps.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد موظفون لتوليد مسيّر لهم" });
    }

    // مجاميع حضور الشهر لموظفي الساعة (amount + hours) — مطابقة بادئة YYYY-MM على عمود التاريخ.
    // تصفية على status IN ('PRESENT','LATE') كحارس عميق: حتى لو دخل أمر مالي صفّ ABSENT/LEAVE
    // بمبلغ موجب (سهو/استيراد بصمة/تعديل يدوي قديم) لا يدخل في gross — الأجر لا يدفع عن غياب.
    const attRows = await tx
      .select({
        employeeId: attendance.employeeId,
        sumAmount: sql<string>`COALESCE(SUM(${attendance.amount}), 0)`,
        sumHours: sql<string>`COALESCE(SUM(${attendance.hours}), 0)`,
      })
      .from(attendance)
      .where(sql`DATE_FORMAT(${attendance.attendanceDate}, '%Y-%m') = ${p} AND ${attendance.status} IN ('PRESENT', 'LATE')`)
      .groupBy(attendance.employeeId);
    const attMap = new Map<number, { amount: string; hours: string }>(
      attRows.map((r) => [Number(r.employeeId), { amount: String(r.sumAmount), hours: String(r.sumHours) }]),
    );

    // أيام الإجازة **بلا راتب** المعتمدة المتداخلة مع الشهر، لكل موظف (تدقيق ١٧/٧: كانت لا تُخصَم).
    // التداخل يُحسب بالأيام التقويمية داخل حدود الشهر فقط ⇒ إجازة عابرة للشهور تُخصَم أيامها في شهرها.
    // (الموظف الساعيّ يُخصَم تلقائياً بغياب الحضور؛ الخصم أدناه للشهريّ حصراً.)
    const monthStart = `${p}-01`;

    /*
     * الأجر بالحضور (0138) — معطَّل افتراضياً. عند تفعيله يصير أجرُ الشهريّ محسوباً من
     * ساعات حضوره الفعلية بسعر ساعته (راتبه ÷ ساعات دوامه)، بدل الراتب الثابت بالتناسب.
     * نقرأ الإعداد + أيام الإجازات المعتمدة (مدفوعة/بلا راتب) + ساعات الحضور لكل يوم.
     */
    const [attSettings] = await tx.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
    const attendancePayOn = !!attSettings?.attendancePayEnabled;
    // الجدول العامّ أُلغي (0140): لكل موظف جدولُه، ومن لم يُضبط يقع على ثابت الكود.
    const defaultSchedule = DEFAULT_WORK_SCHEDULE;
    const maxDaily = Number(attSettings?.maxDailyHours ?? 12);
    const payFrom = attSettings?.attendancePayFrom ? String(attSettings.attendancePayFrom) : null;

    // ساعات الحضور لكل (موظف × يوم) — تُستعمل في نموذج الحضور فقط.
    const dailyAttendance = new Map<number, Map<string, Decimal>>();
    if (attendancePayOn) {
      const rows = await tx
        .select({ employeeId: attendance.employeeId, date: attendance.attendanceDate, hours: attendance.hours })
        .from(attendance)
        .where(sql`DATE_FORMAT(${attendance.attendanceDate}, '%Y-%m') = ${p} AND ${attendance.status} IN ('PRESENT', 'LATE')`);
      for (const r of rows) {
        const k = Number(r.employeeId);
        const m = dailyAttendance.get(k) ?? new Map<string, Decimal>();
        m.set(String(r.date).slice(0, 10), money(r.hours ?? 0));
        dailyAttendance.set(k, m);
      }
    }

    // أيام الإجازات المعتمدة **المدفوعة** (بلا راتب تُجلب أدناه مع الفترات).
    const paidLeaveSpans = new Map<number, Array<{ from: string; to: string }>>();
    if (attendancePayOn) {
      const rows = await tx
        .select({ employeeId: leaveRequests.employeeId, fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate })
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.paid, true),
            eq(leaveRequests.status, "approved"),
            sql`${leaveRequests.fromDate} <= LAST_DAY(${monthStart}) AND ${leaveRequests.toDate} >= ${monthStart}`,
          ),
        );
      for (const r of rows) {
        const k = Number(r.employeeId);
        const arr = paidLeaveSpans.get(k) ?? [];
        arr.push({ from: String(r.fromDate), to: String(r.toDate) });
        paidLeaveSpans.set(k, arr);
      }
    }
    /*
     * تُجلب الفترات خاماً (لا SUM في SQL) لأن التقاطع الصحيح ليس مع حدود الشهر وحدها بل مع
     * **نافذة عمل الموظف** داخل الشهر. كان الخصم يُحسب على حدود الشهر فقط ⇒ ازدواج في شهر
     * الفصل/التعيين: موظف عمل ١–٢٠ تموز وأُنهيت خدمته، وله إجازة بلا راتب ٢١–٣١، كان
     * التناسب الوظيفيّ يستبعد أيام ٢١–٣١ أصلاً ثم يُخصم عنها ثانيةً كإجازة.
     */
    const leaveRows = await tx
      .select({
        employeeId: leaveRequests.employeeId,
        fromDate: leaveRequests.fromDate,
        toDate: leaveRequests.toDate,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.paid, false),
          eq(leaveRequests.status, "approved"),
          sql`${leaveRequests.fromDate} <= LAST_DAY(${monthStart}) AND ${leaveRequests.toDate} >= ${monthStart}`,
        ),
      );
    const unpaidLeaveSpans = new Map<number, Array<{ from: string; to: string }>>();
    for (const r of leaveRows) {
      const k = Number(r.employeeId);
      const arr = unpaidLeaveSpans.get(k) ?? [];
      arr.push({ from: String(r.fromDate), to: String(r.toDate) });
      unpaidLeaveSpans.set(k, arr);
    }

    // advances (بند 12ج، ٧/٧): اقتراح استقطاع السلف من أقدم سلفة نشطة لكل موظف —
    // يُملأ advanceDeduction ويدخل **ضمن** deductions (لا فوقها) فيَنقص net تلقائياً.
    const advanceByEmp = await suggestDeductionsTx(tx, emps.map((e) => Number(e.id)));

    // المكوّنات القانونية العراقية (البند ④): إعدادات مفردة تُقرأ مرّة واحدة داخل المعاملة (لقطة).
    // **كل مكوّن معطَّل افتراضياً** ⇒ computeLegalComponents تُعيد صفراً ⇒ صفر أثر على deductions/net
    // (انحدار صفريّ مُثبَت باختبار). النِّسب/الشرائح يضبطها المالك مع محاسبه القانونيّ.
    const legalSettings = await getPayrollLegalSettings(tx);

    // رأس المسيّر (مسودة) — المجاميع تُحدَّث بعد إدراج البنود.
    const runRes = await tx.insert(payrollRuns).values({
      period: p,
      branchId: actor.branchId ?? null,
      status: "draft",
      employeeCount: 0,
      totalGross: "0",
      totalOvertime: "0",
      totalDeductions: "0",
      totalNet: "0",
      createdBy: actor.userId,
    });
    const runId = extractInsertId(runRes);
    const attendancePayByEmp = new Map<number, AttendancePayResult>();

    for (const e of emps) {
      const monthly = e.payType === "monthly";
      const zeroGross = zeroGrossIds.has(Number(e.id));
      let autoOvertime = new Decimal(0);
      /*
       * هل يسلك هذا الموظف مسارَ الحضور؟ بوّابةٌ **لكل موظف** لا عامّة: المُعفى يبقى على
       * المسار الثابت ولو كان الأجر بالحضور مفعَّلاً للشركة — ويلزمه خصمُ الإجازة القديم
       * (قرار المالك: الإجازات تبقى تعمل للمُعفى). البوّابة العامّة كانت تُسقطه عنه.
       */
      const onAttendancePath = monthly && attendancePayOn && !e.attendanceExempt && !zeroGross;
      const periodStart = `${p}-01`;
      const employmentStart = e.hireDate && e.hireDate > periodStart ? e.hireDate : periodStart;
      const employmentEnd = e.terminationDate && e.terminationDate < periodEndYmd ? e.terminationDate : periodEndYmd;
      const activeDays =
        employmentEnd < employmentStart
          ? 0
          : Math.floor(
              (Date.parse(`${employmentEnd}T00:00:00Z`) - Date.parse(`${employmentStart}T00:00:00Z`)) / 86_400_000,
            ) + 1;
      const daysInPeriod = Number(periodEndYmd.slice(8, 10));
      const employmentRatio = new Decimal(activeDays).div(daysInPeriod);
      const allowances = zeroGross ? new Decimal(0) : round2(money(e.allowances ?? 0).times(employmentRatio));
      let gross: Decimal;
      let hours: string | null;
      if (zeroGross) {
        // تسوية نهائية لمفصولٍ ذي عمولة مستحقة — لا راتب، عمولة فقط.
        gross = new Decimal(0);
        hours = null;
      } else if (onAttendancePath) {
        /*
         * نموذج الحضور: الأجر = ساعات الحضور الفعلية × سعر ساعته (راتبه ÷ ساعات دوامه).
         * الغياب بلا أجر، والإجازة المدفوعة يوم دوامٍ كامل، وبلا راتب لا تُحتسب —
         * ولذلك لا يُطبَّق عليه خصمُ الإجازة القديم أدناه (وإلا خُصمت مرّتين).
         */
        const pay = computeAttendancePay({
          salary: money(e.salary ?? 0),
          employmentStart,
          employmentEnd,
          // جدول الموظف الخاصّ يتقدّم على العامّ — والجمعة قد تكون قصيرةً لا راحة.
          schedule: e.workSchedule && typeof e.workSchedule === "object" ? (e.workSchedule as WorkSchedule) : defaultSchedule,
          attendedHoursByDate: dailyAttendance.get(Number(e.id)) ?? new Map(),
          paidLeaveDates: expandSpans(paidLeaveSpans.get(Number(e.id)) ?? [], employmentStart, employmentEnd),
          unpaidLeaveDates: expandSpans(unpaidLeaveSpans.get(Number(e.id)) ?? [], employmentStart, employmentEnd),
          payFrom,
          // حدّا الشهر — شرط منح تعويض الشهر القصير لمن عمله كاملاً.
          monthStart: periodStart,
          monthEnd: periodEndYmd,
          maxDailyHours: maxDaily,
        });
        /*
         * حارس «صفر بصمات شهراً كاملاً» (قرار المالك ٣١/٧): لا أحد يغيب الشهر كلَّه ويبقى
         * موظفاً — هذا ربطٌ ناقص بالجهاز أو جهازٌ معطَّل، لا غياب. والفرق بين الحالتين
         * راتبٌ كامل، فالنظام يتوقّف ويسأل بدل أن يُصفّر صامتاً.
         * المُعفى لا يبلغ هنا أصلاً (مساره الثابت أعلاه).
         *
         * ⚠️ الحارس يصطاد الصفرَ **غيرَ المفسَّر** وحده (Codex P1): مَن كانت كلُّ أيامه إجازةً
         * بلا راتبٍ **معتمدة** صفرُه مقصودٌ وموثَّق (absentDays = 0) — فلو أوقفناه لَعطّل
         * إجازةُ موظفٍ واحدٍ توليدَ مسيّر الشركة كلِّها. وكذلك مَن عمل يوم راحته فقط: له
         * بصماتٌ فعلاً وأجرٌ يُدفع، فليس «بلا جهاز».
         */
        if (
          Number(pay.payableHours) === 0 &&
          Number(pay.restWorkedHours) === 0 &&
          pay.absentDays > 0
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              `الموظف «${fullEmployeeName(e as never)}» بلا أي ساعة حضور في ${p} — وهذا غالباً ربطٌ ناقص بجهاز البصمة لا غياباً. ` +
              `اربطه من بطاقته، أو أشّر «راتب ثابت — لا يخضع للحضور» إن كان بلا جهاز (كالمُلّاك)، ثم أعد التوليد.`,
          });
        }
        attendancePayByEmp.set(Number(e.id), pay);
        gross = round2(money(pay.basePay).plus(allowances));
        hours = pay.payableHours;
        // الساعات فوق المقرَّر اليوميّ تدخل بند «الإضافي» تلقائياً (قرار المالك) لا الأساس.
        autoOvertime = money(pay.overtimePay);
      } else if (monthly) {
        gross = round2(money(e.salary ?? 0).times(employmentRatio).plus(allowances));
        hours = null;
      } else {
        const att = attMap.get(Number(e.id));
        gross = round2(money(att?.amount ?? 0));
        hours = new Decimal(att?.hours ?? 0).toFixed(2);
      }
      const overtime = autoOvertime;
      const commission = commissionByEmp.get(Number(e.id)) ?? new Decimal(0);
      // خصم الإجازة بلا راتب (الشهريّ فقط — الساعيّ يُخصَم بغياب الحضور): المعدّل اليوميّ = الراتب
      // الأساسيّ ÷ ٣٠ (قرار المالك؛ الشائع إقليمياً)، والخصم = المعدّل × أيام الإجازة غير المدفوعة،
      // مقصوصاً عند gross (لا يتجاوز الأجر المكتسَب). يُطوى في deductions، ويُوثَّق في note للشفافية.
      // يُحسب **قبل** استقطاع السلفة كي يُقصّ الأخيرُ عند الأجر المتاح بعد الإجازة (انظر أدناه).
      // أيام الإجازة بلا راتب **داخل نافذة العمل** فقط — ما يقع خارجها استُبعد بالتناسب أصلاً.
      // في نموذج الحضور الخصمُ مطبَّقٌ أصلاً داخل computeAttendancePay (يوم الإجازة بلا
      // راتب لا يُحتسب ساعاته) ⇒ لا يُخصم هنا ثانيةً.
      const unpaidLeaveDays =
        monthly && !zeroGross && !onAttendancePath
          ? countDaysWithin(unpaidLeaveSpans.get(Number(e.id)) ?? [], employmentStart, employmentEnd)
          : 0;
      const dailyRate = round2(money(e.salary ?? 0).div(30));
      /*
       * المعدّل اليوميّ = الراتب ÷ ٣٠ (قرار مالك، الشائع إقليمياً). لكنّ مقام التناسب الوظيفيّ
       * هو أيام الشهر الفعلية، والاختلاف كان يُنتج تناقضاً في الأشهر القصيرة: شباط (٢٨ يوماً)
       * كاملاً بإجازة بلا راتب ⇒ التناسب = ٢٨/٢٨ = ١ فيُدفع الراتب كاملاً، والخصم ٢٨×(الراتب÷٣٠)
       * = ٩٣٪ فقط ⇒ يتقاضى ٧٪ من راتبه عن شهرٍ لم يعمل فيه يوماً واحداً.
       * الحسم: إذا استغرقت الإجازة نافذة العمل كلّها فالخصم = الأجر كاملاً مهما قال المعدّل.
       */
      const fullyOnLeave = activeDays > 0 && unpaidLeaveDays >= activeDays;
      const leaveDeduction = fullyOnLeave
        ? gross
        : unpaidLeaveDays > 0
          ? Decimal.min(round2(dailyRate.times(unpaidLeaveDays)), gross)
          : new Decimal(0);
      const leaveNote = leaveDeduction.gt(0)
        ? fullyOnLeave
          ? `خصم إجازة بلا راتب: ${unpaidLeaveDays} يوم — كامل فترة العمل في الشهر`
          : `خصم إجازة بلا راتب: ${unpaidLeaveDays} يوم (الراتب÷٣٠ = ${toDbMoney(dailyRate)}/يوم)`
        : null;
      // المكوّنات القانونية (البند ④): تُحسب **قبل** استقطاع السلفة كي يُقصّ الأخير عند الأجر المتاح بعدها.
      // معطَّلة افتراضياً ⇒ كلها صفر ⇒ صفر أثر. لا مكوّنات على تسوية المفصول ذي الأجر الصفريّ (نهاية خدمته
      // تُسوّى عند الفصل — لا ازدواج، ولا خصم ضمان/ضريبة على أجرٍ صفريّ).
      // الوعاء الأساسيّ للشهريّ = الراتب الأساس (بلا مخصّصات)، وللساعيّ = أجر الفترة (gross).
      const basicForLegal = monthly ? money(e.salary ?? 0) : gross;
      // Codex P2: ضمان/ضريبة على **الأجر المكتسَب فعلاً بعد الإجازة بلا راتب** لا على الإجماليّ الكامل —
      // (١) لا استقطاع على أجرٍ لم يُكتسَب، و(٢) يمنع تجاوز الاستقطاع للأجر ⇒ net سالباً يتعذّر اعتماده
      // (إجازةٌ تستهلك الشهر كان يُنتج net سالباً). الإجازة تخصّ الشهريّ فقط ⇒ للساعيّ leaveDeduction=0
      // فالوعاء = gross بلا تغيير. صفر إجازة ⇒ earnedGross=gross وearnedBasic=basicForLegal ⇒ صفر انحدار.
      const earnedGross = Decimal.max(0, gross.minus(leaveDeduction));
      const earnedBasic = Decimal.max(0, basicForLegal.minus(leaveDeduction));
      // Codex P2: معدّل نهاية الخدمة اليوميّ من وعاء الأجر لا من e.salary — الساعيّ راتبه 0 لكنه يكتسب
      // gross، فكان استحقاقه يُسجَّل صفراً رغم كسبه. basicForLegal÷٣٠ ⇒ للشهريّ = الراتب÷٣٠ (كما كان)،
      // وللساعيّ = gross÷٣٠. استحقاق نهاية الخدمة التزامٌ تعاقديّ لا يُنقَص بإجازة شهرٍ ⇒ على الوعاء الكامل.
      const eosDailyRate = round2(basicForLegal.div(30));
      const legal = zeroGross
        ? { socialSecurityEmployee: new Decimal(0), socialSecurityEmployer: new Decimal(0), incomeTax: new Decimal(0), endOfServiceAccrual: new Decimal(0) }
        : computeLegalComponents(legalSettings, { basic: earnedBasic, gross: earnedGross, dailyRate: eosDailyRate });
      // حصّتا الموظف القانونيّتان (ضمان الموظف + ضريبة الدخل) استقطاعاتٌ إلزاميّة تُضاف إلى deductions
      // وتسبق السلفة في أولوية استيعاب الأجر. حصّة رب العمل واستحقاق نهاية الخدمة خارج deductions/net.
      const statutoryDeduction = round2(legal.socialSecurityEmployee.plus(legal.incomeTax));

      // advances (بند 12ج): استقطاع السلفة المقترح من أقدم سلفة نشطة، جزءٌ من deductions ابتداءً
      // (يُحرَّر لاحقاً عبر updateItem لكن لا يهبط الاستقطاع الكلي دون جزء السلفة — انظر الحارس هناك).
      // ⚠️ سقف السلامة المالية (حاسم — يمنع خسارة نقدية حقيقية): الاستقطاع لا يتجاوز الأجرَ المتاح
      // لاستيعابه فعلاً = gross + overtime + commission − إجازة − الاستقطاعات القانونية الإلزامية.
      // بدونه: سلفةٌ تفوق الأجر المتاح تُنتج net سالباً فيتخطّى payRun صرفَها النقديّ (net ≤ 0) بينما
      // settleAdvancesOnPayTx تُسوّي **كامل** advanceDeduction ⇒ تُشطَب السلفة بلا استردادٍ نقديّ =
      // خسارة على الشركة. القصّ يضمن net ≥ 0 ⇒ المُسوّى = المُقتطَع فعلاً، وتُستكمَل البقيّة لاحقاً.
      // (حين المكوّنات القانونية معطَّلة statutoryDeduction=0 ⇒ الصيغة مطابقة لما كانت — صفر انحدار.)
      const absorbableWage = Decimal.max(0, round2(gross.plus(overtime).plus(commission).minus(leaveDeduction).minus(statutoryDeduction)));
      const suggestedAdvance = advanceByEmp.get(Number(e.id))?.suggested ?? new Decimal(0);
      const advanceDeduction = round2(Decimal.min(suggestedAdvance, absorbableWage));
      const deductions = round2(advanceDeduction.plus(leaveDeduction).plus(statutoryDeduction));
      const net = computeNet(gross, overtime, commission, deductions);
      await tx.insert(payrollItems).values({
        runId,
        // شفافية الأجر بالحضور: الموظف يرى لماذا نقص أجرُه بالضبط (ساعات/أيام لا مبلغاً غامضاً).
        note: (() => {
          const ap = attendancePayByEmp.get(Number(e.id));
          if (!ap) return leaveNote;
          const parts = [
            `أجر بالحضور: ${ap.payableHours} من ${ap.scheduledHours} ساعة × ${ap.hourlyRate} د.ع/ساعة`,
          ];
          if (ap.absentDays > 0) parts.push(`غياب ${ap.absentDays} يوم`);
          if (ap.unpaidLeaveDays > 0) parts.push(`إجازة بلا راتب ${ap.unpaidLeaveDays} يوم`);
          if (Number(ap.shortHours) > 0) parts.push(`نقص ${ap.shortHours} ساعة`);
          return parts.join(" — ").slice(0, 255);
        })(),
        employeeId: Number(e.id),
        payType: monthly ? "monthly" : "hourly",
        hours,
        gross: toDbMoney(gross),
        // مخصّصات لقطة العرض في القسيمة؛ مضمَّنة أصلاً في gross للشهري (gross = أساسي + مخصّصات).
        allowances: toDbMoney(monthly && !zeroGross ? allowances : 0),
        overtime: toDbMoney(overtime),
        commission: toDbMoney(commission),
        deductions: toDbMoney(deductions),
        advanceDeduction: toDbMoney(advanceDeduction),
        // المكوّنات القانونية (البند ④، لقطة): حصّتا الموظف (ضمان+ضريبة) مُتضمَّنتان في deductions أعلاه؛
        // حصّة رب العمل واستحقاق نهاية الخدمة عرضٌ/التزامٌ فقط (خارج deductions/net). كلها صفر عند التعطيل.
        socialSecurityEmployee: toDbMoney(legal.socialSecurityEmployee),
        incomeTax: toDbMoney(legal.incomeTax),
        socialSecurityEmployer: toDbMoney(legal.socialSecurityEmployer),
        endOfServiceAccrual: toDbMoney(legal.endOfServiceAccrual),
        net: toDbMoney(net),
      });
    }

    await recomputeRunTotals(tx, runId);

    // ربط الالتقاط داخل نفس المعاملة — أثر تدقيقي ثنائي الاتجاه (التشغيلة تعرف مسيّرها).
    if (commissionRun) {
      await tx.update(commissionRuns).set({ payrollRunId: runId }).where(eq(commissionRuns.id, Number(commissionRun.id)));
    }
    return runId;
  }).then((runId) => getRun(runId));
}
