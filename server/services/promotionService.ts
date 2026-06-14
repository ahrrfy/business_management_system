/* ============================================================================
 * خدمة الترقيات وإنهاء الخدمات — وحدة الموارد البشرية (server/services/promotionService.ts)
 * - الترقيات: تُنشأ بحالة pending؛ اعتمادها (داخل withTx) يحدّث مسمّى/راتب الموظف.
 * - إنهاء الخدمات: يُنشأ بحالة pending؛ إكماله (داخل withTx) يضع الموظف «منتهي الخدمة»
 *   (يعكس setEmploymentStatus من employeeService: employmentStatus=terminated + isActive=false
 *    + terminationDate=lastDay + terminationReason=reason).
 * المبالغ كلها عبر money.ts (toDbMoney). الكتابات متعددة الأطراف داخل withTx.
 * ========================================================================== */
import { desc, eq } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { employeePromotions, employees, employeeTerminations } from "../../drizzle/schema";
import { requireDb, withTx, type Actor } from "./tx";
import { money, toDbMoney } from "./money";
import { postEntry } from "./ledgerService";

/* ===== الترقيات ===== */

/** استعلام الترقيات (مع اسم الموظف) — بمعرّف لصفّ واحد أو بلا معرّف للقائمة كاملةً.
 *  يلغي نمط «اجلب الكل ثم find» (N+1) في getPromotion. */
async function promotionRows(id?: number) {
  const db = requireDb();
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
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
    })
    .from(employeePromotions)
    .leftJoin(employees, eq(employeePromotions.employeeId, employees.id));
  const rows = id != null ? await base.where(eq(employeePromotions.id, id)).limit(1) : await base.orderBy(desc(employeePromotions.id));
  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

export async function listPromotions() {
  return promotionRows();
}

export interface PromotionInput {
  employeeId: number;
  toTitle: string;
  fromTitle?: string | null;
  fromSalary?: string | null;
  toSalary?: string | null;
  effectiveDate: string;
  reason?: string | null;
}

export async function createPromotion(input: PromotionInput) {
  const db = requireDb();
  const [emp] = await db.select().from(employees).where(eq(employees.id, input.employeeId)).limit(1);
  if (!emp) throw new Error("الموظف غير موجود");
  // لقطة الحالة الحالية افتراضياً إن لم يمررها المستخدم.
  const fromTitle = input.fromTitle?.trim() || emp.position || null;
  const fromSalary =
    input.fromSalary != null && input.fromSalary !== ""
      ? toDbMoney(input.fromSalary)
      : emp.salary ?? null;
  const [res] = await db.insert(employeePromotions).values({
    employeeId: input.employeeId,
    fromTitle,
    toTitle: input.toTitle.trim(),
    fromSalary,
    toSalary: input.toSalary != null && input.toSalary !== "" ? toDbMoney(input.toSalary) : null,
    effectiveDate: input.effectiveDate,
    reason: input.reason?.trim() || null,
    status: "pending",
  });
  return getPromotion(Number((res as { insertId: number }).insertId));
}

async function getPromotion(id: number) {
  return (await promotionRows(id))[0] ?? null;
}

/**
 * اعتماد الترقية (ذرّي): تُضبط الحالة approved (+ approvedAt/approvedBy)
 * ويُحدَّث الموظف: position = toTitle، salary = toSalary (إن وُجد).
 */
export async function approvePromotion(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [p] = await tx.select().from(employeePromotions).where(eq(employeePromotions.id, id)).for("update").limit(1);
    if (!p) throw new Error("سجل الترقية غير موجود");
    if (p.status === "approved") throw new Error("الترقية معتمدة مسبقاً");

    // حارس حالة الموظف: لا تُعتمد ترقية موظف منتهي الخدمة.
    const [emp] = await tx
      .select({ employmentStatus: employees.employmentStatus })
      .from(employees)
      .where(eq(employees.id, p.employeeId))
      .for("update")
      .limit(1);
    if (!emp) throw new Error("الموظف غير موجود");
    if (emp.employmentStatus === "terminated") throw new Error("لا يمكن ترقية موظف منتهي الخدمة");

    await tx
      .update(employeePromotions)
      .set({ status: "approved", approvedAt: new Date(), approvedBy: actor.userId })
      .where(eq(employeePromotions.id, id));

    const empPatch: { position: string; salary?: string } = { position: p.toTitle };
    if (p.toSalary != null) empPatch.salary = toDbMoney(p.toSalary);
    await tx.update(employees).set(empPatch).where(eq(employees.id, p.employeeId));

    return id;
  });
}

/* ===== إنهاء الخدمات ===== */

/** استعلام إنهاءات الخدمة (مع اسم الموظف) — بمعرّف لصفّ واحد أو بلا معرّف للقائمة كاملةً. */
async function terminationRows(id?: number) {
  const db = requireDb();
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
  const rows = id != null ? await base.where(eq(employeeTerminations.id, id)).limit(1) : await base.orderBy(desc(employeeTerminations.id));
  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

export async function listTerminations() {
  return terminationRows();
}

export interface TerminationInput {
  employeeId: number;
  terminationType: string;
  lastDay: string;
  settlement?: string | null;
  reason?: string | null;
}

export async function createTermination(input: TerminationInput) {
  const db = requireDb();
  const [emp] = await db.select().from(employees).where(eq(employees.id, input.employeeId)).limit(1);
  if (!emp) throw new Error("الموظف غير موجود");
  const [res] = await db.insert(employeeTerminations).values({
    employeeId: input.employeeId,
    terminationType: input.terminationType.trim(),
    lastDay: input.lastDay,
    settlement: toDbMoney(input.settlement ?? "0"),
    reason: input.reason?.trim() || null,
    status: "pending",
  });
  return getTermination(Number((res as { insertId: number }).insertId));
}

async function getTermination(id: number) {
  return (await terminationRows(id))[0] ?? null;
}

/**
 * إكمال إنهاء الخدمة (ذرّي): تُضبط الحالة completed، ويوضع الموظف «منتهي الخدمة»
 * (employmentStatus=terminated، isActive=false، terminationDate=lastDay، terminationReason=reason).
 * يعكس employeeService.setEmploymentStatus.
 */
export async function completeTermination(id: number, _actor: Actor) {
  return withTx(async (tx) => {
    const [t] = await tx.select().from(employeeTerminations).where(eq(employeeTerminations.id, id)).for("update").limit(1);
    if (!t) throw new Error("سجل إنهاء الخدمة غير موجود");
    if (t.status === "completed") throw new Error("إنهاء الخدمة مكتمل مسبقاً");

    const [emp] = await tx
      .select({ branchId: employees.branchId, employmentStatus: employees.employmentStatus })
      .from(employees)
      .where(eq(employees.id, t.employeeId))
      .for("update")
      .limit(1);
    if (!emp) throw new Error("الموظف غير موجود");
    if (emp.employmentStatus === "terminated") throw new Error("الموظف منتهي الخدمة مسبقاً");

    await tx.update(employeeTerminations).set({ status: "completed" }).where(eq(employeeTerminations.id, id));

    await tx
      .update(employees)
      .set({
        employmentStatus: "terminated",
        isActive: false,
        terminationDate: t.lastDay,
        terminationReason: t.reason ?? null,
      })
      .where(eq(employees.id, t.employeeId));

    // تسوية المستحقات النهائية تُصرف من الخزينة وتُرحَّل للدفتر (PAYMENT_OUT) إن كانت موجبة،
    // بفرع الموظف، بمفتاح dedupe فريد TERMINATION:<id> ⇒ يمنع ازدواج الصرف عند إعادة المحاولة.
    const settlement = money(t.settlement ?? 0);
    if (settlement.gt(0)) {
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: emp.branchId ?? null,
        amount: settlement,
        entryDate: new Date(`${t.lastDay}T00:00:00Z`),
        dedupeKey: `TERMINATION:${id}`,
        notes: `تسوية نهاية خدمة — ${t.terminationType}`,
      });
    }

    return id;
  });
}
