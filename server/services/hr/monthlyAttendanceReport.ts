/* ============================================================================
 * تقرير الحضور الشهريّ لكل الموظفين (server/services/hr/monthlyAttendanceReport.ts)
 *
 * صفٌّ لكل موظف: ساعاته المقرَّرة والمستحقّة · غيابه · إضافيّه · عمله في أيام الراحة ·
 * أيامه الموسومة · وأجره المستحقّ — بالمجاميع.
 *
 * يُبنى بنواة المسيّر نفسها (`getEmployeeStatement` ⇐ `computeAttendancePay`) لكل موظف،
 * فلا ينحرف التقرير عن الكشف الفرديّ ولا عن المسيّر. قراءة صرفة لا تكتب شيئاً.
 * ========================================================================== */
import { eq } from "drizzle-orm";
import { employees } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { getEmployeeStatement } from "./employeeStatement";

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
}

export interface MonthlyAttendanceReportInput {
  /** الشهر "YYYY-MM". */
  period: string;
  /** فرعٌ بعينه (اختياري) — يحترمه الراوتر بعزل الفروع. */
  branchId?: number | null;
}

export async function getMonthlyAttendanceReport(input: MonthlyAttendanceReportInput) {
  const db = requireDb();
  const monthStart = `${input.period}-01`;

  // الفلترة بالفرع فقط في SQL؛ أهليّة الشهر تُحسم في JS أدناه بمقارنة نصّية على "YYYY-MM-DD".
  const emps = await db
    .select({ id: employees.id, terminationDate: employees.terminationDate, hireDate: employees.hireDate })
    .from(employees)
    .where(input.branchId != null ? eq(employees.branchId, input.branchId) : undefined)
    .orderBy(employees.id);

  const eligible = emps.filter((e) => {
    const hiredBeforeEnd = !e.hireDate || String(e.hireDate).slice(0, 10) <= `${input.period}-31`;
    const notLeftBefore = !e.terminationDate || String(e.terminationDate).slice(0, 10) >= monthStart;
    return hiredBeforeEnd && notLeftBefore;
  });

  const rows: ReportRow[] = [];
  for (const e of eligible) {
    const st = await getEmployeeStatement({ employeeId: Number(e.id), period: input.period });
    if (!st) continue;
    const due = Number(st.totals.basePay) + Number(st.totals.overtimePay);
    rows.push({
      employeeId: st.employee.id,
      employeeName: st.employee.name,
      position: st.employee.position,
      department: st.employee.department,
      branchName: st.employee.branchName,
      payType: st.employee.payType,
      hasOwnSchedule: st.hasOwnSchedule,
      scheduledHours: st.totals.scheduledHours,
      standardHours: st.totals.standardHours,
      payableHours: st.totals.payableHours,
      unpaidHours: st.totals.unpaidHours,
      hourlyRate: st.totals.hourlyRate,
      overtimeHours: st.totals.overtimeHours,
      overtimePay: st.totals.overtimePay,
      restWorkedHours: st.totals.restWorkedHours,
      shortMonthHours: st.totals.shortMonthHours,
      absentDays: st.totals.absentDays,
      unpaidLeaveDays: st.totals.unpaidLeaveDays,
      reviewDays: st.totals.reviewDays,
      basePay: st.totals.basePay,
      totalDue: due.toFixed(2),
    });
  }

  const sum = (f: (r: ReportRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  return {
    period: input.period,
    rows,
    totals: {
      employees: rows.length,
      payableHours: sum((r) => Number(r.payableHours)).toFixed(2),
      overtimeHours: sum((r) => Number(r.overtimeHours)).toFixed(2),
      restWorkedHours: sum((r) => Number(r.restWorkedHours)).toFixed(2),
      absentDays: sum((r) => r.absentDays),
      reviewDays: sum((r) => r.reviewDays),
      totalDue: sum((r) => Number(r.totalDue)).toFixed(2),
      /** موظفون بلا جدولٍ خاصّ — يقعون على احتياطيّ الكود، ويُنبَّه عليهم. */
      withoutSchedule: rows.filter((r) => !r.hasOwnSchedule).length,
    },
  };
}
