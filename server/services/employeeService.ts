/* ============================================================================
 * خدمة الموظفين — وحدة الموارد البشرية (server/services/employeeService.ts)
 * شريحة الأساس: CRUD + قائمة بفلاتر + تغيير حالة التوظيف. الأجر الشهري/بالساعة يُخزَّن،
 * أما حساب الرواتب/الحضور فشرائح لاحقة. المبالغ عبر money.ts (toDbMoney).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, isNull, like, ne, or, sql } from "drizzle-orm";
import { fullEmployeeName, type EmployeeEducation } from "@shared/hr";
import { branches, employees, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import { requireDb, withTx, type Actor } from "./tx";
import { toDbMoney } from "./money";
import { extractInsertId } from "../lib/insertId";
import { escapeLike } from "../lib/sqlLike";
import { createUserTx, type CreateUserInput } from "./userService";
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
  // الحساب المرتبط (إن وُجد) — لتعبئة قسم «حساب النظام» في شاشة التعديل (نمط managerName).
  let linkedUser: { id: number; name: string | null; email: string | null; username: string | null; role: string } | null = null;
  if (e.userId) {
    const [u] = await db
      .select({ id: users.id, name: users.name, email: users.email, username: users.username, role: users.role })
      .from(users)
      .where(eq(users.id, e.userId))
      .limit(1);
    if (u) linkedUser = u;
  }
  return { ...e, fullName: fullEmployeeName(e), managerName, linkedUser };
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

/** إدراج موظف داخل معاملة قائمة (يُعيد المعرّف فقط) — للتركيب الذرّي مع إنشاء/ربط الحساب. */
export async function createEmployeeTx(tx: Tx, input: EmployeeInput): Promise<number> {
  const [res] = await tx.insert(employees).values({ ...toValues(input), employmentStatus: "active", isActive: true });
  return extractInsertId(res);
}

export async function createEmployee(input: EmployeeInput) {
  const id = await withTx((tx) => createEmployeeTx(tx, input));
  return getEmployee(id);
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

/* ============================================================================
 * ربط حساب النظام بالموظف — ثلاثة أوضاع: بلا حساب / إنشاء جديد / ربط موجود.
 * كل شيء ذرّي (withTx): إنشاء المستخدم + إدراج الموظف + الربط في معاملة واحدة ⇒
 * أي فشل (بريد مكرّر، سياسة كلمة مرور…) يُرجِع الكل فلا يبقى مستخدم يتيم بلا موظف.
 * علاقة واحد-لواحد: قيد DB فريد (uq_employee_user) + فحص خدمة (دفاع مزدوج).
 * ========================================================================== */

/** هل الخطأ تكرارٌ على قيد ربط الحساب (uq_employee_user)؟ (نمط rethrowDup في userService). */
function isDupUserId(e: any): boolean {
  const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;
  if (code !== "ER_DUP_ENTRY") return false;
  const msg = String(e?.sqlMessage ?? e?.cause?.sqlMessage ?? e?.message ?? "");
  return /uq_employee_user|userId/i.test(msg);
}

/** يتحقّق أن المستخدم موجود وغير مرتبط بموظف آخر (داخل معاملة، بقفل صفّ المستخدم). */
async function assertUserLinkable(tx: Tx, userId: number, excludeEmployeeId?: number): Promise<void> {
  const u = (await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
  if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب المراد ربطه غير موجود" });
  const conds = [eq(employees.userId, userId)];
  if (excludeEmployeeId) conds.push(ne(employees.id, excludeEmployeeId));
  const taken = (await tx.select({ id: employees.id }).from(employees).where(and(...conds)).limit(1))[0];
  if (taken) throw new TRPCError({ code: "CONFLICT", message: "هذا الحساب مرتبط بموظف آخر" });
}

/** يدمج تعبئة حساب المستخدم من حقول الموظف (تجنّب الإدخال المزدوج). */
function mergeUserFromEmployee(
  user: CreateUserInput,
  emp: { phone?: string | null; position?: string | null; hireDate?: string | null; branchId?: number | null },
): CreateUserInput {
  return {
    ...user,
    phone: user.phone ?? emp.phone ?? null,
    jobTitle: user.jobTitle ?? emp.position ?? null,
    hiredAt: user.hiredAt ?? emp.hireDate ?? null,
    branchId: user.branchId ?? emp.branchId ?? null,
  };
}

export type AccountSpec =
  | { mode: "none" }
  | { mode: "new"; user: CreateUserInput }
  | { mode: "link"; userId: number };

/**
 * إنشاء موظف مع (اختياراً) حساب نظام مرتبط — ذرّياً.
 * - none: موظف فقط.
 * - new: ينشئ مستخدماً (مع تعبئة الهاتف/المسمّى/الفرع من الموظف) ويربطه.
 * - link: يربط حساباً قائماً غير مرتبط بموظف آخر.
 */
export async function createEmployeeWithAccount(
  input: EmployeeInput,
  account: AccountSpec,
  actor: Actor,
): Promise<{ employeeId: number; userId: number | null }> {
  return withTx(async (tx) => {
    let userId: number | null = null;
    if (account.mode === "new") {
      const merged = mergeUserFromEmployee(account.user, input);
      ({ userId } = await createUserTx(tx, merged, actor));
    } else if (account.mode === "link") {
      await assertUserLinkable(tx, account.userId);
      userId = account.userId;
    }
    const employeeId = await createEmployeeTx(tx, input);
    if (userId != null) {
      try {
        await tx.update(employees).set({ userId }).where(eq(employees.id, employeeId));
      } catch (e) {
        if (isDupUserId(e)) throw new TRPCError({ code: "CONFLICT", message: "هذا الحساب مرتبط بموظف آخر" });
        throw e;
      }
    }
    return { employeeId, userId };
  });
}

/** ربط حساب قائم بموظف قائم (وضع التعديل). يرفض إن كان للموظف حساب مسبقاً. */
export async function linkEmployeeAccount(employeeId: number, userId: number) {
  await withTx(async (tx) => {
    const [e] = await tx.select({ id: employees.id, userId: employees.userId }).from(employees).where(eq(employees.id, employeeId)).for("update").limit(1);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    if (e.userId) throw new TRPCError({ code: "CONFLICT", message: "هذا الموظف مرتبط بحساب بالفعل — افكك الربط أولاً" });
    await assertUserLinkable(tx, userId, employeeId);
    try {
      await tx.update(employees).set({ userId }).where(eq(employees.id, employeeId));
    } catch (err) {
      if (isDupUserId(err)) throw new TRPCError({ code: "CONFLICT", message: "هذا الحساب مرتبط بموظف آخر" });
      throw err;
    }
  });
  return getEmployee(employeeId);
}

/** فكّ ربط الحساب عن الموظف — يفصل فقط (userId=null) ولا يحذف المستخدم. */
export async function unlinkEmployeeAccount(employeeId: number) {
  await withTx(async (tx) => {
    const [e] = await tx.select({ id: employees.id, userId: employees.userId }).from(employees).where(eq(employees.id, employeeId)).for("update").limit(1);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    if (!e.userId) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد حساب مرتبط بهذا الموظف" });
    await tx.update(employees).set({ userId: null }).where(eq(employees.id, employeeId));
  });
  return getEmployee(employeeId);
}

/** إنشاء حساب نظام جديد لموظف قائم وربطه — ذرّياً (وضع التعديل). */
export async function createAccountForEmployee(employeeId: number, user: CreateUserInput, actor: Actor) {
  let userId = 0;
  await withTx(async (tx) => {
    const [e] = await tx
      .select({ id: employees.id, userId: employees.userId, phone: employees.phone, position: employees.position, hireDate: employees.hireDate, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .for("update")
      .limit(1);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    if (e.userId) throw new TRPCError({ code: "CONFLICT", message: "هذا الموظف مرتبط بحساب بالفعل" });
    const merged = mergeUserFromEmployee(user, e);
    ({ userId } = await createUserTx(tx, merged, actor));
    try {
      await tx.update(employees).set({ userId }).where(eq(employees.id, employeeId));
    } catch (err) {
      if (isDupUserId(err)) throw new TRPCError({ code: "CONFLICT", message: "هذا الحساب مرتبط بموظف آخر" });
      throw err;
    }
  });
  return { employee: await getEmployee(employeeId), userId };
}

/** قائمة الحسابات القابلة للربط: مستخدمون نشطون غير مرتبطين بأي موظف (مع بحث اختياري). */
export async function listLinkableUsers(opts: { q?: string; limit?: number; employeeId?: number } = {}) {
  const db = requireDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const conds: any[] = [eq(users.isActive, true)];
  // غير مرتبط بأي موظف — أو مرتبط بنفس الموظف الجاري تعديله (للسماح بإعادة اختياره).
  if (opts.employeeId) {
    conds.push(or(isNull(employees.id), eq(employees.id, opts.employeeId)));
  } else {
    conds.push(isNull(employees.id));
  }
  if (opts.q?.trim()) {
    const q = `%${escapeLike(opts.q.trim())}%`;
    conds.push(or(like(users.name, q), like(users.email, q), like(users.username, q)));
  }
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, username: users.username, role: users.role })
    .from(users)
    .leftJoin(employees, eq(employees.userId, users.id))
    .where(and(...conds))
    .orderBy(users.name)
    .limit(limit);
  return rows;
}
