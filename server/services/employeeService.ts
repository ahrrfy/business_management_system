/* ============================================================================
 * خدمة الموظفين — وحدة الموارد البشرية (server/services/employeeService.ts)
 * شريحة الأساس: CRUD + قائمة بفلاتر + تغيير حالة التوظيف. الأجر الشهري/بالساعة يُخزَّن،
 * أما حساب الرواتب/الحضور فشرائح لاحقة. المبالغ عبر money.ts (toDbMoney).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, like, or, sql } from "drizzle-orm";
import { fullEmployeeName, type EmployeeEducation } from "@shared/hr";
import { branches, employees } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { toDbMoney } from "./money";
import { extractInsertId } from "../lib/insertId";
import { getEmployeeUsage, isFkBlocked, usageBlockMessage } from "./entityUsage";

export interface EmployeeFilters {
  q?: string;
  department?: string;
  branchId?: number;
  status?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export async function listEmployees(filters?: EmployeeFilters) {
  const db = requireDb();
  const conds = [];
  if (!filters?.includeInactive) conds.push(eq(employees.isActive, true));
  if (filters?.department) conds.push(eq(employees.department, filters.department));
  if (filters?.branchId) conds.push(eq(employees.branchId, filters.branchId));
  if (filters?.status) conds.push(eq(employees.employmentStatus, filters.status as never));
  if (filters?.q) {
    const t = `%${filters.q.trim()}%`;
    conds.push(
      or(
        like(employees.firstName, t),
        like(employees.fatherName, t),
        like(employees.lastName, t),
        like(employees.phone, t),
        like(employees.nationalId, t),
        like(employees.position, t),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(filters?.limit ?? 50, 200);
  const offset = filters?.offset ?? 0;

  const rows = await db
    .select({ ...getTableColumns(employees), branchName: branches.name })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(where)
    .orderBy(desc(employees.id))
    .limit(limit)
    .offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(where);

  return { rows: rows.map((r) => ({ ...r, fullName: fullEmployeeName(r) })), total: Number(count) };
}

export async function getEmployee(id: number) {
  const db = requireDb();
  const [e] = await db
    .select({ ...getTableColumns(employees), branchName: branches.name })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(eq(employees.id, id))
    .limit(1);
  if (!e) return null;
  let managerName: string | null = null;
  if (e.managerId) {
    const [m] = await db.select().from(employees).where(eq(employees.id, e.managerId)).limit(1);
    if (m) managerName = fullEmployeeName(m);
  }
  return { ...e, fullName: fullEmployeeName(e), managerName };
}

/** خيارات النماذج: الفروع + المدراء المحتملون (موظفون على رأس العمل). */
export async function formOptions() {
  const db = requireDb();
  const [brs, mgrs] = await Promise.all([
    db.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name),
    db
      .select({ id: employees.id, firstName: employees.firstName, fatherName: employees.fatherName, grandfatherName: employees.grandfatherName, lastName: employees.lastName, position: employees.position })
      .from(employees)
      .where(and(eq(employees.isActive, true), eq(employees.employmentStatus, "active")))
      .orderBy(employees.firstName),
  ]);
  return {
    branches: brs,
    managers: mgrs.map((m) => ({ id: m.id, name: fullEmployeeName(m), position: m.position })),
  };
}

export interface EmployeeInput {
  firstName: string;
  fatherName?: string | null;
  grandfatherName?: string | null;
  lastName: string;
  position?: string | null;
  department?: string | null;
  branchId?: number | null;
  managerId?: number | null;
  payType: "monthly" | "hourly";
  salary?: string | null;
  allowances?: string | null;
  dayRates?: Record<string, number> | null;
  hireDate?: string | null;
  gender?: string | null;
  birthDate?: string | null;
  maritalStatus?: string | null;
  nationality?: string | null;
  phone?: string | null;
  email?: string | null;
  governorate?: string | null;
  district?: string | null;
  addressLandmark?: string | null;
  nationalId?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  colorTag?: string | null;
  photoUrl?: string | null;
  education?: EmployeeEducation[] | null;
  annualLeaveBalance?: number | null;
  sickLeaveBalance?: number | null;
}

function toValues(input: EmployeeInput) {
  return {
    firstName: input.firstName.trim(),
    fatherName: input.fatherName?.trim() || null,
    grandfatherName: input.grandfatherName?.trim() || null,
    lastName: input.lastName.trim(),
    position: input.position?.trim() || null,
    department: input.department?.trim() || null,
    branchId: input.branchId ?? null,
    managerId: input.managerId ?? null,
    payType: input.payType,
    salary: input.salary != null && input.salary !== "" ? toDbMoney(input.salary) : null,
    allowances: toDbMoney(input.allowances ?? "0"),
    dayRates: input.dayRates ?? null,
    hireDate: input.hireDate || null,
    gender: input.gender?.trim() || null,
    birthDate: input.birthDate || null,
    maritalStatus: input.maritalStatus?.trim() || null,
    nationality: input.nationality?.trim() || null,
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    governorate: input.governorate?.trim() || null,
    district: input.district?.trim() || null,
    addressLandmark: input.addressLandmark?.trim() || null,
    nationalId: input.nationalId?.trim() || null,
    emergencyContactName: input.emergencyContactName?.trim() || null,
    emergencyContactPhone: input.emergencyContactPhone?.trim() || null,
    colorTag: input.colorTag?.trim() || null,
    photoUrl: input.photoUrl || null,
    education: input.education ?? null,
    annualLeaveBalance: input.annualLeaveBalance ?? 0,
    sickLeaveBalance: input.sickLeaveBalance ?? 0,
  };
}

export async function createEmployee(input: EmployeeInput) {
  const db = requireDb();
  const [res] = await db.insert(employees).values({ ...toValues(input), employmentStatus: "active", isActive: true });
  return getEmployee(extractInsertId(res));
}

export async function updateEmployee(id: number, input: EmployeeInput) {
  const db = requireDb();
  const [e] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
  if (!e) throw new Error("الموظف غير موجود");
  await db.update(employees).set(toValues(input)).where(eq(employees.id, id));
  return getEmployee(id);
}

/**
 * حذف موظف نهائياً — مسموح فقط للموظف «النظيف» (لا حضور/عُهد/رواتب/إجازات/ترقيات/إنهاءات).
 * غير النظيف يُمنع حذفه ويُعرض «إنهاء الخدمة» بديلاً. قيد FK حارس نهائي ضدّ التيتيم.
 */
export async function deleteEmployee(id: number) {
  return withTx(async (tx) => {
    const [e] = await tx.select().from(employees).where(eq(employees.id, id)).for("update").limit(1);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    const usage = await getEmployeeUsage(id, tx);
    if (!usage.clean) {
      throw new TRPCError({ code: "BAD_REQUEST", message: usageBlockMessage("هذا الموظف", usage) });
    }
    try {
      await tx.delete(employees).where(eq(employees.id, id));
    } catch (err) {
      if (isFkBlocked(err)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تعذّر الحذف: الموظف مرتبط بسجلّات في النظام — أنهِ خدمته بدل حذفه.",
        });
      }
      throw err;
    }
    return { id, deleted: true };
  });
}

/** تغيير حالة التوظيف: إنهاء خدمة (مع تاريخ وسبب) أو إعادة لرأس العمل أو وضعه بإجازة. */
export async function setEmploymentStatus(
  id: number,
  status: "active" | "leave" | "terminated",
  opts?: { terminationDate?: string; terminationReason?: string },
) {
  const db = requireDb();
  const [e] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
  if (!e) throw new Error("الموظف غير موجود");
  await db
    .update(employees)
    .set({
      employmentStatus: status,
      isActive: status !== "terminated",
      terminationDate: status === "terminated" ? opts?.terminationDate ?? null : null,
      terminationReason: status === "terminated" ? opts?.terminationReason ?? null : null,
    })
    .where(eq(employees.id, id));
  return getEmployee(id);
}
