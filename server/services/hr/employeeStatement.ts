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
import { requireDb } from "../tx";
import { money, round2 } from "../money";
import { computeAttendancePay, daysBetween, DEFAULT_WORK_SCHEDULE, type WorkSchedule } from "./attendancePay";

export interface EmployeeStatementInput {
  employeeId: number;
  /** الشهر "YYYY-MM" — الكشف يغطّيه كاملاً مقصوصاً بنافذة عمل الموظف. */
  period: string;
  /**
   * عزل الفرع (قرار المالك ١٢/٨): رقمٌ = يُرفَض موظفُ فرعٍ آخر، null = عبورٌ (أدمن/مالك).
   * الكشف يعرض الراتب وسعر الساعة وأجر كل يوم ⇒ تسريبُه بين الفروع تسريبُ رواتب.
   */
  scopedBranchId?: number | null;
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
async function loadPayrollSnapshot(db: ReturnType<typeof requireDb>, employeeId: number, period: string) {
  const [run] = await db
    .select({
      id: payrollRuns.id,
      status: payrollRuns.status,
      revisionNo: payrollRuns.revisionNo,
      approvedAt: payrollRuns.approvedAt,
      paidAt: payrollRuns.paidAt,
    })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.period, period), inArray(payrollRuns.status, ["approved", "paid"])))
    .limit(1);
  if (!run) return null;

  const items = await db
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
  const db = requireDb();
  const p = input.period;
  const monthStart = `${p}-01`;
  const [py, pm] = p.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);

  const [emp] = await db
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
      attendanceExempt: employees.attendanceExempt,
      branchId: employees.branchId,
      branchName: branches.name,
    })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(eq(employees.id, input.employeeId))
    .limit(1);
  if (!emp) return null;
  /*
   * عزل الفرع: **رفضٌ صريح** لا تصفيةٌ صامتة — الطلب يحمل معرّفاً بعينه، فإعادة `null`
   * تُقرأ «لا موظف بهذا المعرّف» وتُخفي المحاولة. الرفض يُظهرها في السجلّ.
   */
  if (input.scopedBranchId != null && Number(emp.branchId) !== Number(input.scopedBranchId)) {
    throw new Error("هذا الموظف من فرعٍ آخر — لا صلاحية لك على كشف حضوره");
  }

  const [settings] = await db.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
  // جدول الموظف وحده — الجدول العامّ أُلغي (0140) لأنه صار مكرّراً بعد دخوله بطاقةَ كل موظف.
  // من لم يُضبط جدولُه بعد يقع على الاحتياطيّ الثابت في الكود ويُنبَّه عليه في الشاشة.
  const schedule: WorkSchedule =
    emp.workSchedule && typeof emp.workSchedule === "object"
      ? (emp.workSchedule as WorkSchedule)
      : DEFAULT_WORK_SCHEDULE;
  const hasOwnSchedule = !!(emp.workSchedule && typeof emp.workSchedule === "object");

  // نافذة عمله داخل الشهر (تعيين/فصل في منتصفه).
  const employmentStart = emp.hireDate && emp.hireDate > monthStart ? String(emp.hireDate) : monthStart;
  const employmentEnd = emp.terminationDate && emp.terminationDate < monthEnd ? String(emp.terminationDate) : monthEnd;

  const attRows = await db
    .select({
      date: attendance.attendanceDate,
      hours: attendance.hours,
      amount: attendance.amount,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
      status: attendance.status,
      source: attendance.source,
      needsReview: attendance.needsReview,
      reviewReason: attendance.reviewReason,
    })
    .from(attendance)
    .where(
      and(
        eq(attendance.employeeId, input.employeeId),
        gte(attendance.attendanceDate, monthStart),
        lte(attendance.attendanceDate, monthEnd),
      ),
    );

  // مجموع ما سُجّل فعلياً في الحضور — أساس أجر الموظف الساعيّ في المسيّر.
  let actualPaid = 0;
  const attendedHoursByDate = new Map<string, ReturnType<typeof money>>();
  const openDates = new Set<string>();
  const meta = new Map<string, (typeof attRows)[number]>();
  for (const r of attRows) {
    const d = String(r.date).slice(0, 10);
    meta.set(d, r);
    if (r.status === "PRESENT" || r.status === "LATE") {
      attendedHoursByDate.set(d, money(r.hours ?? 0));
      actualPaid += Number(r.amount ?? 0);
      // دخولٌ بلا انصراف ⇒ يومٌ مفتوح لا غائب (ساعاته صفرٌ لأنها لا تُخمَّن، لا لأنه تغيّب).
      if (r.checkIn != null && r.checkOut == null) openDates.add(d);
    }
  }

  const leaves = await db
    .select({ paid: leaveRequests.paid, fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.employeeId, input.employeeId),
        eq(leaveRequests.status, "approved"),
        sql`${leaveRequests.fromDate} <= ${monthEnd} AND ${leaveRequests.toDate} >= ${monthStart}`,
      ),
    );
  const paidSpans = leaves.filter((l) => l.paid).map((l) => ({ from: String(l.fromDate), to: String(l.toDate) }));
  const unpaidSpans = leaves.filter((l) => !l.paid).map((l) => ({ from: String(l.fromDate), to: String(l.toDate) }));

  const pay = computeAttendancePay({
    salary: money(emp.salary ?? 0),
    employmentStart,
    employmentEnd,
    schedule,
    attendedHoursByDate,
    openDates,
    paidLeaveDates: expand(paidSpans, employmentStart, employmentEnd),
    unpaidLeaveDates: expand(unpaidSpans, employmentStart, employmentEnd),
    // الكشف يعرض الشهر كما يُحتسب فعلياً؛ غياب السريان ⇒ كل الأيام مدفوعة (السلوك نفسه).
    payFrom: settings?.attendancePayFrom ? String(settings.attendancePayFrom) : null,
    monthStart,
    monthEnd,
    maxDailyHours: Number(settings?.maxDailyHours ?? 12),
  });

  // نُثري كل يوم بأوقات البصم الفعلية ووسم المراجعة — وهو ما يريده المالك: «من ساعة إلى ساعة».
  const days = pay.days.map((d) => {
    const m = meta.get(d.date);
    return {
      ...d,
      checkIn: hhmm(m?.checkIn),
      checkOut: hhmm(m?.checkOut),
      source: m?.source ?? null,
      needsReview: !!m?.needsReview,
      reviewReason: m?.reviewReason ?? null,
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
  const fixedPay = round2(money(emp.salary ?? 0).times(ratio).plus(round2(money(emp.allowances ?? 0).times(ratio))));

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
  const liveAmountDue =
    liveBasis === "hourly"
      ? actualPaid.toFixed(2)
      : liveBasis === "attendance"
        ? round2(money(pay.basePay).plus(money(pay.overtimePay))).toFixed(2)
        : fixedPay.toFixed(2);

  const snapshot = await loadPayrollSnapshot(db, input.employeeId, p);
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
    /** مجموع `attendance.amount` — ما يدفعه المسيّر للساعيّ فعلاً. */
    actualPaidAmount: actualPaid.toFixed(2),
    /** (الراتب + البدلات) × تناسب أيام العمل — ما يدفعه المسيّر لغير الخاضع للحضور. */
    fixedPay: fixedPay.toFixed(2),
    /** المستحقّ الفعليّ عن الشهر وأساسُه — يُعرَض ويُطبَع ويُشارَك بدل حساب الحضور دائماً. */
    amountDue,
    dueBasis,
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
