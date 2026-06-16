// خدمة تقارير الموارد البشرية (للقراءة فقط) — تُغذّي مركز التقارير (وحدة HR).
// ⚠️ هذه التقارير تكشف الرواتب/الأجور ⇒ تُبوَّب في الراوترات بصلاحية hr/READ (hrRead)، لا
//    بـmanagerBranchScopedProcedure. لا تُركّب إلا تحت hrRead.
//
// نمط SQL الخام مطابق لـreportsFinancialService:
//  • db.execute(sql`…`) + rowsOf لفكّ نتيجة mysql2.
//  • أسماء أعمدة DB الحرفية (status الفعلي = payrollStatus/attendanceStatus/leaveStatus،
//    promotionStatus/terminationStatus — راجع drizzle/schema.ts).
//  • المبالغ كلها عبر money/toDbMoney (decimal.js)؛ CAST(... AS CHAR) لتفادي انجراف float،
//    و**ممنوع** parseFloat/Number على الأموال.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ============================ ١. ملخّص مسيّرات الرواتب ============================ */

export interface PayrollSummaryRow {
  id: number;
  period: string;
  status: string;
  employees: number;
  gross: string;
  net: string;
}

export interface PayrollSummaryResult {
  rows: PayrollSummaryRow[];
  totals: { runs: number; gross: string; net: string };
}

/**
 * يسرد مسيّرات الرواتب مع إجمالياتها المخزَّنة في رأس المسيّر (totalGross/totalNet …).
 * يُفلتر اختيارياً بشهر واحد (YYYY-MM). الإجماليات تُجمع بـdecimal من نفس الصفوف المعروضة.
 */
export async function getPayrollSummary(opts: { period?: string } = {}): Promise<PayrollSummaryResult> {
  const db = getDb();
  const empty: PayrollSummaryResult = { rows: [], totals: { runs: 0, gross: "0", net: "0" } };
  if (!db) return empty;

  const periodCond = opts.period ? sql`WHERE pr.period = ${opts.period}` : sql``;

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        pr.id AS id,
        pr.period AS period,
        pr.payrollStatus AS status,
        pr.employeeCount AS employees,
        CAST(pr.totalGross AS CHAR) AS gross,
        CAST(pr.totalOvertime AS CHAR) AS overtime,
        CAST(pr.totalDeductions AS CHAR) AS deductions,
        CAST(pr.totalNet AS CHAR) AS net
      FROM payrollRuns pr
      ${periodCond}
      ORDER BY pr.period DESC, pr.id DESC
    `),
  );

  const rows: PayrollSummaryRow[] = raw.map((r) => ({
    id: Number(r.id),
    period: String(r.period),
    status: String(r.status),
    employees: Number(r.employees ?? 0),
    gross: toDbMoney(money(r.gross ?? 0)),
    net: toDbMoney(money(r.net ?? 0)),
  }));

  let gross = money(0);
  let net = money(0);
  for (const r of raw) {
    gross = gross.add(money(r.gross ?? 0));
    net = net.add(money(r.net ?? 0));
  }

  return {
    rows,
    totals: { runs: rows.length, gross: toDbMoney(gross), net: toDbMoney(net) },
  };
}

/* ============================ ٢. تقرير الحضور والانصراف ============================ */

const ATTENDANCE_STATUS_AR: Record<string, string> = {
  PRESENT: "حاضر",
  ABSENT: "غائب",
  LATE: "متأخّر",
  LEAVE: "إجازة",
};

export interface AttendanceReportRow {
  date: string;
  employeeName: string;
  status: string; // التسمية العربية
  statusKey: string; // المفتاح الأصلي (PRESENT/…)
  hours: string;
  amount: string;
}

export interface AttendanceReportResult {
  rows: AttendanceReportRow[];
  totals: { days: number; hours: string; amount: string; present: number; absent: number };
}

/**
 * صفوف الحضور في نطاق [from,to] (attendanceDate BETWEEN، حدّان شاملان) مع اسم الموظف،
 * مفلترة اختيارياً بموظف. الساعات/المبالغ بـdecimal. presentُ = PRESENT+LATE، absent = ABSENT.
 */
export async function getAttendanceReport(opts: {
  from: string;
  to: string;
  employeeId?: number;
}): Promise<AttendanceReportResult> {
  const db = getDb();
  const empty: AttendanceReportResult = {
    rows: [],
    totals: { days: 0, hours: "0", amount: "0", present: 0, absent: 0 },
  };
  if (!db) return empty;

  const empCond = opts.employeeId ? sql`AND a.employeeId = ${opts.employeeId}` : sql``;

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        DATE_FORMAT(a.attendanceDate, '%Y-%m-%d') AS date,
        TRIM(CONCAT_WS(' ', e.firstName, e.fatherName, e.lastName)) AS employeeName,
        a.attendanceStatus AS status,
        CAST(COALESCE(a.hours, 0) AS CHAR) AS hours,
        CAST(COALESCE(a.amount, 0) AS CHAR) AS amount
      FROM attendance a
      JOIN employees e ON e.id = a.employeeId
      WHERE a.attendanceDate >= ${opts.from} AND a.attendanceDate <= ${opts.to}
        ${empCond}
      ORDER BY a.attendanceDate DESC, a.id DESC
    `),
  );

  const rows: AttendanceReportRow[] = raw.map((r) => {
    const key = String(r.status);
    return {
      date: String(r.date),
      employeeName: r.employeeName ? String(r.employeeName) : "—",
      status: ATTENDANCE_STATUS_AR[key] ?? key,
      statusKey: key,
      hours: toDbMoney(money(r.hours ?? 0)),
      amount: toDbMoney(money(r.amount ?? 0)),
    };
  });

  let hours = money(0);
  let amount = money(0);
  let present = 0;
  let absent = 0;
  for (const r of raw) {
    hours = hours.add(money(r.hours ?? 0));
    amount = amount.add(money(r.amount ?? 0));
    const key = String(r.status);
    if (key === "PRESENT" || key === "LATE") present += 1;
    else if (key === "ABSENT") absent += 1;
  }

  return {
    rows,
    totals: {
      days: rows.length,
      hours: toDbMoney(hours),
      amount: toDbMoney(amount),
      present,
      absent,
    },
  };
}

/* ============================ ٣. أرصدة الإجازات ============================ */

export interface LeaveBalanceRow {
  employeeId: number;
  employeeName: string;
  usedDays: number;
  pendingDays: number;
}

export interface LeaveBalancesResult {
  rows: LeaveBalanceRow[];
}

/**
 * لكل موظف نشِط: مجموع أيام الإجازات المعتمدة (leaveStatus='approved') = usedDays،
 * والمعلّقة (pending) = pendingDays. الموظفون بلا طلبات يظهرون بأصفار (LEFT JOIN).
 */
export async function getLeaveBalances(): Promise<LeaveBalancesResult> {
  const db = getDb();
  if (!db) return { rows: [] };

  const raw = rowsOf(
    await db.execute(sql`
      SELECT
        e.id AS employeeId,
        TRIM(CONCAT_WS(' ', e.firstName, e.fatherName, e.lastName)) AS employeeName,
        COALESCE(SUM(CASE WHEN lr.leaveStatus = 'approved' THEN lr.days ELSE 0 END), 0) AS usedDays,
        COALESCE(SUM(CASE WHEN lr.leaveStatus = 'pending'  THEN lr.days ELSE 0 END), 0) AS pendingDays
      FROM employees e
      LEFT JOIN leaveRequests lr ON lr.employeeId = e.id
      WHERE e.isActive = TRUE
      GROUP BY e.id, e.firstName, e.fatherName, e.lastName
      ORDER BY usedDays DESC, e.id ASC
    `),
  );

  const rows: LeaveBalanceRow[] = raw.map((r) => ({
    employeeId: Number(r.employeeId),
    employeeName: r.employeeName ? String(r.employeeName) : "—",
    usedDays: Number(r.usedDays ?? 0),
    pendingDays: Number(r.pendingDays ?? 0),
  }));

  return { rows };
}

/* ============================ ٤. التغييرات الوظيفية (ترقيات + إنهاء خدمة) ============================ */

export interface PromotionReportRow {
  employeeName: string;
  fromTitle: string | null;
  toTitle: string;
  effectiveDate: string;
  status: string;
}

export interface TerminationReportRow {
  employeeName: string;
  type: string;
  lastDay: string;
  settlement: string;
  status: string;
}

export interface HrChangesResult {
  promotions: PromotionReportRow[];
  terminations: TerminationReportRow[];
}

/**
 * قائمتا الترقيات وإنهاء الخدمات (مع اسم الموظف لكل سطر). status بقيم DB
 * (promotionStatus: pending/approved، terminationStatus: pending/completed) تُعرَّب في الواجهة.
 */
export async function getHrChanges(): Promise<HrChangesResult> {
  const db = getDb();
  if (!db) return { promotions: [], terminations: [] };

  const promoRaw = rowsOf(
    await db.execute(sql`
      SELECT
        TRIM(CONCAT_WS(' ', e.firstName, e.fatherName, e.lastName)) AS employeeName,
        p.fromTitle AS fromTitle,
        p.toTitle AS toTitle,
        DATE_FORMAT(p.effectiveDate, '%Y-%m-%d') AS effectiveDate,
        p.promotionStatus AS status
      FROM employeePromotions p
      JOIN employees e ON e.id = p.employeeId
      ORDER BY p.effectiveDate DESC, p.id DESC
    `),
  );

  const termRaw = rowsOf(
    await db.execute(sql`
      SELECT
        TRIM(CONCAT_WS(' ', e.firstName, e.fatherName, e.lastName)) AS employeeName,
        t.terminationType AS type,
        DATE_FORMAT(t.lastDay, '%Y-%m-%d') AS lastDay,
        CAST(COALESCE(t.settlement, 0) AS CHAR) AS settlement,
        t.terminationStatus AS status
      FROM employeeTerminations t
      JOIN employees e ON e.id = t.employeeId
      ORDER BY t.lastDay DESC, t.id DESC
    `),
  );

  const promotions: PromotionReportRow[] = promoRaw.map((r) => ({
    employeeName: r.employeeName ? String(r.employeeName) : "—",
    fromTitle: r.fromTitle != null ? String(r.fromTitle) : null,
    toTitle: String(r.toTitle ?? ""),
    effectiveDate: String(r.effectiveDate),
    status: String(r.status),
  }));

  const terminations: TerminationReportRow[] = termRaw.map((r) => ({
    employeeName: r.employeeName ? String(r.employeeName) : "—",
    type: String(r.type ?? ""),
    lastDay: String(r.lastDay),
    settlement: toDbMoney(money(r.settlement ?? 0)),
    status: String(r.status),
  }));

  return { promotions, terminations };
}
