/* ============================================================================
 * خدمة الإجازات — وحدة الموارد البشرية (server/services/leaveService.ts)
 * طلبات الإجازة (سنوية/مرضية/أمومة/بدون راتب): إنشاء بحالة pending، ثم قرار
 * (موافقة/رفض). عند الموافقة على إجازة مدفوعة تُخصَم من رصيد الموظف المناسب
 * (سنوية → annualLeaveBalance، مرضية → sickLeaveBalance) بقصّ عند الصفر؛ الأمومة
 * مدفوعة بلا رصيد محدّد فلا خصم، و«بدون راتب» لا تمسّ أي رصيد. كل تغيير قرارٍ
 * (تحديث الحالة + خصم الرصيد) داخل معاملة ذرّية واحدة.
 * ========================================================================== */
import { and, desc, eq, getTableColumns, gte, lte, ne, sql } from "drizzle-orm";
import { fullEmployeeName, leaveTypeIsPaid } from "@shared/hr";
import { employees, leaveRequests } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";

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
}

/** قائمة طلبات الإجازة مع اسم الموظف، الأحدث طلباً أولاً. */
export async function listLeaves(filters?: LeaveFilters) {
  const db = requireDb();
  const conds = [];
  if (filters?.employeeId) conds.push(eq(leaveRequests.employeeId, filters.employeeId));
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
  leaveType: string;
  fromDate: string;
  toDate: string;
  days: number;
  reason?: string | null;
}

/** إنشاء طلب إجازة جديد بحالة pending. paid مشتقّ من نوع الإجازة (مصدر الحقيقة @shared/hr). */
export async function createLeave(input: LeaveInput) {
  const db = requireDb();
  const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId)).limit(1);
  if (!emp) throw new Error("الموظف غير موجود");
  if (input.toDate < input.fromDate) throw new Error("تاريخ النهاية يجب ألا يسبق تاريخ البداية");

  // عدد الأيام يُحسب في الخادم من نطاق التواريخ (لا يُوثَق بقيمة العميل) لمنع تلاعب الرصيد.
  const days = daysInclusive(input.fromDate, input.toDate);
  if (days <= 0) throw new Error("عدد الأيام يجب أن يكون أكبر من صفر");

  // منع التداخل: لا طلب آخر (قيد الموافقة أو موافق عليه) يتقاطع مع هذه الفترة لنفس الموظف
  // ⇒ يمنع الخصم المزدوج من رصيد الإجازات وحجزاً مكرّراً لنفس الأيام.
  const [clash] = await db
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
  if (clash) throw new Error("توجد إجازة أخرى متداخلة مع هذه الفترة لنفس الموظف");

  const [res] = await db.insert(leaveRequests).values({
    employeeId: input.employeeId,
    leaveType: input.leaveType,
    paid: leaveTypeIsPaid(input.leaveType),
    fromDate: input.fromDate,
    toDate: input.toDate,
    days,
    status: "pending",
    reason: input.reason?.trim() || null,
  });
  const id = Number((res as { insertId: number }).insertId);
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
export async function decideLeave(
  id: number,
  decision: "approved" | "rejected",
  actor: { userId: number },
) {
  return withTx(async (tx) => {
    const [lv] = await tx.select().from(leaveRequests).where(eq(leaveRequests.id, id)).for("update").limit(1);
    if (!lv) throw new Error("طلب الإجازة غير موجود");
    if (lv.status !== "pending") throw new Error("لا يمكن البتّ إلا في طلب قيد الموافقة");

    if (decision === "approved" && lv.paid) {
      // خصم مع قصّ عند الصفر — لا يهبط الرصيد دون الصفر. الأمومة مدفوعة بلا رصيد محدّد فلا خصم.
      if (lv.leaveType === "سنوية") {
        await tx
          .update(employees)
          .set({ annualLeaveBalance: sql`GREATEST(${employees.annualLeaveBalance} - ${lv.days}, 0)` })
          .where(eq(employees.id, lv.employeeId));
      } else if (lv.leaveType === "مرضية") {
        await tx
          .update(employees)
          .set({ sickLeaveBalance: sql`GREATEST(${employees.sickLeaveBalance} - ${lv.days}, 0)` })
          .where(eq(employees.id, lv.employeeId));
      }
    }

    await tx
      .update(leaveRequests)
      .set({ status: decision, decidedBy: actor.userId, decidedAt: new Date() })
      .where(eq(leaveRequests.id, id));

    const [updated] = await listLeavesByIds(id);
    return updated;
  });
}

/** أرصدة الإجازات لكل موظف على رأس العمل: {id, name, annualLeaveBalance, sickLeaveBalance, department}. */
export async function balances() {
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
    .where(eq(employees.isActive, true))
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
