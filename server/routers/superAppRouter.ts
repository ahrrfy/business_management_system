import {
  PERMISSION_MODULES,
  ROLES,
  resolvePermissions,
  type AccessLevel,
  type RoleKey,
} from "@shared/permissions";
import { and, asc, eq, inArray } from "drizzle-orm";
import { attendance, employees, tasks } from "../../drizzle/schema";
import { requireDb } from "../services/tx";
import { protectedProcedure, router } from "../trpc";

/**
 * A compact session contract for the mobile shell. Domain routers remain the
 * only authority for data writes; this endpoint only tells the client what
 * workspace it is allowed to compose for the signed-in user.
 */
function isVisible(level: AccessLevel | undefined): boolean {
  return level === "FULL" || level === "READ";
}

function baghdadDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

export const superAppRouter = router({
  bootstrap: protectedProcedure.query(({ ctx }) => {
    const role = ctx.user.role as RoleKey;
    const permissions = resolvePermissions(
      role,
      (ctx.user.permissionsOverride ?? null) as Record<
        string,
        AccessLevel
      > | null,
    );
    const roleInfo = ROLES.find((item) => item.key === role);

    return {
      user: {
        id: ctx.user.id,
        name: ctx.user.name ?? "",
        role,
        roleLabel: ctx.user.customRoleLabel ?? roleInfo?.label ?? role,
        branchId: ctx.user.branchId ?? null,
      },
      scope: {
        branchId: ctx.user.branchId ?? null,
        allBranches:
          role === "admin" || role === "manager",
      },
      modules: PERMISSION_MODULES.filter((module) =>
        isVisible(permissions[module.key]),
      ).map((module) => ({
        key: module.key,
        label: module.label,
        access: permissions[module.key] as AccessLevel,
      })),
      capabilities: {
        canSeeCost: Boolean(roleInfo?.canSeeCost),
        hasPersonalWorkspace: true,
        supportsNotifications: true,
      },
      generatedAt: new Date().toISOString(),
    };
  }),

  /**
   * Personal data is deliberately read from the user's own employee record,
   * rather than through the HR dashboard. This keeps the employee workspace
   * useful without exposing payroll or other employees' records.
   */
  myWorkspace: protectedProcedure.query(async ({ ctx }) => {
    const db = requireDb();
    const [employee] = await db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        position: employees.position,
        department: employees.department,
        branchId: employees.branchId,
        photoUrl: employees.photoUrl,
        employmentStatus: employees.employmentStatus,
      })
      .from(employees)
      .where(eq(employees.userId, ctx.user.id))
      .limit(1);

    const activeTasks = await db
      .select({
        id: tasks.id,
        taskNumber: tasks.taskNumber,
        title: tasks.title,
        priority: tasks.priority,
        status: tasks.taskStatus,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, ctx.user.id),
          inArray(tasks.taskStatus, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"]),
        ),
      )
      .orderBy(asc(tasks.dueAt), asc(tasks.createdAt))
      .limit(5);

    const today = baghdadDate();
    const [todayAttendance] = employee
      ? await db
          .select({
            date: attendance.attendanceDate,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            status: attendance.status,
            hours: attendance.hours,
            source: attendance.source,
            needsReview: attendance.needsReview,
          })
          .from(attendance)
          .where(
            and(
              eq(attendance.employeeId, employee.id),
              eq(attendance.attendanceDate, today),
            ),
          )
          .limit(1)
      : [];

    return {
      date: today,
      employee: employee
        ? {
            id: employee.id,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
            position: employee.position,
            department: employee.department,
            branchId: employee.branchId,
            photoUrl: employee.photoUrl,
            employmentStatus: employee.employmentStatus,
          }
        : null,
      attendance: todayAttendance
        ? {
            ...todayAttendance,
            // The client can show this as a verified device event, but has no
            // mutation path to create or alter it.
            readOnly: true,
          }
        : null,
      tasks: activeTasks,
    };
  }),
});
