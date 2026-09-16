import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";

import {
  attendance,
  employees,
  leaveRequests,
  payrollItems,
  payrollRuns,
  tasks,
} from "../../drizzle/schema";
import type { DB } from "../db";
import { resolveSuperAppAuthority } from "./superAppAuthority";
import { requireDb } from "./tx";

/**
 * A deliberately small, role-safe contract for the first mobile screen.
 *
 * This service never receives `ctx`, employeeId, or branchId from the phone.
 * The protected Expo gateway derives the actor from the authenticated native
 * session and selects the Baghdad business date on the server. Payroll figures
 * are intentionally absent: a payslip is opened through its dedicated,
 * step-up protected procedure after that separate sensitive-action check is
 * available.
 */
export type MobileTodayActor = {
  userId: number;
  role: string;
  isOwner?: boolean;
  branchId?: number | null;
  permissionsOverride?: unknown;
  roleLockedByInactiveCustomRole?: boolean;
};

export const mobileTodayDestinations = [
  "TASKS",
  "SELF_ATTENDANCE",
  "SELF_LEAVE",
  "SELF_PAYROLL",
] as const;

export type MobileTodayDestination = (typeof mobileTodayDestinations)[number];

type MobileTodayAction = {
  destination: MobileTodayDestination;
  requiresStepUp: boolean;
};

export type MobileTodayPersonal = {
  state: "READY" | "NOT_LINKED";
  employee: {
    displayName: string;
    position: string | null;
    department: string | null;
  } | null;
  attendance: {
    state: "NOT_RECORDED" | "CHECKED_IN" | "COMPLETE" | "NEEDS_REVIEW";
    checkIn: Date | null;
    checkOut: Date | null;
    action: MobileTodayAction;
  } | null;
  focus: {
    id: number;
    title: string;
    priority: string;
    status: "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER";
    dueAt: Date | null;
    action: MobileTodayAction;
  } | null;
  leave: {
    status: string;
    fromDate: string;
    toDate: string;
    action: MobileTodayAction;
  } | null;
  payroll: {
    period: string;
    status: "approved" | "paid";
    action: MobileTodayAction;
  } | null;
};

export type MobileToday = {
  date: string;
  navigation: {
    ownerCenter: boolean;
    personal: boolean;
    work: boolean;
  };
  personal: MobileTodayPersonal;
};

/**
 * A bounded, personal attendance read model for the native employee journey.
 *
 * The date range is intentionally derived by the server from the Baghdad
 * business day supplied by the protected router. The phone never supplies an
 * employee, branch, arbitrary range, or an attendance record identifier.
 * Amounts, rates, notes, source-device information, and review reasons are
 * excluded: they are not needed for an employee to review their own record.
 */
export type MobileAttendanceHistory = {
  range: { from: string; to: string };
  personal: {
    state: "READY" | "NOT_LINKED";
    entries: Array<{
      date: string;
      checkIn: Date | null;
      checkOut: Date | null;
      status: "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
      hours: string | null;
      state: "RECORDED" | "NEEDS_REVIEW";
    }>;
  };
};

/**
 * Sensitive payroll projection. It is deliberately separate from mobileToday:
 * this payload exists only after a freshly consumed second factor, contains no
 * caller-selected employee/run/item, and never returns HR-only notes or IDs.
 */
export type MobilePayslip = {
  personal: {
    state: "READY" | "NOT_LINKED";
    payslip: {
      period: string;
      status: "approved" | "paid";
      paidAt: Date | null;
      payType: string;
      hours: string | null;
      gross: string;
      allowances: string;
      overtime: string;
      commission: string;
      deductions: string;
      advanceDeduction: string;
      socialSecurityEmployee: string;
      incomeTax: string;
      net: string;
    } | null;
  };
};

function dateBefore(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export async function getMobileToday(input: {
  actor: MobileTodayActor;
  date: string;
  db?: DB;
}): Promise<MobileToday> {
  const db = input.db ?? requireDb();
  const authority = resolveSuperAppAuthority(input.actor);
  const [employee] = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      lastName: employees.lastName,
      position: employees.position,
      department: employees.department,
    })
    .from(employees)
    .where(eq(employees.userId, input.actor.userId))
    .limit(1);

  if (!employee) {
    return {
      date: input.date,
      navigation: {
        ownerCenter: authority.capabilities.isExecutive,
        personal: false,
        work: false,
      },
      personal: {
        state: "NOT_LINKED",
        employee: null,
        attendance: null,
        focus: null,
        leave: null,
        payroll: null,
      },
    };
  }

  const [[todayAttendance], [focus], [leave], [payroll]] = await Promise.all([
    db
      .select({
        checkIn: attendance.checkIn,
        checkOut: attendance.checkOut,
        needsReview: attendance.needsReview,
      })
      .from(attendance)
      .where(
        and(
          eq(attendance.employeeId, employee.id),
          eq(attendance.attendanceDate, input.date),
        ),
      )
      .limit(1),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        priority: tasks.priority,
        status: tasks.taskStatus,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, input.actor.userId),
          inArray(tasks.taskStatus, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"]),
        ),
      )
      .orderBy(asc(tasks.dueAt), asc(tasks.createdAt))
      .limit(1),
    db
      .select({
        status: leaveRequests.status,
        fromDate: leaveRequests.fromDate,
        toDate: leaveRequests.toDate,
      })
      .from(leaveRequests)
      .where(eq(leaveRequests.employeeId, employee.id))
      .orderBy(desc(leaveRequests.requestedAt), desc(leaveRequests.id))
      .limit(1),
    db
      .select({
        period: payrollRuns.period,
        status: payrollRuns.status,
      })
      .from(payrollItems)
      .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
      .where(
        and(
          eq(payrollItems.employeeId, employee.id),
          inArray(payrollRuns.status, ["approved", "paid"]),
        ),
      )
      .orderBy(desc(payrollRuns.period), desc(payrollRuns.id))
      .limit(1),
  ]);

  const attendanceState = todayAttendance?.needsReview
    ? "NEEDS_REVIEW"
    : todayAttendance?.checkOut
      ? "COMPLETE"
      : todayAttendance?.checkIn
        ? "CHECKED_IN"
        : "NOT_RECORDED";

  return {
    date: input.date,
    navigation: {
      ownerCenter: authority.capabilities.isExecutive,
      personal: true,
      work: true,
    },
    personal: {
      state: "READY",
      employee: {
        displayName: `${employee.firstName} ${employee.lastName}`.trim(),
        position: employee.position,
        department: employee.department,
      },
      attendance: {
        state: attendanceState,
        checkIn: todayAttendance?.checkIn ?? null,
        checkOut: todayAttendance?.checkOut ?? null,
        action: { destination: "SELF_ATTENDANCE", requiresStepUp: false },
      },
      focus: focus
        ? {
            ...focus,
            status: focus.status as "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER",
            action: { destination: "TASKS", requiresStepUp: false },
          }
        : null,
      leave: leave
        ? {
            ...leave,
            action: { destination: "SELF_LEAVE", requiresStepUp: false },
          }
        : null,
      payroll: payroll
        ? {
            period: payroll.period,
            status: payroll.status as "approved" | "paid",
            action: { destination: "SELF_PAYROLL", requiresStepUp: true },
          }
        : null,
    },
  };
}

export async function getMobileAttendanceHistory(input: {
  actor: MobileTodayActor;
  /** Server-derived Baghdad business day — never a client query parameter. */
  date: string;
  db?: DB;
}): Promise<MobileAttendanceHistory> {
  const db = input.db ?? requireDb();
  const [employee] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.userId, input.actor.userId))
    .limit(1);
  const from = dateBefore(input.date, 30);

  if (!employee) {
    return {
      range: { from, to: input.date },
      personal: { state: "NOT_LINKED", entries: [] },
    };
  }

  const rows = await db
    .select({
      date: attendance.attendanceDate,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
      status: attendance.status,
      hours: attendance.hours,
      needsReview: attendance.needsReview,
    })
    .from(attendance)
    .where(
      and(
        eq(attendance.employeeId, employee.id),
        gte(attendance.attendanceDate, from),
        // The server date provides an inclusive upper bound and avoids the
        // client manufacturing a future or overly broad attendance period.
        lte(attendance.attendanceDate, input.date),
      ),
    )
    .orderBy(desc(attendance.attendanceDate))
    .limit(31);

  return {
    range: { from, to: input.date },
    personal: {
      state: "READY",
      entries: rows.map((row) => ({
        date: row.date,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        status: row.status,
        hours: row.hours == null ? null : String(row.hours),
        state: row.needsReview ? "NEEDS_REVIEW" : "RECORDED",
      })),
    },
  };
}

/**
 * Returns only the latest approved or paid line belonging to the authenticated
 * employee. The screen cannot choose a payroll id, period, peer, or branch;
 * the enclosing Expo mutation first consumes a new server-side second factor.
 */
export async function getMobilePayslip(input: {
  actor: MobileTodayActor;
  db?: DB;
}): Promise<MobilePayslip> {
  const db = input.db ?? requireDb();
  const [employee] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.userId, input.actor.userId))
    .limit(1);

  if (!employee) {
    return { personal: { state: "NOT_LINKED", payslip: null } };
  }

  const [row] = await db
    .select({
      period: payrollRuns.period,
      status: payrollRuns.status,
      paidAt: payrollRuns.paidAt,
      payType: payrollItems.payType,
      hours: payrollItems.hours,
      gross: payrollItems.gross,
      allowances: payrollItems.allowances,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      deductions: payrollItems.deductions,
      advanceDeduction: payrollItems.advanceDeduction,
      socialSecurityEmployee: payrollItems.socialSecurityEmployee,
      incomeTax: payrollItems.incomeTax,
      net: payrollItems.net,
    })
    .from(payrollItems)
    .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
    .where(
      and(
        eq(payrollItems.employeeId, employee.id),
        inArray(payrollRuns.status, ["approved", "paid"]),
      ),
    )
    .orderBy(desc(payrollRuns.period), desc(payrollRuns.id), desc(payrollItems.id))
    .limit(1);

  return {
    personal: {
      state: "READY",
      payslip: row
        ? {
            period: row.period,
            status: row.status as "approved" | "paid",
            paidAt: row.paidAt,
            payType: row.payType,
            hours: row.hours == null ? null : String(row.hours),
            gross: String(row.gross),
            allowances: String(row.allowances),
            overtime: String(row.overtime),
            commission: String(row.commission),
            deductions: String(row.deductions),
            advanceDeduction: String(row.advanceDeduction),
            socialSecurityEmployee: String(row.socialSecurityEmployee),
            incomeTax: String(row.incomeTax),
            net: String(row.net),
          }
        : null,
    },
  };
}
