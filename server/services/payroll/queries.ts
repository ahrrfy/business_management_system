// قراءة مسيّرات الرواتب: قائمة المسيّرات ومسيّر واحد ببنوده (مع بيانات الموظف المعروضة).
import { desc, eq, getTableColumns } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { employees, payrollItems, payrollRuns } from "../../../drizzle/schema";
import { requireDb } from "../tx";

export async function listRuns() {
  const db = requireDb();
  const rows = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.period), desc(payrollRuns.id));
  return rows;
}

export async function getRun(id: number) {
  const db = requireDb();
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1);
  if (!run) return null;
  const items = await db
    .select({
      ...getTableColumns(payrollItems),
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      department: employees.department,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      employmentStatus: employees.employmentStatus,
      baseSalary: employees.salary,
    })
    .from(payrollItems)
    .leftJoin(employees, eq(payrollItems.employeeId, employees.id))
    .where(eq(payrollItems.runId, id))
    .orderBy(payrollItems.id);
  return {
    ...run,
    items: items.map((it) => ({ ...it, employeeName: fullEmployeeName(it) })),
  };
}
