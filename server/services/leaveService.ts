/* ============================================================================
 * خدمة الإجازات — وحدة الموارد البشرية (server/services/leaveService.ts)
 * طلبات الإجازة (سنوية/مرضية/أمومة/بدون راتب): إنشاء بحالة pending، ثم قرار
 * (موافقة/رفض). عند الموافقة على إجازة مدفوعة تُخصَم من رصيد الموظف المناسب
 * (سنوية → annualLeaveBalance، مرضية → sickLeaveBalance) بقصّ عند الصفر؛ الأمومة
 * مدفوعة بلا رصيد محدّد فلا خصم، و«بدون راتب» لا تمسّ أي رصيد. كل تغيير قرارٍ
 * (تحديث الحالة + خصم الرصيد) داخل معاملة ذرّية واحدة.
 * ========================================================================== */
import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { fullEmployeeName, leaveTypeIsPaid } from "@shared/hr";
import { employees, leaveRequests, payrollRuns } from "../../drizzle/schema";
import type { Tx } from "../db";
import { requireDb, withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { assertPeriodOpen } from "./periodLockService";
import { createAppNotification } from "./appNotificationService";

/** عدد الأيام شاملاً الطرفين من تاريخين "YYYY-MM-DD" — يُحسب بتقويم UTC ثابت (مستقلّ عن منطقة الخادم). */
function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.floor(ms / 86_400_000) + 1;
}

export interface LeaveFilters {
  employeeId?: number;
  status?: "pending" | "approved" | "rejected";
  type?: string;
  /**
   * عزل الفرع (قرار المالك ١٢/٨): `null` = عبورٌ (أدمن/مالك)، ورقمٌ = فرعُه المُسنَد وحده.
   * يُحقَن من `ctx.scopedBranchId`، ولا تشتقّه الخدمة من `ctx`.
   *
   * كانت وحدة الإجازات — كأختها الحضور — بلا أيّ حاجز فرع (تدقيق ١٧/٨). والإجازة **كتابةٌ
   * ماليّة**: المدفوعة يومُ دوامٍ كامل وغيرُ المدفوعة خصمٌ، وكلتاهما تدخلان `computeAttendancePay`.
   */
  scopedBranchId?: number | null;
}

/** قائمة طلبات الإجازة مع اسم الموظف، الأحدث طلباً أولاً. */
export async function listLeaves(filters?: LeaveFilters) {
  const db = requireDb();
  const conds = [];
  // عزل الفرع: الاستعلام يضمّ `employees` أصلاً، وفرعُ الموظف هو الحاجز.
  if (filters?.scopedBranchId != null) conds.push(eq(employees.branchId, filters.scopedBranchId));
  if (filters?.employeeId)
    conds.push(eq(leaveRequests.employeeId, filters.employeeId));
  if (filters?.status) conds.push(eq(leaveRequests.status, filters.status));
  if (filters?.type) conds.push(eq(leaveRequests.leaveType, filters.type));
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select({
      ...getTableColumns(leaveRequests),
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      department: employees.department,
    })
    .from(leaveRequests)
    .leftJoin(employees, eq(leaveRequests.employeeId, employees.id))
    .where(where)
    .orderBy(desc(leaveRequests.requestedAt));

  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

export interface LeaveInput {
  employeeId: number;
  /** عزل الفرع: رقمٌ = يُرفَض موظفُ فرعٍ آخر؛ null/غياب = عبورٌ (أدمن/مالك). */
  scopedBranchId?: number | null;
  leaveType: string;
  fromDate: string;
  toDate: string;
  /** قيمة قديمة للتوافق فقط؛ لا تُستخدم. الأيام تُحسب خادميًا من fromDate/toDate. */
  days?: number;
  reason?: string | null;
}

/** إنشاء طلب إجازة جديد بحالة pending. paid مشتقّ من نوع الإجازة (مصدر الحقيقة @shared/hr).
 *  ذرّي: قفل صفّ الموظف ضمن withTx يُسلسل الطلبات المتزامنة فيُرفض الثاني عبر فحص التداخل
 *  ⇒ يسدّ سباق TOCTOU الذي كان يولّد ازدواج طلب وخصم رصيد مرّتين بعد الموافقة على كليهما. */
export async function createLeave(input: LeaveInput) {
  if (input.toDate < input.fromDate)
    throw new Error("تاريخ النهاية يجب ألا يسبق تاريخ البداية");
  const days = daysInclusive(input.fromDate, input.toDate);
  if (days <= 0) throw new Error("عدد الأيام يجب أن يكون أكبر من صفر");

  const id = await withTx(async (tx) => {
    // قفل صفّ الموظف يجعل طلبَين متزامنَين على نفس الموظف يتسلسلان: الثاني ينتظر التزام
    // الأول فيرى تداخله ⇒ يُرفض. (employees.id FK من leaveRequests فهو موجود قطعاً عند
    // أي طلب صالح؛ نقفله مع تأكيد الوجود.)
    const [emp] = await tx
      .select({ id: employees.id, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .for("update")
      .limit(1);
    if (!emp) throw new Error("الموظف غير موجود");
    // عزل الفرع على الكتابة: طلبُ إجازةٍ لموظف فرعٍ آخر يخصم رصيده ويغيّر أجره في مسيّرٍ
    // لا يملكه الفاعل. يُفحص **بعد** القفل فلا يتغيّر فرعُه بين الفحص والكتابة.
    if (input.scopedBranchId != null && Number(emp.branchId) !== Number(input.scopedBranchId)) {
      throw new Error("لا يمكن تسجيل إجازة لموظف من فرعٍ آخر");
    }

    // منع التداخل: لا طلب آخر (قيد الموافقة أو موافق عليه) يتقاطع مع هذه الفترة لنفس الموظف
    // ⇒ يمنع الخصم المزدوج من رصيد الإجازات وحجزاً مكرّراً لنفس الأيام. ضمن نفس tx بعد القفل.
    const [clash] = await tx
      .select({ id: leaveRequests.id })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.employeeId, input.employeeId),
          ne(leaveRequests.status, "rejected"),
          lte(leaveRequests.fromDate, input.toDate),
          gte(leaveRequests.toDate, input.fromDate),
        ),
      )
      .limit(1);
    if (clash)
      throw new Error("توجد إجازة أخرى متداخلة مع هذه الفترة لنفس الموظف");

    const [res] = await tx.insert(leaveRequests).values({
      employeeId: input.employeeId,
      leaveType: input.leaveType,
      paid: leaveTypeIsPaid(input.leaveType),
      fromDate: input.fromDate,
      toDate: input.toDate,
      days,
      status: "pending",
      reason: input.reason?.trim() || null,
    });
    return extractInsertId(res);
  });
  const [created] = await listLeavesByIds(id);
  return created;
}

async function listLeavesByIds(id: number) {
  const db = requireDb();
  const rows = await db
    .select({
      ...getTableColumns(leaveRequests),
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      department: employees.department,
    })
    .from(leaveRequests)
    .leftJoin(employees, eq(leaveRequests.employeeId, employees.id))
    .where(eq(leaveRequests.id, id))
    .limit(1);
  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

/**
 * قرار على طلب إجازة معلّق: موافقة أو رفض. ذرّي بالكامل.
 * عند الموافقة على إجازة مدفوعة يُخصَم عدد الأيام من رصيد الموظف المناسب (مقصوص عند الصفر):
 *   - "سنوية" → annualLeaveBalance
 *   - "مرضية" → sickLeaveBalance
 *   - "أمومة" (مدفوعة بلا رصيد محدّد) → لا خصم
 *   - "بدون راتب" (غير مدفوعة) → لا خصم
 * الرفض يضبط الحالة فقط بلا أي مساس بالرصيد.
 */
/**
 * حارس المسيّر المُقفَل — مرآةُ الحارس نفسه في `recordAttendance`.
 * الإجازة مُدخَلٌ ماليّ في المسيّر (بلا راتب تُخصَم، والمدفوعة تستهلك رصيداً)، فاعتمادها
 * أو إلغاؤها بعد اعتماد/دفع مسيّر شهرها يُغيّر أساس حسابٍ مُلتزَمٍ به مالياً بلا أن يُعاد.
 * كان الحارس موجوداً على الحضور وغائباً هنا: إجازة «بلا راتب» تُعتمَد بأثرٍ رجعيّ بعد
 * الدفع فلا تُخصَم **أبداً** — لا في مسيّرها (مقفل) ولا في التالي (شهرٌ آخر).
 */
async function assertNoLockedPayroll(
  tx: Tx,
  fromDate: string,
  toDate: string,
): Promise<void> {
  const [locked] = await tx
    .select({ period: payrollRuns.period, status: payrollRuns.status })
    .from(payrollRuns)
    .where(
      and(
        inArray(payrollRuns.status, ["approved", "paid"]),
        // تداخل الشهر مع مدى الإجازة: أوّل الشهر ≤ نهاية الإجازة، وآخره ≥ بدايتها.
        sql`CONCAT(${payrollRuns.period}, '-01') <= ${toDate}`,
        sql`LAST_DAY(CONCAT(${payrollRuns.period}, '-01')) >= ${fromDate}`,
      ),
    )
    .limit(1);
  if (locked) {
    throw new Error(
      `مسيّر رواتب شهر ${locked.period} ${locked.status === "paid" ? "مدفوع" : "معتمَد"} ويتداخل مع مدّة الإجازة — ألغِ اعتماد المسيّر أولاً ليُعاد حسابه.`,
    );
  }
}

export async function decideLeave(
  id: number,
  decision: "approved" | "rejected",
  actor: { userId: number; scopedBranchId?: number | null },
) {
  return withTx(async (tx) => {
    const [lv] = await tx
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .for("update")
      .limit(1);
    if (!lv) throw new Error("طلب الإجازة غير موجود");
    if (lv.status !== "pending")
      throw new Error("لا يمكن البتّ إلا في طلب قيد الموافقة");
    // الاعتماد وحده يُغيّر أساس المسيّر؛ الرفض لا أثر ماليّ له فيمرّ دائماً.
    if (decision === "approved") {
      await assertNoLockedPayroll(tx, String(lv.fromDate), String(lv.toDate));
      await assertPeriodOpen(tx, new Date(lv.fromDate));
    }

    // HR-PAY-03 (فصل المهام): لا يجوز للمستخدم البتّ في إجازة موظفٍ مرتبطٍ بحسابه (موافقة ذاتية)
    // — يَكسر منح إجازةٍ مدفوعة لنفسه وخصم رصيده ذاتياً بلا مُقرِّر مستقلّ.
    const [reqEmp] = await tx
      .select({ userId: employees.userId, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, lv.employeeId))
      .limit(1);
    // عزل الفرع: البتّ يُغيّر أجرَ الموظف في مسيّر فرعه — لا يبتّ فيه من هو خارج ذلك الفرع.
    // الطلب يُطلَب بمعرّفه، فالرفض صريحٌ لا صامت كي تظهر المحاولة.
    if (actor.scopedBranchId != null && Number(reqEmp?.branchId) !== Number(actor.scopedBranchId)) {
      throw new Error("طلب الإجازة يخصّ موظفاً من فرعٍ آخر — لا صلاحية لك عليه");
    }
    if (reqEmp?.userId != null && Number(reqEmp.userId) === actor.userId) {
      throw new Error(
        "لا يجوز البتّ في إجازتك بنفسك — يلزم مُقرِّر آخر (فصل المهام).",
      );
    }

    if (
      decision === "approved" &&
      lv.paid &&
      (lv.leaveType === "سنوية" || lv.leaveType === "مرضية")
    ) {
      // خصم دقيق بحارس كفاية الرصيد (لا قصّ صامت) ⇒ المخصوم = days بالضبط، فالإلغاء يستردّه بدقّة.
      // الأمومة مدفوعة بلا رصيد محدّد فلا خصم. القفل على صفّ الموظف يمنع السباق.
      const [emp] = await tx
        .select({
          annual: employees.annualLeaveBalance,
          sick: employees.sickLeaveBalance,
        })
        .from(employees)
        .where(eq(employees.id, lv.employeeId))
        .for("update")
        .limit(1);
      if (!emp) throw new Error("الموظف غير موجود");
      const isAnnual = lv.leaveType === "سنوية";
      const current = (isAnnual ? emp.annual : emp.sick) ?? 0;
      if (current < lv.days) {
        throw new Error(
          `رصيد إجازة ${lv.leaveType} غير كافٍ (المتاح ${current} يوم، المطلوب ${lv.days})`,
        );
      }
      await tx
        .update(employees)
        .set(
          isAnnual
            ? {
                annualLeaveBalance: sql`${employees.annualLeaveBalance} - ${lv.days}`,
              }
            : {
                sickLeaveBalance: sql`${employees.sickLeaveBalance} - ${lv.days}`,
              },
        )
        .where(eq(employees.id, lv.employeeId));
    }

    await tx
      .update(leaveRequests)
      .set({ status: decision, decidedBy: actor.userId, decidedAt: new Date() })
      .where(eq(leaveRequests.id, id));
  }).then(async () => (await listLeavesByIds(id))[0] ?? null); // القراءة بعد الـcommit (listLeavesByIds عبر الاتصال العام).
}

/**
 * البتُّ **مع إشعار الموظّف** — المسارُ الواحد الذي يستدعيه راوتر الإجازات وصندوق القرارات معاً.
 *
 * كان الإشعار مكتوباً في `leaveRouter.decide` وحده، فحين صار البتّ ممكناً من صندوق «مطلوب
 * مني الآن» (`decisions.decide` ⇐ `decideLeave` مباشرةً) تحدّث الطلبُ ولم يصل الموظّفَ شيء
 * (Codex على #1004). الإشعارُ best-effort: فشلُه لا يُرجع البتَّ الذي التُزم.
 */
export async function decideLeaveAndNotify(
  id: number,
  decision: "approved" | "rejected",
  actor: { userId: number; scopedBranchId?: number | null },
) {
  const lv = await decideLeave(id, decision, actor);
  if (lv?.employeeId) {
    const [employee] = await requireDb()
      .select({ userId: employees.userId })
      .from(employees)
      .where(eq(employees.id, Number(lv.employeeId)))
      .limit(1);
    if (employee?.userId) {
      await createAppNotification({
        userId: Number(employee.userId),
        kind: "LEAVE_STATUS",
        title: decision === "approved" ? "تمت الموافقة على الإجازة" : "تم تحديث طلب الإجازة",
        body: `${lv.leaveType} · ${lv.fromDate} — ${lv.toDate}`,
        route: "/hr?tab=leaves",
        eventKey: `leave:${id}:${decision}`,
        entityType: "leaveRequest",
        entityId: id,
      }).catch(() => undefined);
    }
  }
  return lv;
}

/**
 * إلغاء إجازة موافق عليها (ذرّي): تُعاد الحالة إلى rejected وتُستردّ الأيام المخصومة إلى
 * رصيد الموظف المناسب. لأنّ خصم الموافقة دقيق (بحارس كفاية، بلا قصّ) فالاسترداد = days بالضبط.
 * الأمومة/بدون راتب لم تُخصَم فلا تُستردّ. القفل على صفّ الإجازة يمنع الإلغاء المزدوج.
 */
export async function cancelLeave(id: number, actor: { userId: number; scopedBranchId?: number | null }) {
  return withTx(async (tx) => {
    const [lv] = await tx
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .for("update")
      .limit(1);
    if (!lv) throw new Error("طلب الإجازة غير موجود");
    if (lv.status !== "approved")
      throw new Error("لا يُلغى إلا طلب إجازة موافق عليه");

    /*
     * فصل مهام على الإلغاء أيضاً — كان مفروضاً على البتّ (decideLeave) وغائباً هنا،
     * فالمسار مفتوحٌ بالكامل: الموظف يأخذ إجازته المعتمَدة فعلاً ثم يُلغيها بنفسه بعد
     * العودة فيستردّ رصيدها ويُسقط خصمها من الراتب — إجازةٌ أُخذت ولم تُحتسب.
     */
    const [reqEmp] = await tx
      .select({ userId: employees.userId, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, lv.employeeId))
      .limit(1);
    // عزل الفرع: البتّ يُغيّر أجرَ الموظف في مسيّر فرعه — لا يبتّ فيه من هو خارج ذلك الفرع.
    // الطلب يُطلَب بمعرّفه، فالرفض صريحٌ لا صامت كي تظهر المحاولة.
    if (actor.scopedBranchId != null && Number(reqEmp?.branchId) !== Number(actor.scopedBranchId)) {
      throw new Error("طلب الإجازة يخصّ موظفاً من فرعٍ آخر — لا صلاحية لك عليه");
    }
    if (reqEmp?.userId != null && Number(reqEmp.userId) === actor.userId) {
      throw new Error(
        "لا يجوز إلغاء إجازتك بنفسك — يلزم مُقرِّر آخر (فصل المهام).",
      );
    }
    await assertNoLockedPayroll(tx, String(lv.fromDate), String(lv.toDate));
    await assertPeriodOpen(tx, new Date(lv.fromDate));

    if (lv.paid && lv.leaveType === "سنوية") {
      await tx
        .update(employees)
        .set({
          annualLeaveBalance: sql`${employees.annualLeaveBalance} + ${lv.days}`,
        })
        .where(eq(employees.id, lv.employeeId));
    } else if (lv.paid && lv.leaveType === "مرضية") {
      await tx
        .update(employees)
        .set({
          sickLeaveBalance: sql`${employees.sickLeaveBalance} + ${lv.days}`,
        })
        .where(eq(employees.id, lv.employeeId));
    }

    await tx
      .update(leaveRequests)
      .set({
        status: "rejected",
        decidedBy: actor.userId,
        decidedAt: new Date(),
      })
      .where(eq(leaveRequests.id, id));
  }).then(async () => (await listLeavesByIds(id))[0] ?? null); // القراءة بعد الـcommit.
}

/** يسمح للموظف بسحب طلبه المعلّق فقط؛ القرارات المعتمدة تبقى ضمن مسار الموارد البشرية. */
export async function withdrawPendingLeave(id: number, employeeId: number) {
  return withTx(async (tx) => {
    const [leave] = await tx
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .for("update")
      .limit(1);
    if (!leave || Number(leave.employeeId) !== employeeId) {
      throw new Error("طلب الإجازة غير موجود");
    }
    if (leave.status !== "pending") {
      throw new Error("يمكن سحب الطلب قبل البتّ فيه فقط");
    }
    await tx
      .update(leaveRequests)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(leaveRequests.id, id));
  }).then(async () => (await listLeavesByIds(id))[0] ?? null);
}

/** أرصدة الإجازات لكل موظف على رأس العمل: {id, name, annualLeaveBalance, sickLeaveBalance, department}. */
export async function balances(scopedBranchId?: number | null) {
  const db = requireDb();
  const rows = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      department: employees.department,
      annualLeaveBalance: employees.annualLeaveBalance,
      sickLeaveBalance: employees.sickLeaveBalance,
    })
    .from(employees)
    // عزل الفرع: هذه القائمة تعرض أرصدة الموظفين وتغذّي شاشة الإجازات وتقريرها.
    .where(
      and(
        eq(employees.isActive, true),
        scopedBranchId != null ? eq(employees.branchId, scopedBranchId) : undefined,
      ),
    )
    .orderBy(employees.firstName);

  return rows.map((r) => ({
    id: r.id,
    name: fullEmployeeName(r),
    colorTag: r.colorTag,
    photoUrl: r.photoUrl,
    department: r.department,
    annualLeaveBalance: r.annualLeaveBalance ?? 0,
    sickLeaveBalance: r.sickLeaveBalance ?? 0,
  }));
}
