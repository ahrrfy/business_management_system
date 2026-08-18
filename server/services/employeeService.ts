/* ============================================================================
 * خدمة الموظفين — وحدة الموارد البشرية (server/services/employeeService.ts)
 * شريحة الأساس: CRUD + قائمة بفلاتر + تغيير حالة التوظيف. الأجر الشهري/بالساعة يُخزَّن،
 * أما حساب الرواتب/الحضور فشرائح لاحقة. المبالغ عبر money.ts (toDbMoney).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import { fullEmployeeName, type EmployeeEducation } from "@shared/hr";
import { branches, employees, hrDeviceUsers, roles, users } from "../../drizzle/schema";
// اليوم التجاريّ ببغداد لا UTC: عند الواحدة ليلاً يكون تاريخ UTC هو **أمس**، فيُحدّ الربط
// بيومٍ سابقٍ ويضيع يومُ الإنهاء نفسه — وهو عين ما جاء هذا التغيير لينقذه.
import { baghdadToday } from "./businessDay";
import type { Tx } from "../db";
import { requireDb, withTx, type Actor } from "./tx";
import { toDbMoney } from "./money";
import { extractInsertId } from "../lib/insertId";
import { escapeLike } from "../lib/sqlLike";
import { assertNotLastActiveAdmin, createUserTx, type CreateUserInput } from "./userService";
import { assertCanDisablePrivilegedUser } from "./userAdminPolicy";
import { getEmployeeUsage, isFkBlocked, usageBlockMessage } from "./entityUsage";
import { listEmployeeDeviceLinks } from "./hrDeviceService";
import { WAGE_FIELD_LABELS, wageProfileDiff, wageProfileOf } from "./hr/wageProfile";
import { resolveTargetBranch, type CompanyBranchScope } from "./companyBranchScope";

const COMPANY_SCOPE: CompanyBranchScope = { branchId: null };

function employeeScopeCondition(scope: CompanyBranchScope) {
  return scope.branchId == null ? undefined : eq(employees.branchId, scope.branchId);
}

function employeeByIdCondition(id: number, scope: CompanyBranchScope) {
  const branch = employeeScopeCondition(scope);
  return branch ? and(eq(employees.id, id), branch) : eq(employees.id, id);
}

export interface EmployeeFilters {
  q?: string;
  department?: string;
  branchId?: number;
  status?: string;
  /** طريقة الأجر (monthly/hourly) — فلترة اختيارية لمنتقيات مقصورة على نمط أجرٍ بعينه. */
  payType?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export async function listEmployees(filters?: EmployeeFilters, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const conds = [];
  const scopedBranch = employeeScopeCondition(scope);
  if (scopedBranch) conds.push(scopedBranch);
  if (!filters?.includeInactive) conds.push(eq(employees.isActive, true));
  if (filters?.department) conds.push(eq(employees.department, filters.department));
  if (filters?.branchId) conds.push(eq(employees.branchId, filters.branchId));
  if (filters?.status) conds.push(eq(employees.employmentStatus, filters.status as never));
  if (filters?.payType) conds.push(eq(employees.payType, filters.payType as never));
  if (filters?.q) {
    const t = `%${escapeLike(filters.q.trim())}%`;
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
    .select({
      ...getTableColumns(employees),
      branchName: branches.name,
      // مربوط بجهاز حضور؟ EXISTS مترابط لا JOIN — الربط قد يتعدّد (جهازان) فالانضمام يُضاعف الصفوف.
      // يُغذّي شارة «غير مربوط» في القائمة: بلا ربطٍ لا تصل بصماته أصلاً لسجل الحضور.
      deviceLinked: sql<number>`EXISTS (SELECT 1 FROM ${hrDeviceUsers} WHERE ${hrDeviceUsers.employeeId} = ${employees.id})`,
    })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(where)
    .orderBy(desc(employees.id))
    .limit(limit)
    .offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(employees).where(where);

  return {
    rows: rows.map((r) => ({ ...r, fullName: fullEmployeeName(r), deviceLinked: Number(r.deviceLinked) === 1 })),
    total: Number(count),
  };
}

export async function getEmployee(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const [e] = await db
    .select({ ...getTableColumns(employees), branchName: branches.name })
    .from(employees)
    .leftJoin(branches, eq(employees.branchId, branches.id))
    .where(employeeByIdCondition(id, scope))
    .limit(1);
  if (!e) return null;
  let managerName: string | null = null;
  if (e.managerId) {
    const [m] = await db.select().from(employees).where(employeeByIdCondition(e.managerId, scope)).limit(1);
    if (m) managerName = fullEmployeeName(m);
  }
  // الحساب المرتبط (إن وُجد) — لتعبئة قسم «حساب النظام» في شاشة التعديل (نمط managerName).
  // customRoleLabel: تسمية الدور المخصّص النشط (شرط isActive يطابق دلالة الإنفاذ في loadActiveCustomRole).
  let linkedUser: { id: number; name: string | null; email: string | null; username: string | null; role: string; customRoleLabel: string | null } | null = null;
  if (e.userId) {
    const [u] = await db
      .select({ id: users.id, name: users.name, email: users.email, username: users.username, role: users.role, customRoleLabel: roles.label })
      .from(users)
      .leftJoin(roles, and(eq(users.customRoleId, roles.id), eq(roles.isActive, true)))
      .where(eq(users.id, e.userId))
      .limit(1);
    if (u) linkedUser = u;
  }
  // ربوط جهاز الحضور — تُعرَض وتُدار من بطاقة الموظف، ومصدر حقيقتها يبقى hrDeviceUsers
  // (علاقة تحتمل جهازين للفرعين واستبدال جهازٍ تالف، لا حقلاً مكرَّراً على employees).
  const deviceLinks = await listEmployeeDeviceLinks(id, scope);
  return { ...e, fullName: fullEmployeeName(e), managerName, linkedUser, deviceLinks };
}

/** Mask employee identifiers outside the authenticated branch as NOT_FOUND. */
export async function assertEmployeeInScope(id: number, scope: CompanyBranchScope): Promise<void> {
  const db = requireDb();
  const [row] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(employeeByIdCondition(id, scope))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
}

/** خيارات النماذج: الفروع + المدراء المحتملون (موظفون على رأس العمل). */
export async function formOptions(scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const branchScope = employeeScopeCondition(scope);
  const managerConditions = [eq(employees.isActive, true), eq(employees.employmentStatus, "active")];
  if (branchScope) managerConditions.push(branchScope);
  const [brs, mgrs] = await Promise.all([
    db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(scope.branchId == null ? undefined : eq(branches.id, scope.branchId))
      .orderBy(branches.name),
    db
      .select({ id: employees.id, firstName: employees.firstName, fatherName: employees.fatherName, grandfatherName: employees.grandfatherName, lastName: employees.lastName, position: employees.position })
      .from(employees)
      .where(and(...managerConditions))
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
  workSchedule?: Record<string, { hours: number; rate?: number | null }> | null;
  attendanceExempt?: boolean;
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
    workSchedule: input.workSchedule ?? null,
    // الإعفاء من الحضور مفهومٌ شهريٌّ بحت: أجر الساعيّ = ساعاتُ حضوره المسجَّلة، فلا راتبَ
    // ثابتاً يُعفى منه. تثبيتُه هنا يمنع حالةً متناقضةً في القاعدة مهما أرسلت الواجهة.
    attendanceExempt: input.payType === "hourly" ? false : (input.attendanceExempt ?? false),
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

export async function createEmployee(input: EmployeeInput, scope: CompanyBranchScope = COMPANY_SCOPE) {
  if (input.managerId != null) await assertEmployeeInScope(input.managerId, scope);
  const branchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const id = await withTx((tx) => createEmployeeTx(tx, { ...input, branchId }));
  return getEmployee(id, scope);
}

/**
 * تعديل بيانات الموظف. يُعيد `wageChange` (البصمة الأجرية قبل/بعد + الحقول التي تغيّرت)
 * ليُسجَّل في التدقيق — تغييرُ أجرٍ بلا أثرٍ يُسمّي القيمة القديمة كان يجعل قفزة
 * `payrollRuns.totalNet` غير قابلة للتفسير.
 *
 * ⚠️ **الأجر لا يُغيَّر من هنا لغير المدير**، ومعنى «الأجر» هو **البصمة الأجرية** كاملةً
 * (`hr/wageProfile.ts`): الراتب والبدلات وجدول الدوام وأسعار الأيام والإعفاء من الحضور
 * وطريقة الأجر. حصرُ الحارس بحقلَي `salary`/`allowances` كان يترك بابَ التفافٍ مفتوحاً:
 * صاحبُ hr/FULL يخفض ساعات جدوله فيرتفع سعر ساعته المُشتقّ ويتحوّل فائضُ حضوره أوفر
 * تايم بالسعر الأعلى ⇒ يُضاعف أجره بلا لمس حقل «الراتب» (مراجعة Codex على PR #446).
 * المسار المشروع لكلّ ذلك: «الترقيات» — فصلُ مهام (معتمِد ≠ مُنشئ) وتاريخ سريان وسجلّ،
 * وهي تحمل **حزمة الأجر كاملةً** منذ هجرة 0143 فلا يبقى تغييرٌ بلا طريق.
 *
 * وحقول الحزمة **المحذوفة من الحمولة تبقى كما هي** (`undefined` = لا تُمسّ): النموذج
 * لا يرسل `dayRates` للموظف الشهريّ، وكان `?? null` يمحو أسعار أيامه صامتاً عند أيّ
 * تعديلٍ عابر — خسارةُ بيانات وتغييرُ بصمةٍ زائفٌ في آن.
 */
export async function updateEmployee(
  id: number,
  input: EmployeeInput,
  actor?: { userId: number; role: string },
  scope: CompanyBranchScope = COMPANY_SCOPE,
) {
  const db = requireDb();
  const [e] = await db.select().from(employees).where(employeeByIdCondition(id, scope)).limit(1);
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });

  if (input.managerId != null) await assertEmployeeInScope(input.managerId, scope);
  const branchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const base = toValues({ ...input, branchId });
  const keptExempt = input.attendanceExempt === undefined ? !!e.attendanceExempt : !!input.attendanceExempt;
  const next = {
    ...base,
    ...(input.dayRates === undefined ? { dayRates: e.dayRates } : {}),
    ...(input.workSchedule === undefined ? { workSchedule: e.workSchedule } : {}),
    attendanceExempt: input.payType === "hourly" ? false : keptExempt,
  };

  const fromWage = wageProfileOf(e);
  const toWage = wageProfileOf(next);
  const changedWage = wageProfileDiff(fromWage, toWage);
  if (changedWage.length && actor && actor.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        `تغيير الأجر لا يتمّ من شاشة تعديل الموظف (${changedWage.map((f) => WAGE_FIELD_LABELS[f]).join("، ")}) — ` +
        "استعمل «الترقيات» (تمرّ باعتماد مديرٍ آخر وتاريخ سريان وسجلّ تاريخيّ).",
    });
  }

  await db.update(employees).set(next).where(employeeByIdCondition(id, scope));
  const updated = await getEmployee(id, scope);
  return {
    ...updated!,
    wageChange: changedWage.length ? { fields: changedWage, from: fromWage, to: toWage } : null,
  };
}

/**
 * حذف موظف نهائياً — مسموح فقط للموظف «النظيف» (لا حضور/عُهد/رواتب/إجازات/ترقيات/إنهاءات).
 * غير النظيف يُمنع حذفه ويُعرض «إنهاء الخدمة» بديلاً. قيد FK حارس نهائي ضدّ التيتيم.
 */
export async function deleteEmployee(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  return withTx(async (tx) => {
    const [e] = await tx.select().from(employees).where(employeeByIdCondition(id, scope)).for("update").limit(1);
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
  opts?: {
    terminationDate?: string;
    terminationReason?: string;
    actorUserId?: number;
    actorRole?: string;
    actorIsOwner?: boolean;
  },
  scope: CompanyBranchScope = COMPANY_SCOPE,
) {
  const actorUserId = opts?.actorUserId ?? null;
  const effects = await withTx(async (tx) => {
    const [e] = await tx.select().from(employees).where(employeeByIdCondition(id, scope)).for("update").limit(1);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    await tx
      .update(employees)
      .set({
        employmentStatus: status,
        isActive: status !== "terminated",
        terminationDate: status === "terminated" ? opts?.terminationDate ?? null : null,
        terminationReason: status === "terminated" ? opts?.terminationReason ?? null : null,
      })
      .where(employeeByIdCondition(id, scope));

    /*
     * **إعادةُ التفعيل ترفع الحدّ** (0205): الربط لم يعد يُقطع عند الإنهاء بل يُحدّ بـ`effectiveTo`،
     * فصفُّه يبقى قائماً. وتركُ الحدّ مضروباً على موظفٍ عاد إلى رأس العمل يُهمل بصماته **صامتاً**
     * — وهو نفس عطب «يومٍ يضيع بلا أثر» الذي جاء العمود لإصلاحه، معكوساً. يسبق العودةَ المبكرة
     * عمداً: قبل 0205 كان القطع نهائياً فيلزم ربطٌ يدويّ جديد، والآن الصفّ حيٌّ فيلزم رفعُ حدّه.
     */
    if (status !== "terminated") {
      const restored = await tx
        .update(hrDeviceUsers)
        .set({ effectiveTo: null })
        .where(and(eq(hrDeviceUsers.employeeId, id), isNotNull(hrDeviceUsers.effectiveTo)));
      return {
        userDisabled: false,
        deviceLinksReleased: 0,
        deviceLinksRestored: Number((restored as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0),
      };
    }

    /*
     * إنهاء الخدمة يُغلق بابَي وصولٍ يبقيان مفتوحين لولا ذلك — ذرّياً مع تغيير الحالة:
     *
     * (١) حساب النظام: موظفٌ مفصول بحسابٍ فعّال يظلّ يدخل النظام ويبيع ويقبض من الغد.
     *     sessionsValidFrom يُبطل جلساته القائمة فوراً (لا ينتظر انتهاء الكوكي).
     *     الحساب يُعطَّل ولا يُحذف — سجلّاته المالية تبقى منسوبةً إليه.
     *
     * (٢) ربط جهاز الحضور: رقم الجهاز يُعاد استعماله لموظفٍ جديد (سلوك شائع في أجهزة
     *     محدودة السعة). لو بقي الربط، صارت بصمات الموظف الجديد تُنسب للمفصول وتُطوى
     *     إلى أيام حضور باسمه. تحرير الربط يترك الصفّ ورقمَه ونسخة قوالبه (تاريخٌ لا يُمحى)
     *     ويصفّر employeeId فقط ⇒ البصمات الجديدة تدخل طابور المراجعة بدل الإسناد الخاطئ.
     *     أيام الحضور المطويّة سابقاً لا تُمسّ.
     */
    let userDisabled = false;
    if (e.userId) {
      const [u] = await tx
        .select({ id: users.id, role: users.role, isOwner: users.isOwner, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, e.userId))
        .for("update")
        .limit(1);
      if (u) {
        assertCanDisablePrivilegedUser(
          { role: opts?.actorRole, isOwner: opts?.actorIsOwner },
          u,
        );
      }
      if (u?.isActive) {
        // لا يُقفَل النظام على نفسه: آخر مدير نشط لا يُعطَّل (نفس حارس setUserActive)،
        // ومَن ينهي خدمة سجلّه الشخصيّ لا يُطرَد من جلسته في منتصف العملية.
        if (u.role === "admin") await assertNotLastActiveAdmin(tx, u.id);
        if (actorUserId != null && Number(u.id) === Number(actorUserId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "لا تُنهِ خدمة سجلّك الشخصيّ — سيُعطَّل حسابك وتخرج فوراً. اطلب من مديرٍ آخر تنفيذها.",
          });
        }
        await tx.update(users).set({ isActive: false, sessionsValidFrom: new Date() }).where(eq(users.id, e.userId));
        userDisabled = true;
      }
    }
    /*
     * ⛔ **لا يُقطع الربط — يُحدُّ بتاريخ الإنهاء** (0205، تدقيق ١٧/٨ بند ٢١).
     *
     * كان هنا `{ employeeId: null, effectiveFrom: null }`: قطعٌ فوريّ أياً كان تاريخ الإنهاء.
     * وإنهاءُ الخدمة يقع طبيعياً **يومَ العمل الأخير نفسه**، فبصماتُ ذلك اليوم تصل بعد القطع
     * بلا صاحبٍ ⇒ يومُ عملٍ كاملٌ يُسجَّل صفر ساعات. ولا يُكتشف: أجرُ شهر الفصل يُكتب يدوياً
     * في تسوية نهاية الخدمة بلا مطابقةٍ مع سجلّ الحضور (بند ٤٣، شريحةٌ تالية).
     *
     * فبدل القطع نضع `effectiveTo` — والبصمات حتى ذلك اليوم **شاملاً** تُنسَب، وما بعده لا.
     * حارسُ إعادة استعمال رقم الجهاز يبقى قائماً بالطرفين معاً.
     *
     * وغيابُ تاريخ الإنهاء (إنهاءٌ بلا تاريخ) يقع على **اليوم التجاريّ الجاري**: تركُه `null`
     * يعني ربطاً بلا نهاية فتُنسب للمفصول بصماتُ من يرث رقمه — وهو العطب الذي بُني له
     * `effectiveFrom` أصلاً، معكوساً.
     */
    const linkEndsOn = status === "terminated" ? opts?.terminationDate ?? baghdadToday() : null;
    const res = await tx
      .update(hrDeviceUsers)
      .set({ effectiveTo: linkEndsOn })
      .where(eq(hrDeviceUsers.employeeId, id));
    const deviceLinksReleased = Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    return { userDisabled, deviceLinksReleased, deviceLinksRestored: 0 };
  });
  const e = await getEmployee(id, scope);
  return { ...e!, ...effects };
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
