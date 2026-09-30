/* ============================================================================
 * تقرير الحضور الشهريّ لكل الموظفين (server/services/hr/monthlyAttendanceReport.ts)
 *
 * صفٌّ لكل موظف: ساعاته المقرَّرة والمستحقّة · غيابه · إضافيّه · عمله في أيام الراحة ·
 * أيامه الموسومة · وأجره المستحقّ — بالمجاميع.
 *
 * يُبنى بنواة المسيّر نفسها (computeAttendancePay) لكل موظف، فلا ينحرف التقرير
 * عن الكشف الفرديّ ولا عن المسيّر. قراءة صرفة لا تكتب شيئاً.
 * معالجة GAP-23: استعلامات جماعية (Bulk Queries) تلغي مشكلة N+1 بالكامل.
 * ========================================================================== */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  attendance,
  branches,
  employees,
  hrAttendanceSettings,
  leaveRequests,
  payrollItems,
  payrollRuns,
} from "../../../drizzle/schema";
import { fullEmployeeName } from "@shared/hr";
import { money, round2 } from "../money";
import { requireDb } from "../tx";
import {
  computeAttendancePay,
  daysBetween,
  DEFAULT_WORK_SCHEDULE,
  type WorkSchedule,
} from "./attendancePay";
import type { StatementDueBasis } from "./employeeStatement";

/** صفّ الموظف في التقرير الشهريّ. */
export interface ReportRow {
  employeeId: number;
  employeeName: string;
  position: string | null;
  department: string | null;
  branchName: string | null;
  payType: string;
  hasOwnSchedule: boolean;
  scheduledHours: string;
  standardHours: string;
  payableHours: string;
  unpaidHours: string;
  hourlyRate: string;
  overtimeHours: string;
  overtimePay: string;
  restWorkedHours: string;
  shortMonthHours: string;
  absentDays: number;
  unpaidLeaveDays: number;
  reviewDays: number;
  basePay: string;
  totalDue: string;
  attendanceExempt: boolean;
  dueBasis: StatementDueBasis;
  /** الشهر مصروف ⇒ `totalDue` مجمَّدٌ من لقطة المسيّر لا مشتقٌّ من بيانات اليوم (ق٣). */
  frozen: boolean;
}

export interface MonthlyAttendanceReportInput {
  /** الشهر "YYYY-MM". */
  period: string;
  /** فرعٌ بعينه (اختياري) — يحترمه الراوتر بعزل الفروع. */
  branchId?: number | null;
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

export async function getMonthlyAttendanceReport(input: MonthlyAttendanceReportInput) {
  const db = requireDb();
  const p = input.period;
  const monthStart = `${p}-01`;
  const [py, pm] = p.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(py, pm, 0)).toISOString().slice(0, 10);
  const daysInMonth = Number(monthEnd.slice(8, 10));

  // استعلام 1: جلب الموظفين مع اسم الفرع بفلترة الفرع الممرر
  const emps = await db
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
    .where(input.branchId != null ? eq(employees.branchId, input.branchId) : undefined)
    .orderBy(employees.id);

  const eligible = emps.filter((e) => {
    const hiredBeforeEnd = !e.hireDate || String(e.hireDate).slice(0, 10) <= `${p}-31`;
    const notLeftBefore = !e.terminationDate || String(e.terminationDate).slice(0, 10) >= monthStart;
    return hiredBeforeEnd && notLeftBefore;
  });

  if (eligible.length === 0) {
    return {
      period: p,
      rows: [],
      totals: {
        employees: 0,
        payableHours: "0.00",
        overtimeHours: "0.00",
        restWorkedHours: "0.00",
        absentDays: 0,
        reviewDays: 0,
        totalDue: "0.00",
        withoutSchedule: 0,
        exempt: 0,
      },
    };
  }

  const employeeIds = eligible.map((e) => Number(e.id));

  // استعلام 2: إعدادات الحضور المركزية
  const [settings] = await db.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);

  // استعلام 3: سجلات الحضور الشهرية لجميع الموظفين المؤهلين دفعة واحدة
  const allAttendance = await db
    .select({
      employeeId: attendance.employeeId,
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
        inArray(attendance.employeeId, employeeIds),
        gte(attendance.attendanceDate, monthStart),
        lte(attendance.attendanceDate, monthEnd),
      ),
    );

  // استعلام 4: الإجازات المعتمدة لجميع الموظفين المؤهلين
  const allLeaves = await db
    .select({
      employeeId: leaveRequests.employeeId,
      paid: leaveRequests.paid,
      fromDate: leaveRequests.fromDate,
      toDate: leaveRequests.toDate,
    })
    .from(leaveRequests)
    .where(
      and(
        inArray(leaveRequests.employeeId, employeeIds),
        eq(leaveRequests.status, "approved"),
        sql`${leaveRequests.fromDate} <= ${monthEnd} AND ${leaveRequests.toDate} >= ${monthStart}`,
      ),
    );

  // استعلام 5: لقطة المسيّر المعتمد/المصروف للشهر إن وجد
  const [run] = await db
    .select({
      id: payrollRuns.id,
      status: payrollRuns.status,
      revisionNo: payrollRuns.revisionNo,
    })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.period, p), inArray(payrollRuns.status, ["approved", "paid"])))
    .limit(1);

  // استعلام 6: بنود المسيّر للشهر إن وجد
  const allItems = run
    ? await db
        .select({
          employeeId: payrollItems.employeeId,
          revisionNo: payrollItems.revisionNo,
          gross: payrollItems.gross,
          overtime: payrollItems.overtime,
        })
        .from(payrollItems)
        .where(and(eq(payrollItems.runId, Number(run.id)), inArray(payrollItems.employeeId, employeeIds)))
        .orderBy(desc(payrollItems.revisionNo))
    : [];

  // الفهرسة في الذاكرة (In-Memory Indexing)
  const attByEmp = new Map<number, typeof allAttendance>();
  for (const r of allAttendance) {
    const list = attByEmp.get(Number(r.employeeId));
    if (list) list.push(r);
    else attByEmp.set(Number(r.employeeId), [r]);
  }

  const leavesByEmp = new Map<number, typeof allLeaves>();
  for (const l of allLeaves) {
    const list = leavesByEmp.get(Number(l.employeeId));
    if (list) list.push(l);
    else leavesByEmp.set(Number(l.employeeId), [l]);
  }

  const itemsByEmp = new Map<number, (typeof allItems)[number]>();
  if (run) {
    const grouped = new Map<number, typeof allItems>();
    for (const it of allItems) {
      const eid = Number(it.employeeId);
      const list = grouped.get(eid);
      if (list) list.push(it);
      else grouped.set(eid, [it]);
    }
    for (const [eid, list] of grouped) {
      const match = list.find((i) => Number(i.revisionNo) === Number(run.revisionNo)) ?? list[0];
      if (match) itemsByEmp.set(eid, match);
    }
  }

  const attendancePayEnabled = !!settings?.attendancePayEnabled;
  const payFrom = settings?.attendancePayFrom ? String(settings.attendancePayFrom) : null;
  const maxDailyHours = Number(settings?.maxDailyHours ?? 12);

  const rows: ReportRow[] = [];

  for (const emp of eligible) {
    const empId = Number(emp.id);
    const empAtt = attByEmp.get(empId) ?? [];
    const empLeaves = leavesByEmp.get(empId) ?? [];
    const empItem = itemsByEmp.get(empId) ?? null;

    const schedule: WorkSchedule =
      emp.workSchedule && typeof emp.workSchedule === "object"
        ? (emp.workSchedule as WorkSchedule)
        : DEFAULT_WORK_SCHEDULE;
    const hasOwnSchedule = !!(emp.workSchedule && typeof emp.workSchedule === "object");

    const employmentStart = emp.hireDate && emp.hireDate > monthStart ? String(emp.hireDate) : monthStart;
    const hardEnd = [monthEnd, emp.terminationDate ? String(emp.terminationDate) : null]
      .filter((d): d is string => !!d)
      .reduce((a, b) => (b < a ? b : a));
    const employmentEnd = hardEnd;

    let actualPaid = 0;
    const attendedHoursByDate = new Map<string, ReturnType<typeof money>>();
    const openDates = new Set<string>();
    const meta = new Map<string, (typeof empAtt)[number]>();

    for (const r of empAtt) {
      const d = String(r.date).slice(0, 10);
      meta.set(d, r);
      if (r.status === "PRESENT" || r.status === "LATE") {
        attendedHoursByDate.set(d, money(r.hours ?? 0));
        actualPaid += Number(r.amount ?? 0);
        if (r.checkIn != null && r.checkOut == null) openDates.add(d);
      }
    }

    const paidSpans = empLeaves.filter((l) => l.paid).map((l) => ({ from: String(l.fromDate), to: String(l.toDate) }));
    const unpaidSpans = empLeaves.filter((l) => !l.paid).map((l) => ({ from: String(l.fromDate), to: String(l.toDate) }));

    const pay = computeAttendancePay({
      salary: money(emp.salary ?? 0),
      employmentStart,
      employmentEnd,
      schedule,
      attendedHoursByDate,
      openDates,
      paidLeaveDates: expand(paidSpans, employmentStart, employmentEnd),
      unpaidLeaveDates: expand(unpaidSpans, employmentStart, employmentEnd),
      payFrom,
      monthStart,
      monthEnd,
      maxDailyHours,
    });

    const activeDays =
      employmentEnd < employmentStart
        ? 0
        : Math.floor((Date.parse(`${employmentEnd}T00:00:00Z`) - Date.parse(`${employmentStart}T00:00:00Z`)) / 86_400_000) + 1;
    const ratio = money(activeDays).div(daysInMonth);
    const fixedPay = round2(money(emp.salary ?? 0).times(ratio).plus(round2(money(emp.allowances ?? 0).times(ratio))));

    const hourly = emp.payType === "hourly";
    const exempt = !!emp.attendanceExempt;

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

    const dueBasis: StatementDueBasis = empItem ? "payrollSnapshot" : liveBasis;
    const amountDue = empItem
      ? round2(money(empItem.gross).plus(money(empItem.overtime))).toFixed(2)
      : liveAmountDue;

    const reviewDays = pay.days.filter((d) => !!meta.get(d.date)?.needsReview).length;
    const due = Number(amountDue);

    rows.push({
      employeeId: empId,
      employeeName: fullEmployeeName(emp),
      position: emp.position,
      department: emp.department,
      branchName: emp.branchName,
      payType: emp.payType,
      hasOwnSchedule,
      scheduledHours: pay.scheduledHours,
      standardHours: pay.standardHours,
      payableHours: pay.payableHours,
      unpaidHours: pay.unpaidHours,
      hourlyRate: pay.hourlyRate,
      overtimeHours: pay.overtimeHours,
      overtimePay: pay.overtimePay,
      restWorkedHours: pay.restWorkedHours,
      shortMonthHours: pay.shortMonthHours,
      absentDays: pay.absentDays,
      unpaidLeaveDays: pay.unpaidLeaveDays,
      reviewDays,
      basePay: pay.basePay,
      totalDue: due.toFixed(2),
      attendanceExempt: exempt,
      dueBasis,
      frozen: empItem != null,
    });
  }

  const sum = (f: (r: ReportRow) => number) => rows.reduce((t, r) => t + f(r), 0);

  return {
    period: p,
    rows,
    totals: {
      employees: rows.length,
      payableHours: sum((r) => Number(r.payableHours)).toFixed(2),
      overtimeHours: sum((r) => Number(r.overtimeHours)).toFixed(2),
      restWorkedHours: sum((r) => Number(r.restWorkedHours)).toFixed(2),
      absentDays: sum((r) => r.absentDays),
      reviewDays: sum((r) => r.reviewDays),
      totalDue: sum((r) => Number(r.totalDue)).toFixed(2),
      withoutSchedule: rows.filter((r) => !r.hasOwnSchedule && !r.attendanceExempt).length,
      exempt: rows.filter((r) => r.attendanceExempt).length,
    },
  };
}
