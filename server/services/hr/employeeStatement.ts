/* ============================================================================
 * كشف حضور الموظف — صفٌّ لكل يوم (server/services/hr/employeeStatement.ts)
 *
 * قرار المالك (٣١/٧): «أريد لكل يوم ساعاته من ساعة إلى ساعة وأجر الساعة لهذا اليوم»،
 * و«المجموع التراكميّ لأيام الشهر هو الراتب الذي يستحقّه».
 *
 * يُعيد الكشف نفسه الذي يبني عليه المسيّر — **بنفس النواة** (`computeAttendancePay`)
 * لا بحسابٍ مستقلّ، فلا ينحرف المعروض عن المدفوع. وهذه قراءة صرفة: لا تكتب شيئاً
 * ولا تلمس مسيّراً، فيصلح للمراجعة قبل التوليد وبعده.
 *
 * ⛔ **الشهر المصروف مجمَّد** (قرار المالك ١٧/٨/٢٦): متى صار لشهرٍ مسيّرٌ **معتمدٌ أو
 * مدفوع**، لم يعد الكشف يشتقّ رقمه من الراتب والجدول والإعدادات **الحاليّة** — يقرأ
 * **لقطة بند المسيّر** كما كُتبت. وإلّا فترقيةُ راتبٍ في أيلول تُغيّر رقم آب المصروف
 * أثراً رجعياً، وهذا الكشف يُطبَع ويُصدَّر ويُرسَل للموظف على واتساب ⇒ رقمٌ يخالف ما
 * قبضه بيده. النواةُ تبقى تعمل: صفوفُ الأيام تشرح **كيف** حُسِب، واللقطة تحكم **بكم**.
 * ========================================================================== */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  attendance,
  employees,
  hrAttendanceSettings,
  leaveRequests,
  branches,
  payrollItems,
  payrollRuns,
} from "../../../drizzle/schema";
import { fullEmployeeName } from "@shared/hr";
import {
  attendanceHoursViolation,
  computeSessionsSummary,
  hasMalformedAttendanceSessionsTag,
  hasUnclosedAttendancePunch,
  HOURS_SPAN_TOLERANCE,
  parseAttendanceDayDetails,
} from "@shared/attendanceHours";
import { requireDb } from "../tx";
import type { Tx } from "../../db";

/** قارئٌ موحَّد: اتصالٌ عاديّ أو معاملةٌ جارية — كلاهما يدعم نفس بنّاءات الاستعلام. */
type Reader = Tx | ReturnType<typeof requireDb>;
export type EmployeeStatementEmployeeSnapshot = typeof employees.$inferSelect & { branchName: string | null };
export type EmployeeStatementPayrollRunSnapshot = Pick<
  typeof payrollRuns.$inferSelect,
  "id" | "status" | "revisionNo" | "approvedAt" | "paidAt"
>;
import { money, round2 } from "../money";
import { isLegacyAutoLateDeduction, projectAttendanceWage } from "../attendanceService";
import {
  computeAttendancePay,
  daysBetween,
  DEFAULT_WORK_SCHEDULE,
  type WorkSchedule,
} from "./attendancePay";

export interface EmployeeStatementInput {
  employeeId: number;
  /** الشهر "YYYY-MM" — الكشف يغطّيه كاملاً مقصوصاً بنافذة عمل الموظف. */
  period: string;
  /**
   * عزل الفرع (قرار المالك ١٢/٨): رقمٌ = يُرفَض موظفُ فرعٍ آخر، null = عبورٌ (أدمن/مالك).
   * الكشف يعرض الراتب وسعر الساعة وأجر كل يوم ⇒ تسريبُه بين الفروع تسريبُ رواتب.
   */
  scopedBranchId?: number | null;
  /**
   * معاملةٌ جارية (اختياري) — للقراءة **داخل** معاملة الكاتب لا خارجها. تحتاجه تسويةُ نهاية
   * الخدمة: تُطابق الأجر المُدخَل يدوياً بما يقوله المحرّك **لحظة الالتزام**، وقراءةٌ خارج
   * المعاملة قد ترى حالةً غير التي ستُثبَّت. غيابه ⇒ القراءة العادية (`requireDb`).
   */
  tx?: Tx;
  /** مدخلات حية قفلها المستهلك قبل النداء؛ يمنع إعادة قراءة الموظف من RR snapshot قديم. */
  employeeSnapshot?: EmployeeStatementEmployeeSnapshot;
  /** رأس الشهر المقفول حالياً، أو null مؤكدة عند غيابه. undefined يبقي سلوك التقارير القديم. */
  payrollRunSnapshot?: EmployeeStatementPayrollRunSnapshot | null;
  /** قراءات حالية fail-closed لمصادر الأجر؛ لا تُفعّل إلا داخل معاملة قرار مالي. */
  lockFinancialInputs?: boolean;
  /**
   * يبني إسقاطاً محافظاً مستقلاً لحد السلفة: يستبعد مساهمة صفوف الحضور غير المحسومة،
   * ولا يغيّر `amountDue` أو لقطة المسيّر أو كشف الموظف المعتاد.
   */
  confirmedAttendanceOnly?: boolean;
  /**
   * حدُّ نهايةٍ صريح (YYYY-MM-DD) يقصّ نافذة العمل — لتسوية نهاية الخدمة **قبل** أن يُضبط
   * `employees.terminationDate` (الإنشاء مرحلةٌ سابقة للإكمال). بدونه يُحسب الشهر كاملاً
   * فيُقارَن أجرُ شهرٍ تامّ بأجرِ جزءٍ منه ⇒ انحرافٌ كاذبٌ لكل تسوية.
   */
  employmentEndOverride?: string | null;
}

/**
 * وقت البصم كـ"HH:MM". عمودا checkIn/checkOut من نوع timestamp ⇒ يعيدهما السائق كـDate،
 * فعرضُهما خاماً يُظهر تاريخاً كاملاً **بإزاحة منطقة زمنية** (08:00 المخزَّنة تظهر 11:00).
 * نقرأ الساعة بتقويم UTC ثابت — البصمات توقيتُ حائطٍ محليّ لا لحظةٌ عالمية (§businessDay).
 */
function hhmm(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const s = String(v);
  return s.length >= 16 ? s.slice(11, 16) : s;
}

function dateYmdOfTimestamp(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/** أساس رقم المستحقّ المعروض. `payrollSnapshot` يعني: الشهر صُرف والرقم مجمَّد. */
export type StatementDueBasis = "hourly" | "exempt" | "attendance" | "fixedSalary" | "payrollSnapshot";

/**
 * لقطةُ بند المسيّر لهذا الموظف في هذا الشهر — أو `null` إن لم يُصرف الشهر بعد.
 *
 * **المسوّدة لا تُجمّد**: ما زالت تُحذف وتُعاد وتُعدَّل، فتجميدُها يُثبّت رقماً مؤقّتاً
 * ويُخفي أثرَ تصحيح بصمةٍ قبل الاعتماد — وهو عين ما نريد أن يُرى. والملغى كذلك: لا يُصرف.
 *
 * ومراجعةُ المسيّر (`revisionNo`) تُرفَع عند عكس الاعتماد وإعادته، ويبقى بندُ المراجعة
 * القديمة مخزَّناً ⇒ نأخذ **بند مراجعة الرأس الحالية**؛ وإن غابت (انجرافُ بيانات) نأخذ
 * أعلى مراجعةٍ موجودة بدل أن نُرجع `null` فيعود الرقم إلى الاشتقاق الحيّ صامتاً.
 */
async function loadPayrollSnapshot(
  db: Reader,
  employeeId: number,
  period: string,
  options: {
    runSnapshot?: EmployeeStatementPayrollRunSnapshot | null;
    lockFinancialInputs?: boolean;
  } = {},
) {
  const runQuery = db
    .select({
      id: payrollRuns.id,
      status: payrollRuns.status,
      revisionNo: payrollRuns.revisionNo,
      approvedAt: payrollRuns.approvedAt,
      paidAt: payrollRuns.paidAt,
    })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.period, period), inArray(payrollRuns.status, ["approved", "paid"])));
  const runRows = options.runSnapshot !== undefined
    ? null
    : options.lockFinancialInputs
      ? await runQuery.for("share", { noWait: true }).limit(1)
      : await runQuery.limit(1);
  const run = options.runSnapshot !== undefined ? options.runSnapshot : (runRows?.[0] ?? null);
  if (!run || (run.status !== "approved" && run.status !== "paid")) return null;

  const itemQuery = db
    .select({
      revisionNo: payrollItems.revisionNo,
      payType: payrollItems.payType,
      hours: payrollItems.hours,
      gross: payrollItems.gross,
      allowances: payrollItems.allowances,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      deductions: payrollItems.deductions,
      advanceDeduction: payrollItems.advanceDeduction,
      net: payrollItems.net,
      note: payrollItems.note,
    })
    .from(payrollItems)
    .where(and(eq(payrollItems.runId, Number(run.id)), eq(payrollItems.employeeId, employeeId)))
    .orderBy(desc(payrollItems.revisionNo));
  const items = options.lockFinancialInputs
    ? await itemQuery.for("share", { noWait: true })
    : await itemQuery;
  const item = items.find((i) => Number(i.revisionNo) === Number(run.revisionNo)) ?? items[0];
  // موظفٌ خارج المسيّر (عُيّن بعد اعتماده مثلاً) ⇒ لا لقطة له، والاشتقاق الحيّ هو الصحيح.
  if (!item) return null;

  return {
    runId: Number(run.id),
    status: String(run.status) as "approved" | "paid",
    revisionNo: Number(item.revisionNo),
    approvedAt: run.approvedAt ?? null,
    paidAt: run.paidAt ?? null,
    payType: item.payType,
    hours: item.hours ?? null,
    gross: item.gross,
    allowances: item.allowances,
    overtime: item.overtime,
    commission: item.commission,
    deductions: item.deductions,
    advanceDeduction: item.advanceDeduction,
    net: item.net,
    note: item.note ?? null,
  };
}

/** يفرد فترات الإجازة إلى تواريخ داخل نافذة. */
function expand(spans: Array<{ from: string; to: string }>, from: string, to: string): Set<string> {
  const out = new Set<string>();
  for (const s of spans) {
    const a = s.from > from ? s.from : from;
    const b = s.to < to ? s.to : to;
    for (const d of daysBetween(a, b)) out.add(d);
  }
  return out;
}

export async function getEmployeeStatement(input: EmployeeStatementInput) {
  if (
    input.lockFinancialInputs &&
    (!input.tx || !input.employeeSnapshot || input.payrollRunSnapshot === undefined)
  ) {
    throw new Error("lockFinancialInputs requires tx and prelocked employee/payroll snapshots");
  }
  const db: Reader = input.tx ?? requireDb();
  const p = input.period;
  const monthStart = `${p}-01`;
  const [py, pm] = p.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);

  const selectEmp = () =>
    db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        fatherName: employees.fatherName,
        grandfatherName: employees.grandfatherName,
        lastName: employees.lastName,
        position: employees.position,
        department: employees.department,
        payType: employees.payType,
        salary: employees.salary,
        allowances: employees.allowances,
        hireDate: employees.hireDate,
        terminationDate: employees.terminationDate,
        workSchedule: employees.workSchedule,
        dayRates: employees.dayRates,
        attendanceExempt: employees.attendanceExempt,
        branchId: employees.branchId,
        branchName: branches.name,
      })
      .from(employees)
      .leftJoin(branches, eq(employees.branchId, branches.id))
      .where(eq(employees.id, input.employeeId))
      .limit(1);

  let emp: Awaited<ReturnType<typeof selectEmp>>[number] | EmployeeStatementEmployeeSnapshot | undefined;
  if (input.employeeSnapshot) {
    // اسم الفرع وصفي فقط؛ لا نقفل branches بعد الموظف لأن كتّاباً قديمين يرتبون branch→employee.
    const [branch] = input.employeeSnapshot.branchId == null
      ? []
      : await db
          .select({ name: branches.name })
          .from(branches)
          .where(eq(branches.id, input.employeeSnapshot.branchId))
          .limit(1);
    emp = { ...input.employeeSnapshot, branchName: branch?.name ?? input.employeeSnapshot.branchName };
  } else {
    [emp] = await selectEmp();
  }
  if (!emp) return null;
  /*
   * عزل الفرع: **رفضٌ صريح** لا تصفيةٌ صامتة — الطلب يحمل معرّفاً بعينه، فإعادة `null`
   * تُقرأ «لا موظف بهذا المعرّف» وتُخفي المحاولة. الرفض يُظهرها في السجلّ.
   */
  if (input.scopedBranchId != null && Number(emp.branchId) !== Number(input.scopedBranchId)) {
    throw new Error("هذا الموظف من فرعٍ آخر — لا صلاحية لك على كشف حضوره");
  }

  // نافذة عمله داخل الشهر. employmentEndOverride هو حد «حتى اليوم» في حاسبة السلفة؛
  // يجب أن يقيّد صفوف الحضور نفسها لا أيام الجدول فقط، وإلا دخل حضور مستقبلي مؤرخ مسبقاً.
  const employmentStart = emp.hireDate && emp.hireDate > monthStart ? String(emp.hireDate) : monthStart;
  const employmentEnd = [monthEnd, emp.terminationDate ? String(emp.terminationDate) : null, input.employmentEndOverride || null]
    .filter((d): d is string => !!d)
    .reduce((a, b) => (b < a ? b : a));

  const selectAttRows = () =>
    db
      .select({
        date: attendance.attendanceDate,
        hours: attendance.hours,
        amount: attendance.amount,
        hourlyRate: attendance.hourlyRate,
        checkIn: attendance.checkIn,
        checkOut: attendance.checkOut,
        status: attendance.status,
        source: attendance.source,
        notes: attendance.notes,
        needsReview: attendance.needsReview,
        reviewReason: attendance.reviewReason,
      })
      .from(attendance)
      .where(
        and(
          eq(attendance.employeeId, input.employeeId),
          gte(attendance.attendanceDate, employmentStart),
          lte(attendance.attendanceDate, employmentEnd),
        ),
      );

  const attRows = input.lockFinancialInputs
    ? await selectAttRows().for("share", { noWait: true })
    : await selectAttRows();
  const rowNeedsLegacyHealing = (r: (typeof attRows)[number]) =>
      isLegacyAutoLateDeduction(r, emp.workSchedule) ||
      (r.source === "fingerprint" &&
        ((r.checkIn != null && r.checkOut == null) ||
          (r.checkIn instanceof Date && r.checkIn.getUTCHours() < 6) ||
          (!String(r.notes ?? "").includes("[فترات الدوام:") &&
            ((r.needsReview && String(r.reviewReason ?? "").includes("فرديّ")) ||
              (r.checkIn instanceof Date &&
                r.checkOut instanceof Date &&
                !String(r.reviewReason ?? "").includes("قُصّت عند سقف") &&
                (r.checkOut.getTime() - r.checkIn.getTime()) / 3_600_000 - Number(r.hours ?? 0) > 0.08)))));
  const hasUnhealedLateOrOpen = attRows.some(rowNeedsLegacyHealing);

  const settingsQuery = db.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1));
  const [settings] = input.lockFinancialInputs
    ? await settingsQuery.for("share", { noWait: true }).limit(1)
    : await settingsQuery.limit(1);
  // جدول الموظف وحده — الجدول العامّ أُلغي (0140) لأنه صار مكرّراً بعد دخوله بطاقةَ كل موظف.
  // من لم يُضبط جدولُه بعد يقع على الاحتياطيّ الثابت في الكود ويُنبَّه عليه في الشاشة.
  const schedule: WorkSchedule =
    emp.workSchedule && typeof emp.workSchedule === "object"
      ? (emp.workSchedule as WorkSchedule)
      : DEFAULT_WORK_SCHEDULE;
  const hasOwnSchedule = !!(emp.workSchedule && typeof emp.workSchedule === "object");

  // مجموع ما سُجّل فعلياً في الحضور — أساس أجر الموظف الساعيّ في المسيّر.
  let actualPaid = 0;
  let confirmedActualPaid = money(0);
  const attendedHoursByDate = new Map<string, ReturnType<typeof money>>();
  const confirmedAttendedHoursByDate = new Map<string, ReturnType<typeof money>>();
  const openDates = new Set<string>();
  const meta = new Map<string, (typeof attRows)[number]>();
  const excludedAttendanceDates = new Map<string, Set<string>>();
  const confirmedAttendanceBlockers: string[] = [];
  for (const r of attRows) {
    const d = String(r.date).slice(0, 10);
    meta.set(d, r);
    if (r.status === "PRESENT" || r.status === "LATE") {
      attendedHoursByDate.set(d, money(r.hours ?? 0));
      actualPaid += Number(r.amount ?? 0);
      // دخولٌ بلا انصراف (أو فترة دوام ثانية مفتوحة) ⇒ يومٌ مفتوح لا غائب.
      if (hasUnclosedAttendancePunch(r)) openDates.add(d);

      if (input.confirmedAttendanceOnly) {
        const inDate = dateYmdOfTimestamp(r.checkIn) ?? d;
        const outDate = dateYmdOfTimestamp(r.checkOut);
        const details = parseAttendanceDayDetails({
          status: r.status,
          checkIn: hhmm(r.checkIn),
          checkOut: hhmm(r.checkOut),
          crossMidnight: Boolean(outDate && outDate > inDate),
          storedHours: r.hours,
          notes: r.notes,
          reviewReason: r.reviewReason,
        });
        const summary = computeSessionsSummary(
          details.sessions.map((session) => ({
            checkIn: session.checkIn,
            checkOut: session.checkOut,
            crossMidnight: session.crossMidnight,
          })),
        );
        const malformedSessionsTag = hasMalformedAttendanceSessionsTag(r.notes);
        const declaredSplitHoursMismatch =
          details.hasMultipleSessions &&
          details.grossHours > 0 &&
          Math.abs(summary.totalHours - details.grossHours) > HOURS_SPAN_TOLERANCE;
        const singleSession = !details.hasMultipleSessions ? details.sessions[0] : null;
        const singleSessionViolation = singleSession
          ? attendanceHoursViolation({
              checkIn: singleSession.checkIn,
              checkOut: singleSession.checkOut,
              crossMidnight: singleSession.crossMidnight,
              hours: details.grossHours,
              isPaidStatus: true,
              breakMinutes: details.breakMinutes,
            })
          : null;
        const reasonCodes = new Set<string>();
        if (hasUnclosedAttendancePunch(r) || details.hasOpenSession || summary.hasOpenSession) {
          reasonCodes.add("OPEN_SESSION");
        }
        if (r.needsReview) reasonCodes.add("NEEDS_REVIEW");
        if (rowNeedsLegacyHealing(r)) reasonCodes.add("LEGACY_HEALING");
        if (
          summary.violation ||
          malformedSessionsTag ||
          declaredSplitHoursMismatch ||
          singleSessionViolation
        ) {
          reasonCodes.add("SESSION_CONTRADICTION");
        }

        if (reasonCodes.size > 0) {
          excludedAttendanceDates.set(d, reasonCodes);
        } else {
          confirmedAttendedHoursByDate.set(d, money(r.hours ?? 0));
          if (emp.payType === "hourly") {
            const projected = projectAttendanceWage({
              employee: emp,
              date: d,
              hours: r.hours,
              storedHourlyRate: r.hourlyRate,
              status: r.status,
            });
            confirmedActualPaid = confirmedActualPaid.plus(projected.amount);
          } else {
            confirmedActualPaid = confirmedActualPaid.plus(money(r.amount ?? 0));
          }
        }
      }
    }
  }

  const leavesQuery = db
    .select({ paid: leaveRequests.paid, fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.employeeId, input.employeeId),
        eq(leaveRequests.status, "approved"),
        sql`${leaveRequests.fromDate} <= ${monthEnd} AND ${leaveRequests.toDate} >= ${monthStart}`,
      ),
    );
  const leaves = input.lockFinancialInputs
    ? await leavesQuery.for("share", { noWait: true })
    : await leavesQuery;
  const paidSpans = leaves.filter((l) => l.paid).map((l) => ({ from: String(l.fromDate), to: String(l.toDate) }));
  const unpaidSpans = leaves.filter((l) => !l.paid).map((l) => ({ from: String(l.fromDate), to: String(l.toDate) }));
  const paidLeaveDates = expand(paidSpans, employmentStart, employmentEnd);
  const unpaidLeaveDates = expand(unpaidSpans, employmentStart, employmentEnd);

  const pay = computeAttendancePay({
    salary: money(emp.salary ?? 0),
    employmentStart,
    employmentEnd,
    schedule,
    dayRates: (emp.dayRates && typeof emp.dayRates === "object" ? emp.dayRates : null) as Record<string, number> | null,
    payType: emp.payType,
    attendedHoursByDate,
    openDates,
    paidLeaveDates,
    unpaidLeaveDates,
    // الكشف يعرض الشهر كما يُحتسب فعلياً؛ غياب السريان ⇒ كل الأيام مدفوعة (السلوك نفسه).
    payFrom: settings?.attendancePayFrom ? String(settings.attendancePayFrom) : null,
    monthStart,
    monthEnd,
    maxDailyHours: Number(settings?.maxDailyHours ?? 12),
  });
  const confirmedPay = input.confirmedAttendanceOnly
    ? computeAttendancePay({
        salary: money(emp.salary ?? 0),
        employmentStart,
        employmentEnd,
        schedule,
        dayRates: (emp.dayRates && typeof emp.dayRates === "object" ? emp.dayRates : null) as Record<string, number> | null,
        payType: emp.payType,
        attendedHoursByDate: confirmedAttendedHoursByDate,
        openDates,
        // الإجازة المدفوعة/ما قبل سريان الحضور مصدر استحقاق مستقل؛ المستبعد هو مساهمة الحضور فقط.
        paidLeaveDates,
        unpaidLeaveDates,
        payFrom: settings?.attendancePayFrom ? String(settings.attendancePayFrom) : null,
        monthStart,
        monthEnd,
        maxDailyHours: Number(settings?.maxDailyHours ?? 12),
      })
    : null;

  // نُثري كل يوم بأوقات البصم الفعلية، فترات الدوام والاستراحة/الزمنية، ووسم المراجعة.
  const days = pay.days.map((d) => {
    const m = meta.get(d.date);
    const inDate = dateYmdOfTimestamp(m?.checkIn) ?? d.date;
    const outDate = dateYmdOfTimestamp(m?.checkOut);
    const checkIn = hhmm(m?.checkIn);
    const checkOut = hhmm(m?.checkOut);
    const checkOutNextDay = Boolean(outDate && outDate > inDate);
    const dayDetails = parseAttendanceDayDetails({
      status: m?.status ?? null,
      state: d.state,
      checkIn,
      checkOut,
      crossMidnight: checkOutNextDay,
      storedHours: m?.hours ?? null,
      fallbackHours: d.countedHours,
      notes: m?.notes ?? null,
      reviewReason: m?.reviewReason ?? null,
    });
    return {
      ...d,
      checkIn,
      checkOut,
      checkOutNextDay,
      status: m?.status ?? null,
      notes: m?.notes ?? null,
      cleanNotes: dayDetails.cleanNotes,
      sessions: dayDetails.sessions,
      breaks: dayDetails.breaks,
      breakMinutes: dayDetails.breakMinutes,
      breakHours: dayDetails.breakHours,
      hasMultipleSessions: dayDetails.hasMultipleSessions,
      hasOpenSession: dayDetails.hasOpenSession,
      openSessionCheckIn: dayDetails.openSessionCheckIn,
      source: m?.source ?? null,
      needsReview: !!m?.needsReview,
      reviewReason: m?.needsReview || m?.reviewReason === "manual_late_override" ? (m?.reviewReason ?? null) : null,
    };
  });

  /*
   * الأجر الثابت كما يحسبه المسيّر بالضبط: (الراتب + البدلات) × تناسب أيام العمل في الشهر.
   * هو المستحقّ لمن لا يخضع للحضور — المُعفى، ومن كان الأجر بالحضور معطَّلاً عنه. كان الكشف
   * والتقرير يعرضان له حسابَ الحضور (صفراً لمن لا بصمة له!) أو الراتبَ الأساس خاماً بلا بدلات
   * ولا تناسبِ شهرِ تعيينٍ/فصل ⇒ رقمٌ يُشارَك ويُطبَع ولا يُطابق ما يُصرف (Codex P2).
   */
  const daysInMonth = Number(monthEnd.slice(8, 10));
  const activeDays =
    employmentEnd < employmentStart
      ? 0
      : Math.floor((Date.parse(`${employmentEnd}T00:00:00Z`) - Date.parse(`${employmentStart}T00:00:00Z`)) / 86_400_000) + 1;
  const ratio = money(activeDays).div(daysInMonth);
  const proratedAllowances = round2(money(emp.allowances ?? 0).times(ratio));
  const fixedBasicPay = round2(money(emp.salary ?? 0).times(ratio));
  const fixedPay = round2(money(emp.salary ?? 0).times(ratio).plus(proratedAllowances));

  const hourly = emp.payType === "hourly";
  const exempt = !!emp.attendanceExempt;
  const attendancePayEnabled = !!settings?.attendancePayEnabled;
  /**
   * أساس المستحقّ — مصدرُ حقيقةٍ واحد يستهلكه الكشفُ والتقريرُ والطباعة بلا إعادة اشتقاق.
   * `payrollSnapshot` يتقدّم على الأربعة الباقية: شهرٌ صُرف لا يُعاد اشتقاقه (قرار ق٣).
   */
  const liveBasis: "hourly" | "exempt" | "attendance" | "fixedSalary" = hourly
    ? "hourly"
    : exempt
      ? "exempt"
      : attendancePayEnabled
        ? "attendance"
        : "fixedSalary";
  const confirmedAttendanceAffectsWage = liveBasis === "hourly" || liveBasis === "attendance";
  /*
   * إسقاط بند المسيّر الحيّ من **نفس** نتائج النواة أعلاه. يفصل الإضافي عن gross لأن
   * computeLegalComponents لا يدخله في وعاء الضمان/الضريبة، ويفصل المخصصات عن basic.
   * الاسم `live` مقصود: لقطة المسيّر المعتمد لا تخزّن basic مستقلاً ولا نخترعه منها.
   */
  const payrollComponentsFor = (
    attendancePay: ReturnType<typeof computeAttendancePay>,
    hourlyAmount: ReturnType<typeof money>,
  ) => {
    if (liveBasis === "attendance") {
      const basic = round2(money(attendancePay.basePay));
      return {
        basic: basic.toFixed(2),
        allowances: proratedAllowances.toFixed(2),
        gross: round2(basic.plus(proratedAllowances)).toFixed(2),
        overtime: round2(money(attendancePay.overtimePay)).toFixed(2),
      };
    }
    if (liveBasis === "hourly") {
      const gross = round2(hourlyAmount);
      return {
        basic: gross.toFixed(2),
        allowances: "0.00",
        gross: gross.toFixed(2),
        overtime: "0.00",
      };
    }
    return {
      basic: fixedBasicPay.toFixed(2),
      allowances: proratedAllowances.toFixed(2),
      gross: fixedPay.toFixed(2),
      overtime: "0.00",
    };
  };
  const livePayrollComponents = payrollComponentsFor(pay, money(actualPaid));
  const confirmedPayrollComponents = confirmedPay
    ? payrollComponentsFor(confirmedPay, confirmedActualPaid)
    : null;
  const liveAmountDue =
    liveBasis === "hourly"
      ? actualPaid.toFixed(2)
      : liveBasis === "attendance"
        ? round2(money(pay.basePay).plus(money(pay.overtimePay))).toFixed(2)
        : fixedPay.toFixed(2);

  const snapshot = await loadPayrollSnapshot(db, input.employeeId, p, {
    runSnapshot: input.payrollRunSnapshot,
    lockFinancialInputs: input.lockFinancialInputs,
  });
  const dueBasis: StatementDueBasis = snapshot ? "payrollSnapshot" : liveBasis;
  /*
   * الرقم المجمَّد = `gross + overtime` من اللقطة: **الأجر المكتسَب عن الشهر** بنفس معنى
   * `amountDue` الحيّ (قبل العمولة وقبل الاستقطاعات) — فلا ينقلب معنى الحقل على مستهلكيه
   * حين يتجمّد. والمصروف فعلاً (`net`) وكلُّ مكوّناته في `payrollSnapshot` تعرضها الشاشة
   * صراحةً: تجميدُ الرقم ليس إخفاءَ تفصيله.
   */
  const amountDue = snapshot
    ? round2(money(snapshot.gross).plus(money(snapshot.overtime))).toFixed(2)
    : liveAmountDue;

  return {
    employee: {
      id: Number(emp.id),
      name: fullEmployeeName(emp),
      position: emp.position,
      department: emp.department,
      branchName: emp.branchName,
      payType: emp.payType,
      salary: emp.salary,
      attendanceExempt: !!emp.attendanceExempt,
    },
    period: p,
    from: employmentStart,
    to: employmentEnd,
    schedule,
    attendancePayEnabled,
    hasOwnSchedule,
    approvedLeaveSpans: leaves.map((leave) => ({
      paid: !!leave.paid,
      from: String(leave.fromDate),
      to: String(leave.toDate),
    })),
    /** مجموع `attendance.amount` — ما يدفعه المسيّر للساعيّ فعلاً. */
    actualPaidAmount: actualPaid.toFixed(2),
    /** (الراتب + البدلات) × تناسب أيام العمل — ما يدفعه المسيّر لغير الخاضع للحضور. */
    fixedPay: fixedPay.toFixed(2),
    /** المستحقّ الفعليّ عن الشهر وأساسُه — يُعرَض ويُطبَع ويُشارَك بدل حساب الحضور دائماً. */
    amountDue,
    dueBasis,
    /**
     * **الأجر المكتسب بتركيب بند المسيّر نفسه** — لا صيغةً مستقلّة.
     *
     * تسويةُ نهاية الخدمة تُدخل `earnedGrossWages` يدوياً، ودلالتُه محسومة: **الأجر الذي كان
     * المسيّر سيدفعه** عن الفترة (المسيّر يسجّل «تغطية» كي لا يُدفع مرّتين —
     * `encodeTerminationWageCoverage`). فالمقارَن يجب أن يطابق `gross + overtime` في
     * [generate.ts](../payroll/generate.ts) حرفياً، وإلّا انحرفت المطابقة انحرافاً منهجياً:
     *   • مسار الحضور: `gross = basePay + مخصّصات` و`overtime` عمودٌ مستقلّ
     *     ⇒ هنا `amountDue (= basePay + overtimePay) + مخصّصات`.
     *   • الثابت/المُعفى: `gross = (راتب + مخصّصات) × تناسب` = `fixedPay` بعينه ⇒ `amountDue`.
     *   • الساعيّ: مجموع `attendance.amount` ⇒ `amountDue`.
     * ولولا إضافةُ المخصّصات في المسار الأول لَظهر انحرافٌ كاذبٌ بمقدارها في **كل** تسوية.
     */
    expectedEarnedGrossWages:
      dueBasis === "payrollSnapshot"
        ? amountDue
        : round2(money(livePayrollComponents.gross).plus(money(livePayrollComponents.overtime))).toFixed(2),
    livePayrollComponents,
    confirmedPayrollComponents,
    excludedAttendanceDates: input.confirmedAttendanceOnly && confirmedAttendanceAffectsWage
      ? Array.from(excludedAttendanceDates, ([date, reasonCodes]) => ({
          date,
          reasonCodes: Array.from(reasonCodes).sort(),
        })).sort((a, b) => a.date.localeCompare(b.date))
      : [],
    confirmedAttendanceBlockers: input.confirmedAttendanceOnly && confirmedAttendanceAffectsWage
      ? Array.from(new Set(confirmedAttendanceBlockers))
      : [],
    /**
     * لقطةُ الشهر المصروف (ق٣) — `null` ما لم يُعتمد مسيّرُه. وجودُها يعني أن `amountDue`
     * أعلاه **مجمَّد** منها لا مشتقٌّ من بيانات اليوم.
     */
    payrollSnapshot: snapshot,
    /**
     * الرقم كما تشتقّه بيانات **اليوم** (راتبٌ وجدولٌ وإعداداتٌ حاليّة) وأساسُه — يُعرَضان
     * بجانب المجمَّد لا بدلاً منه: الفرق بينهما هو أثرُ ما تغيّر بعد الصرف (ترقيةٌ، تصحيحُ
     * بصمة، تبديلُ جدول)، وإظهارُه صراحةً يمنع أن يُقرأ الاختلافُ خطأً في النظام.
     */
    liveAmountDue,
    liveBasis,
    needsHealing: !snapshot && hasUnhealedLateOrOpen,
    totals: {
      scheduledHours: pay.scheduledHours,
      standardHours: pay.standardHours,
      shortMonthHours: pay.shortMonthHours,
      payableHours: pay.payableHours,
      unpaidHours: pay.unpaidHours,
      hourlyRate: pay.hourlyRate,
      basePay: pay.basePay,
      overtimeHours: pay.overtimeHours,
      overtimePay: pay.overtimePay,
      absentDays: pay.absentDays,
      openDays: pay.openDays,
      unpaidLeaveDays: pay.unpaidLeaveDays,
      shortHours: pay.shortHours,
      restWorkedHours: pay.restWorkedHours,
      reviewDays: days.filter((d) => d.needsReview).length,
    },
    days,
  };
}
