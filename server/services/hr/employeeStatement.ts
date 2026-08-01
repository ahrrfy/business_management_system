/* ============================================================================
 * كشف حضور الموظف — صفٌّ لكل يوم (server/services/hr/employeeStatement.ts)
 *
 * قرار المالك (٣١/٧): «أريد لكل يوم ساعاته من ساعة إلى ساعة وأجر الساعة لهذا اليوم»،
 * و«المجموع التراكميّ لأيام الشهر هو الراتب الذي يستحقّه».
 *
 * يُعيد الكشف نفسه الذي يبني عليه المسيّر — **بنفس النواة** (`computeAttendancePay`)
 * لا بحسابٍ مستقلّ، فلا ينحرف المعروض عن المدفوع. وهذه قراءة صرفة: لا تكتب شيئاً
 * ولا تلمس مسيّراً، فيصلح للمراجعة قبل التوليد وبعده.
 * ========================================================================== */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { attendance, employees, hrAttendanceSettings, leaveRequests, branches } from "../../../drizzle/schema";
import { fullEmployeeName } from "@shared/hr";
import { requireDb } from "../tx";
import { money } from "../money";
import { computeAttendancePay, daysBetween, DEFAULT_WORK_SCHEDULE, type WorkSchedule } from "./attendancePay";

export interface EmployeeStatementInput {
  employeeId: number;
  /** الشهر "YYYY-MM" — الكشف يغطّيه كاملاً مقصوصاً بنافذة عمل الموظف. */
  period: string;
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
      hireDate: employees.hireDate,
      terminationDate: employees.terminationDate,
      workSchedule: employees.workSchedule,
      branchName: branches.name,
    })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(eq(employees.id, input.employeeId))
    .limit(1);
  if (!emp) return null;

  const [settings] = await db.select().from(hrAttendanceSettings).where(eq(hrAttendanceSettings.id, 1)).limit(1);
  const schedule: WorkSchedule =
    emp.workSchedule && typeof emp.workSchedule === "object"
      ? (emp.workSchedule as WorkSchedule)
      : settings?.defaultWorkSchedule && typeof settings.defaultWorkSchedule === "object"
        ? (settings.defaultWorkSchedule as WorkSchedule)
        : DEFAULT_WORK_SCHEDULE;

  // نافذة عمله داخل الشهر (تعيين/فصل في منتصفه).
  const employmentStart = emp.hireDate && emp.hireDate > monthStart ? String(emp.hireDate) : monthStart;
  const employmentEnd = emp.terminationDate && emp.terminationDate < monthEnd ? String(emp.terminationDate) : monthEnd;

  const attRows = await db
    .select({
      date: attendance.attendanceDate,
      hours: attendance.hours,
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

  const attendedHoursByDate = new Map<string, ReturnType<typeof money>>();
  const meta = new Map<string, (typeof attRows)[number]>();
  for (const r of attRows) {
    const d = String(r.date).slice(0, 10);
    meta.set(d, r);
    if (r.status === "PRESENT" || r.status === "LATE") attendedHoursByDate.set(d, money(r.hours ?? 0));
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
    paidLeaveDates: expand(paidSpans, employmentStart, employmentEnd),
    unpaidLeaveDates: expand(unpaidSpans, employmentStart, employmentEnd),
    // الكشف يعرض الشهر كما يُحتسب فعلياً؛ غياب السريان ⇒ كل الأيام مدفوعة (السلوك نفسه).
    payFrom: settings?.attendancePayFrom ? String(settings.attendancePayFrom) : null,
  });

  // نُثري كل يوم بأوقات البصم الفعلية ووسم المراجعة — وهو ما يريده المالك: «من ساعة إلى ساعة».
  const days = pay.days.map((d) => {
    const m = meta.get(d.date);
    return {
      ...d,
      checkIn: m?.checkIn ?? null,
      checkOut: m?.checkOut ?? null,
      source: m?.source ?? null,
      needsReview: !!m?.needsReview,
      reviewReason: m?.reviewReason ?? null,
    };
  });

  return {
    employee: {
      id: Number(emp.id),
      name: fullEmployeeName(emp),
      position: emp.position,
      department: emp.department,
      branchName: emp.branchName,
      payType: emp.payType,
      salary: emp.salary,
    },
    period: p,
    from: employmentStart,
    to: employmentEnd,
    schedule,
    attendancePayEnabled: !!settings?.attendancePayEnabled,
    totals: {
      scheduledHours: pay.scheduledHours,
      payableHours: pay.payableHours,
      unpaidHours: pay.unpaidHours,
      hourlyRate: pay.hourlyRate,
      basePay: pay.basePay,
      overtimeHours: pay.overtimeHours,
      overtimePay: pay.overtimePay,
      absentDays: pay.absentDays,
      unpaidLeaveDays: pay.unpaidLeaveDays,
      shortHours: pay.shortHours,
      reviewDays: days.filter((d) => d.needsReview).length,
    },
    days,
  };
}
