/* ============================================================================
 * خدمة الترقيات وإنهاء الخدمات — وحدة الموارد البشرية (server/services/promotionService.ts)
 * - الترقيات: تُنشأ بحالة pending؛ اعتمادها (داخل withTx) يحدّث مسمّى/راتب الموظف.
 * - إنهاء الخدمات: يُنشأ بحالة pending؛ إكماله (داخل withTx) يضع الموظف «منتهي الخدمة»،
 *   يعطّل حسابه ويبطل جلساته، يحرّر ربط جهاز الحضور، ويُنشئ سند التسوية المعلّق ذرّياً.
 * المبالغ كلها عبر money.ts (toDbMoney). الكتابات متعددة الأطراف داخل withTx.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import type { Tx } from "../db";
import { todayUtcDate } from "./businessDay";
import {
  employeePromotions,
  employees,
  employeeTerminations,
  hrDeviceUsers,
  users,
} from "../../drizzle/schema";
import { requireDb, withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { money, toDbMoney } from "./money";
import { createSystemPaymentRequestTx } from "./voucher/create";
import {
  wageProfileColumns,
  wageProfileOf,
  type WageProfile,
} from "./hr/wageProfile";
import { companyBranchScope } from "./companyBranchScope";
import { assertNotLastActiveAdmin } from "./userService";
import { assertCanDisablePrivilegedUser } from "./userAdminPolicy";

/** يحتفظ بـnull الحقيقي للفرع حتى يفشل غير الأدمن بلا فرع مغلقاً، ولا يسقط صامتاً إلى الفرع 1. */
export type PromotionActor = Omit<Actor, "branchId"> & {
  branchId: number | null;
};

/* ===== الترقيات ===== */

/** استعلام الترقيات (مع اسم الموظف) — بمعرّف لصفّ واحد أو بلا معرّف للقائمة كاملةً.
 *  يلغي نمط «اجلب الكل ثم find» (N+1) في getPromotion. */
async function promotionRows(actor: PromotionActor, id?: number) {
  const db = requireDb();
  const scope = companyBranchScope(actor);
  const branchPredicate =
    scope.branchId == null ? undefined : eq(employees.branchId, scope.branchId);
  const base = db
    .select({
      id: employeePromotions.id,
      employeeId: employeePromotions.employeeId,
      fromTitle: employeePromotions.fromTitle,
      toTitle: employeePromotions.toTitle,
      fromSalary: employeePromotions.fromSalary,
      toSalary: employeePromotions.toSalary,
      effectiveDate: employeePromotions.effectiveDate,
      reason: employeePromotions.reason,
      status: employeePromotions.status,
      createdAt: employeePromotions.createdAt,
      approvedAt: employeePromotions.approvedAt,
      approvedBy: employeePromotions.approvedBy,
      // حزمة الأجر (0143) — تُعرَض للمعتمِد ليرى ما سيتغيّر فعلاً قبل الاعتماد.
      fromWage: employeePromotions.fromWage,
      toWage: employeePromotions.toWage,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
    })
    .from(employeePromotions)
    .leftJoin(employees, eq(employeePromotions.employeeId, employees.id));
  const rows =
    id != null
      ? await base
          .where(and(eq(employeePromotions.id, id), branchPredicate))
          .limit(1)
      : branchPredicate
        ? await base.where(branchPredicate).orderBy(desc(employeePromotions.id))
        : await base.orderBy(desc(employeePromotions.id));
  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

export async function listPromotions(actor: PromotionActor) {
  return promotionRows(actor);
}

/**
 * رقعةُ حزمة الأجر المطلوبة (0143) — أيّ مجموعةٍ جزئية من الحقول الحاملة للأجر.
 * ما لا يُمرَّر يُؤخذ من حالة الموظف وقت الإنشاء، فتُخزَّن **بصمةٌ هدفٌ كاملة**
 * (`toWage`) لا رقعةٌ تحتاج دمجاً لاحقاً بحالةٍ قد تكون تغيّرت قبل الاعتماد.
 */
export interface WagePatchInput {
  payType?: "monthly" | "hourly";
  salary?: string | null;
  allowances?: string | null;
  attendanceExempt?: boolean;
  dayRates?: Record<string, number> | null;
  workSchedule?: Record<string, { hours: number; rate?: number | null }> | null;
}

export interface PromotionInput {
  employeeId: number;
  /** يُترك فارغاً في تغييرٍ أجريٍّ بحت ⇒ يبقى المسمّى الحالي. */
  toTitle?: string | null;
  fromTitle?: string | null;
  fromSalary?: string | null;
  toSalary?: string | null;
  effectiveDate: string;
  reason?: string | null;
  /** حزمة الأجر الجديدة — غيابها يُبقي السلوك القديم (المسمّى والراتب وحدهما). */
  wage?: WagePatchInput | null;
}

/** يحذف المفاتيح غير المُمرَّرة حتى لا يطمس الانتشارُ (`spread`) قيمةَ الموظف بـundefined. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export async function createPromotion(
  input: PromotionInput,
  actor: PromotionActor,
) {
  const scope = companyBranchScope(actor);
  const newId = await withTx(async (tx) => {
    const [emp] = await tx
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.id, input.employeeId),
          scope.branchId == null
            ? undefined
            : eq(employees.branchId, scope.branchId),
        ),
      )
      .for("update")
      .limit(1);
    if (!emp)
      throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    // لقطة الحالة الحالية افتراضياً إن لم يمررها المستخدم.
    const fromTitle = input.fromTitle?.trim() || emp.position || null;
    const fromSalary =
      input.fromSalary != null && input.fromSalary !== ""
        ? toDbMoney(input.fromSalary)
        : (emp.salary ?? null);

    /*
     * حزمة الأجر (0143): الرقعة تُدمَج فوق بصمة الموظف الحالية ثمّ تُطبَّع، فيُخزَّن الهدف
     * كاملاً. `toSalary` يبقى عموداً مستقلاً (تعتمده الشاشة والتقرير والتصدير) ويُشتقّ
     * من الحزمة عند وجودها ⇒ مصدرُ تطبيقٍ واحدٌ لا اثنان متعارضان.
     */
    const fromWage = wageProfileOf(emp);
    const toWage = input.wage
      ? wageProfileOf({ ...emp, ...definedOnly(input.wage) })
      : null;

    /*
     * حارس سعر الساعيّ المؤجَّل (مراجعة Codex P1 على PR #449): أجرُ الموظف الساعيّ
     * **يُجمَّد في صفّ الحضور وقت تسجيله** (`recordAttendance` يكتب hourlyRate وamount)،
     * والمسيّر يجمع تلك المبالغ المخزّنة. أمّا الترقيات المؤجَّلة فتُطبَّق داخل توليد
     * المسيّر — أي **بعد** أن سُجّل حضورُ الشهر كلِّه بالسعر القديم. فتاريخُ سريانٍ
     * مستقبليٌّ على أسعار الساعات كان يَعِد بزيادةٍ لا تصل: أيامُ الشهر تُدفع بالقديم
     * والجديد يبدأ عملياً من الشهر التالي — خطأٌ صامتٌ في اتجاه بخس الأجر.
     * (الراتب/البدلات/الجدول/الإعفاء تُحتسب وقت التوليد ⇒ التأجيل يعمل لها بصحّة.)
     */
    if (
      toWage &&
      toWage.payType === "hourly" &&
      input.effectiveDate > todayUtcDate()
    ) {
      const ratesChanged =
        JSON.stringify(fromWage.dayRates) !== JSON.stringify(toWage.dayRates);
      if (ratesChanged || fromWage.payType !== toWage.payType) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "أسعار ساعات الموظف الساعيّ لا تقبل تاريخ سريانٍ مستقبليّ: أجرُ كلّ يومٍ يُثبَّت في سجلّ الحضور لحظة تسجيله، " +
            "فالتأجيل يعني دفعَ الشهر كلِّه بالسعر القديم. اجعل تاريخ السريان اليوم أو أنشئ الطلب حين يحين موعده.",
        });
      }
    }

    const toSalary = toWage
      ? toWage.salary
      : input.toSalary != null && input.toSalary !== ""
        ? toDbMoney(input.toSalary)
        : null;

    const [res] = await tx.insert(employeePromotions).values({
      employeeId: input.employeeId,
      fromTitle,
      // مسمّى فارغ = «لا تغيير في المسمّى» (تغييرٌ أجريٌّ بحت) — والتطبيق يتخطّى عمود
      // `position` حينها بدل أن يكتب فيه نصّاً بديلاً يصير مسمّى الموظف الفعليّ.
      toTitle: input.toTitle?.trim() || emp.position?.trim() || "",
      fromSalary,
      toSalary,
      effectiveDate: input.effectiveDate,
      reason: input.reason?.trim() || null,
      status: "pending",
      // SOD (تدقيق ١٧/٧): نُثبّت المُنشئ لفرض «المعتمِد ≠ المُنشئ» عند الاعتماد.
      createdBy: actor.userId,
      fromWage: toWage ? fromWage : null,
      toWage,
    });
    return extractInsertId(res);
  });
  return getPromotion(newId, actor);
}

async function getPromotion(id: number, actor: PromotionActor) {
  return (await promotionRows(actor, id))[0] ?? null;
}

/**
 * اعتماد الترقية (ذرّي): تُضبط الحالة approved (+ approvedAt/approvedBy)
 * ويُحدَّث الموظف: position = toTitle، salary = toSalary (إن وُجد).
 */
export async function approvePromotion(id: number, actor: PromotionActor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    const [p] = await tx
      .select()
      .from(employeePromotions)
      .where(eq(employeePromotions.id, id))
      .for("update")
      .limit(1);
    if (!p)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "سجل الترقية غير موجود",
      });

    // فحص الفرع يسبق أيّ كشفٍ لحالة السجل حتى لا يتحول المعرّف إلى مسبار IDOR.
    const [emp] = await tx
      .select({ employmentStatus: employees.employmentStatus })
      .from(employees)
      .where(
        and(
          eq(employees.id, p.employeeId),
          scope.branchId == null
            ? undefined
            : eq(employees.branchId, scope.branchId),
        ),
      )
      .for("update")
      .limit(1);
    if (!emp)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "سجل الترقية غير موجود",
      });
    if (p.status === "approved") throw new Error("الترقية معتمدة مسبقاً");

    // فصل المهام (تدقيق ١٧/٧): مرآةُ اعتماد الرواتب/السندات — المعتمِد ≠ المُنشئ (admin مُستثنى
    // للتصحيح الإداري). كان اعتماد ترقيةٍ (زيادة راتب) بفاعلٍ واحد ممكناً ⇒ إثراءٌ ذاتيّ.
    if (
      actor.role !== "admin" &&
      p.createdBy != null &&
      Number(p.createdBy) === actor.userId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "لا يجوز اعتماد ترقية أنشأتها بنفسك — يلزم مديرٌ آخر (فصل المهام).",
      });
    }

    // حارس حالة الموظف: لا تُعتمد ترقية موظف منتهي الخدمة.
    if (emp.employmentStatus === "terminated")
      throw new Error("لا يمكن ترقية موظف منتهي الخدمة");

    // effectiveDate (تدقيق ١٧/٧): كان يطبّق الراتب فوراً متجاهلاً تاريخاً مستقبلياً. الآن نطبّقه على
    // الموظف فقط إن حان التاريخ (≤ اليوم UTC)؛ وإلا نعتمد الترقية ونؤجّل التطبيق (appliedAt=null)
    // فتُطبَّق تلقائياً عند بلوغ تاريخها ضمن كنسة توليد الرواتب (applyDuePromotions).
    const due = p.effectiveDate <= todayUtcDate();
    await tx
      .update(employeePromotions)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedBy: actor.userId,
        appliedAt: due ? new Date() : null,
      })
      .where(eq(employeePromotions.id, id));

    if (due) await applyPromotionToEmployee(tx, p);

    return id;
  });
}

/**
 * تطبيق ترقيةٍ على سجلّ الموظف — نقطةُ الكتابة **الوحيدة** (الاعتماد الفوريّ والكنسة
 * المؤجَّلة كلاهما يمرّ بها) فلا ينحرف مسارٌ عن الآخر.
 *
 * ⚠️ **يُطبَّق ما تغيّر وحده، لا اللقطة كلّها** (مراجعة Codex P1 على PR #449): `toWage`
 * لقطةٌ كاملةٌ للحالة **وقت الإنشاء**، فكتابتُها بحذافيرها تعني أن طلبَين معلَّقَين على
 * نفس الموظف — أحدهما للراتب والآخر للجدول — يُلغي آخرُهما تطبيقاً ما اعتمده الأوّل
 * صامتاً (فقدُ تحديث). المقارنة بـ`fromWage` تُبقي كلَّ طلبٍ محصوراً في الحقول التي
 * قصدها صاحبُه، فيتراكب الطلبان بلا تدمير؛ وحين يتنازعان على نفس الحقل يفوز الأحدث
 * تطبيقاً (وهو ترتيبٌ صار حتمياً — انظر `applyDuePromotions`).
 * والمسمّى كذلك: يُكتَب فقط إن اختلف عن لقطته، وإلا أعاد طلبُ أجرٍ بحتٌ مسمّى قديماً.
 *
 * والصفوف القديمة (toWage=NULL) تسلك المسار السابق حرفياً بلا أثرٍ رجعيّ.
 */
async function applyPromotionToEmployee(
  tx: Tx,
  p: {
    employeeId: number;
    fromTitle: string | null;
    toTitle: string;
    fromSalary: string | null;
    toSalary: string | null;
    fromWage: unknown;
    toWage: unknown;
  },
): Promise<void> {
  const empPatch: Record<string, unknown> = {};
  // مسمّى فارغ ⇒ لا يُمسّ `position` (طلبُ أجرٍ بحت لموظفٍ بلا مسمّى مُسجَّل).
  if (p.toTitle && p.toTitle !== (p.fromTitle ?? ""))
    empPatch.position = p.toTitle;
  if (p.toWage && typeof p.toWage === "object") {
    const to = wageProfileColumns(p.toWage as WageProfile);
    // `fromWage` مكتوبٌ دائماً مع `toWage` (منذ 0143)؛ وغيابُه احتياطاً ⇒ تطبيقُ الكلّ.
    const from =
      p.fromWage && typeof p.fromWage === "object"
        ? wageProfileColumns(p.fromWage as WageProfile)
        : null;
    for (const key of Object.keys(to) as (keyof typeof to)[]) {
      if (!from || JSON.stringify(to[key]) !== JSON.stringify(from[key]))
        empPatch[key] = to[key];
    }
  } else if (p.toSalary != null) {
    empPatch.salary = toDbMoney(p.toSalary);
  }
  // رقعةٌ فارغة تجعل drizzle يرمي «No values to set» — والحالة ممكنة (طلبٌ اعتُمد ولم
  // يعُد يغيّر شيئاً). لا شيء ليُطبَّق ⇒ تُختَم الترقية مطبَّقةً بلا كتابةٍ على الموظف.
  if (Object.keys(empPatch).length === 0) return;
  await tx
    .update(employees)
    .set(empPatch)
    .where(eq(employees.id, p.employeeId));
}

/**
 * كنسة الترقيات المستحقّة (تدقيق ١٧/٧): تُطبّق كل ترقيةٍ معتمَدةٍ مؤجَّلةٍ (appliedAt=null) بلغ
 * تاريخُها (effectiveDate ≤ asOf) على راتب/مسمّى الموظف، وتَختم appliedAt. تُستدعى داخل معاملة توليد
 * الرواتب (asOf = آخر يوم في فترة المسيّر) قبل قراءة الرواتب ⇒ الترقية تسري في شهرها بلا تدخّل يدويّ.
 */
export async function applyDuePromotions(
  tx: Tx,
  asOf: string,
): Promise<number> {
  const due = await tx
    .select()
    .from(employeePromotions)
    .where(
      and(
        eq(employeePromotions.status, "approved"),
        isNull(employeePromotions.appliedAt),
        lte(employeePromotions.effectiveDate, asOf),
      ),
    )
    // ترتيبٌ حتميّ (مراجعة Codex P1): عند تنازع طلبَين على نفس الحقل يفوز **الأحدث
    // سرياناً ثمّ إنشاءً** — بلا ترتيبٍ كان الفائز رهنَ ترتيب المُحرّك للصفوف.
    .orderBy(employeePromotions.effectiveDate, employeePromotions.id);
  for (const p of due) {
    await applyPromotionToEmployee(tx, p);
    await tx
      .update(employeePromotions)
      .set({ appliedAt: new Date() })
      .where(eq(employeePromotions.id, p.id));
  }
  return due.length;
}

/* ===== إنهاء الخدمات ===== */

/** استعلام إنهاءات الخدمة (مع اسم الموظف) — بمعرّف لصفّ واحد أو بلا معرّف للقائمة كاملةً. */
async function terminationRows(actor: PromotionActor, id?: number) {
  const db = requireDb();
  const scope = companyBranchScope(actor);
  const branchPredicate =
    scope.branchId == null ? undefined : eq(employees.branchId, scope.branchId);
  const base = db
    .select({
      id: employeeTerminations.id,
      employeeId: employeeTerminations.employeeId,
      terminationType: employeeTerminations.terminationType,
      lastDay: employeeTerminations.lastDay,
      settlement: employeeTerminations.settlement,
      reason: employeeTerminations.reason,
      status: employeeTerminations.status,
      createdAt: employeeTerminations.createdAt,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
    })
    .from(employeeTerminations)
    .leftJoin(employees, eq(employeeTerminations.employeeId, employees.id));
  const rows =
    id != null
      ? await base
          .where(and(eq(employeeTerminations.id, id), branchPredicate))
          .limit(1)
      : branchPredicate
        ? await base
            .where(branchPredicate)
            .orderBy(desc(employeeTerminations.id))
        : await base.orderBy(desc(employeeTerminations.id));
  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

export async function listTerminations(actor: PromotionActor) {
  return terminationRows(actor);
}

export interface TerminationInput {
  employeeId: number;
  terminationType: string;
  lastDay: string;
  settlement?: string | null;
  reason?: string | null;
}

export async function createTermination(
  input: TerminationInput,
  actor: PromotionActor,
) {
  const scope = companyBranchScope(actor);
  const newId = await withTx(async (tx) => {
    const [emp] = await tx
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.id, input.employeeId),
          scope.branchId == null
            ? undefined
            : eq(employees.branchId, scope.branchId),
        ),
      )
      .for("update")
      .limit(1);
    if (!emp)
      throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    const [res] = await tx.insert(employeeTerminations).values({
      employeeId: input.employeeId,
      terminationType: input.terminationType.trim(),
      lastDay: input.lastDay,
      settlement: toDbMoney(input.settlement ?? "0"),
      reason: input.reason?.trim() || null,
      status: "pending",
    });
    return extractInsertId(res);
  });
  return getTermination(newId, actor);
}

async function getTermination(id: number, actor: PromotionActor) {
  return (await terminationRows(actor, id))[0] ?? null;
}

/**
 * إكمال إنهاء الخدمة (ذرّي): حالة الطلب والموظف، حساب النظام والجلسات، ربط جهاز الحضور،
 * وسند التسوية المعلّق وحدة عمل واحدة؛ أي فشل يعيدها جميعاً بلا حالة نصفية.
 */
export async function completeTermination(id: number, actor: PromotionActor) {
  const scope = companyBranchScope(actor);
  return withTx(async (tx) => {
    const [t] = await tx
      .select()
      .from(employeeTerminations)
      .where(eq(employeeTerminations.id, id))
      .for("update")
      .limit(1);
    if (!t)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "سجل إنهاء الخدمة غير موجود",
      });

    const [emp] = await tx
      .select({
        branchId: employees.branchId,
        userId: employees.userId,
        employmentStatus: employees.employmentStatus,
        firstName: employees.firstName,
        lastName: employees.lastName,
      })
      .from(employees)
      .where(
        and(
          eq(employees.id, t.employeeId),
          scope.branchId == null
            ? undefined
            : eq(employees.branchId, scope.branchId),
        ),
      )
      .for("update")
      .limit(1);
    // لا نكشف للفاعل أن معرّف الإنهاء موجود لكنه تابع لفرع آخر.
    if (!emp)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "سجل إنهاء الخدمة غير موجود",
      });
    if (t.status === "completed") throw new Error("إنهاء الخدمة مكتمل مسبقاً");
    if (emp.employmentStatus === "terminated")
      throw new Error("الموظف منتهي الخدمة مسبقاً");

    let userDisabled = false;
    if (emp.userId != null) {
      const [linkedUser] = await tx
        .select({ id: users.id, role: users.role, isOwner: users.isOwner, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, emp.userId))
        .for("update")
        .limit(1);
      if (linkedUser) assertCanDisablePrivilegedUser(actor, linkedUser);
      if (linkedUser?.isActive) {
        if (Number(linkedUser.id) === Number(actor.userId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "لا تُنهِ خدمة سجلّك الشخصيّ — سيُعطَّل حسابك وتخرج فوراً. اطلب من مديرٍ آخر تنفيذها.",
          });
        }
        if (linkedUser.role === "admin")
          await assertNotLastActiveAdmin(tx, linkedUser.id);
        await tx
          .update(users)
          .set({ isActive: false, sessionsValidFrom: new Date() })
          .where(eq(users.id, linkedUser.id));
        userDisabled = true;
      }
    }

    const deviceRelease = await tx
      .update(hrDeviceUsers)
      .set({ employeeId: null, effectiveFrom: null })
      .where(eq(hrDeviceUsers.employeeId, t.employeeId));
    const deviceLinksReleased = Number(
      (deviceRelease as unknown as [{ affectedRows?: number }])[0]
        ?.affectedRows ?? 0,
    );

    await tx
      .update(employeeTerminations)
      .set({ status: "completed" })
      .where(eq(employeeTerminations.id, id));

    await tx
      .update(employees)
      .set({
        employmentStatus: "terminated",
        isActive: false,
        terminationDate: t.lastDay,
        terminationReason: t.reason ?? null,
      })
      .where(eq(employees.id, t.employeeId));

    // تسوية المستحقات النهائية = صرفُ نقدٍ لموظف = **عملية حسّاسة** ⇒ فصل مهام إلزاميّ (المخاطرة الجهازية
    // #٦، قرار المالك ١٨/٧: العمليات الحسّاسة تمرّ باعتمادٍ ثنائيّ بلا عتبة). تُصدَر **سند صرف مُعلَّق**
    // (PENDING_APPROVAL، بلا أثرٍ ماليّ) حتى يعتمده مديرٌ آخر عبر approveVoucher (SOD-04: المُعتمِد ≠ المُنشئ)
    // فيُرحَّل حينها PAYMENT_OUT للخزينة. يظهر في طابور اعتماد السندات القائم (voucherNumber != null) بلا واجهةٍ جديدة.
    // كان يُصرَف COMPLETED بفاعلٍ واحد بلا سقف (البند ٩ في «أخطر ١٢»، تدقيق ١٧/٧).
    const settlement = money(t.settlement ?? 0);
    let settlementVoucher: { receiptId: number; voucherNumber: string } | null =
      null;
    if (settlement.gt(0)) {
      const branchId = Number(emp.branchId);
      if (!Number.isInteger(branchId) || branchId <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن إنشاء سند تسوية لموظف بلا فرع مُسنَد",
        });
      }
      const request = await createSystemPaymentRequestTx(tx, {
        branchId,
        amount: toDbMoney(settlement),
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: fullEmployeeName(emp),
        description: `تسوية نهاية خدمة — ${t.terminationType}`,
        referenceNumber: `TERM-SETTLEMENT-${id}`,
        voucherDate: t.lastDay,
        clientRequestId: `termination-settlement-${id}`,
      }, { ...actor, branchId }, {
        kind: "TERMINATION_SETTLEMENT",
        terminationId: id,
        employeeId: t.employeeId,
        expectedAmount: toDbMoney(settlement),
      });
      settlementVoucher = {
        receiptId: request.receiptId,
        voucherNumber: request.voucherNumber,
      };
    }

    return {
      terminationId: id,
      settlementVoucher,
      userDisabled,
      deviceLinksReleased,
    };
  });
}
