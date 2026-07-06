/* ============================================================================
 * خطط العمولات وإسناداتها — وحدة «الأهداف والعمولات» (S1)
 *
 * السياسة المعتمدة (قرارات المالك ٦/٧/٢٦):
 *  - الخطة: أساس NET_SALES (صافي المبيعات − المرتجعات) — enum يحجز COLLECTED/PROFIT
 *    مستقبلاً والمحرّك يرفض غير NET_SALES صراحةً.
 *  - نمطا شرائح: TARGET_PCT (العتبة = نسبة تحقيق الهدف ٪) أو AMOUNT_SLAB (العتبة =
 *    صافي مبيعات بالدينار). النسبة تُطبَّق على **كامل** الأساس الفعلي (لا شرائح هامشية)
 *    + مكافأة مقطوعة اختيارية للشريحة — بساطة يفهمها الموظف.
 *  - رتابة إلزامية: النِّسَب والمكافآت لا تتناقص مع صعود العتبات ⇒ يستحيل «بِع أكثر
 *    تربح أقل» (تحقّق بنيوي عند الحفظ لا عند الاحتساب).
 *  - إسناد واحد مفتوح لكل موظف: فترات شهرية YYYY-MM، الإسناد الجديد يُغلق المفتوح
 *    السابق آلياً عند prevPeriod(from). منع التداخل تطبيقياً تحت قفل FOR UPDATE على
 *    صفّ الموظف (MySQL بلا قيد استبعاد مدى) — التسلسل يمنع سباق إسنادين متزامنين.
 *  - الإسناد يشترط employees.userId (نسبة المبيعات تتبع users.id في الدفتر).
 *
 * الحذف الناعم فقط للخطط (isActive=false): أسطر التشغيلات والإسنادات التاريخية
 * تُشير إليها بـFK — الحذف الفيزيائي محظور بنيوياً.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  branches,
  commissionAssignments,
  commissionPlans,
  commissionPlanTiers,
  employees,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import { assertPeriod, prevPeriod } from "./period";

export type TierMode = "TARGET_PCT" | "AMOUNT_SLAB";

export interface PlanTierInput {
  /** العتبة الدنيا للشريحة: نسبة إنجاز ٪ (TARGET_PCT) أو مبلغ دينار (AMOUNT_SLAB). */
  threshold: string;
  /** نسبة العمولة ٪ على كامل الأساس (0..100، حتى ٤ منازل عشرية). */
  ratePct: string;
  /** مكافأة مقطوعة تُضاف عند بلوغ الشريحة (≥ 0). */
  fixedBonus: string;
}

export interface CreatePlanInput {
  name: string;
  tierMode: TierMode;
  tiers: PlanTierInput[];
  notes?: string | null;
}

export interface UpdatePlanInput extends CreatePlanInput {
  planId: number;
}

const MAX_TIERS = 12;
/** سقف عتبة النسبة المئوية (TARGET_PCT): ١٠٠٠٪ إنجاز — أي مسرّع واقعي دونه. */
const MAX_PCT_THRESHOLD = new Decimal(1000);
/** سقف مبالغ الدينار (عتبة/مكافأة) — يطابق decimal(15,2). */
const MAX_IQD = new Decimal("9999999999999.99");

function assertPlanName(name: string): string {
  const n = name?.trim();
  if (!n) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الخطة مطلوب." });
  if (n.length > 120) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الخطة أطول من ١٢٠ حرفاً." });
  return n;
}

/** تحقّق شرائح الخطة: تصاعد صارم للعتبات + رتابة النِّسَب والمكافآت + الحدود العقلانية. */
function validateTiers(tierMode: TierMode, tiers: PlanTierInput[]): { threshold: Decimal; ratePct: Decimal; fixedBonus: Decimal }[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة تحتاج شريحة واحدة على الأقل." });
  }
  if (tiers.length > MAX_TIERS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `عدد الشرائح يتجاوز الحدّ (${MAX_TIERS}).` });
  }
  const parsed = tiers.map((t, i) => {
    const threshold = money(t.threshold);
    const ratePct = money(t.ratePct);
    const fixedBonus = money(t.fixedBonus);
    if (threshold.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: `عتبة الشريحة ${i + 1} سالبة.` });
    const thresholdCap = tierMode === "TARGET_PCT" ? MAX_PCT_THRESHOLD : MAX_IQD;
    if (threshold.gt(thresholdCap)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `عتبة الشريحة ${i + 1} تتجاوز الحدّ المعقول.` });
    }
    if (ratePct.lt(0) || ratePct.gt(100)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `نسبة الشريحة ${i + 1} يجب أن تكون بين 0 و100.` });
    }
    if (fixedBonus.lt(0) || fixedBonus.gt(MAX_IQD)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `مكافأة الشريحة ${i + 1} خارج الحدود.` });
    }
    if (ratePct.isZero() && fixedBonus.isZero() && tiers.length === 1) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "خطة بشريحة واحدة صفرية النسبة والمكافأة بلا معنى." });
    }
    return { threshold, ratePct, fixedBonus };
  });
  for (let i = 1; i < parsed.length; i++) {
    if (!parsed[i].threshold.gt(parsed[i - 1].threshold)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "عتبات الشرائح يجب أن تكون تصاعدية بلا تكرار." });
    }
    // الرتابة: النسبة على كامل الأساس ⇒ أي هبوط في النسبة أو المكافأة مع صعود العتبة
    // يخلق منطقة «بِع أكثر تربح أقل» — نرفضها بنيوياً هنا لا في المحرّك.
    if (parsed[i].ratePct.lt(parsed[i - 1].ratePct)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "نسب الشرائح لا يجوز أن تتناقص مع صعود العتبة." });
    }
    if (parsed[i].fixedBonus.lt(parsed[i - 1].fixedBonus)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مكافآت الشرائح لا يجوز أن تتناقص مع صعود العتبة." });
    }
  }
  return parsed;
}

/** تسلسل ratePct بدقّة ٤ منازل (عمود decimal(7,4)) — toDbMoney يقصّ على منزلتين فلا يصلح هنا. */
function toDbRatePct(v: Decimal): string {
  return v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/* ─────────────────────────── قراءة ─────────────────────────── */

export interface PlanTierRow {
  id: number;
  sort: number;
  threshold: string;
  ratePct: string;
  fixedBonus: string;
}

export interface PlanListRow {
  id: number;
  name: string;
  basis: "NET_SALES" | "COLLECTED" | "PROFIT";
  tierMode: TierMode;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  tiers: PlanTierRow[];
  /** عدد الإسنادات المفتوحة (effectiveTo IS NULL) — «مُسنَدة لمن الآن». */
  openAssignments: number;
}

export async function listPlans(): Promise<PlanListRow[]> {
  const db = requireDb();
  const plans = await db.select().from(commissionPlans).orderBy(desc(commissionPlans.isActive), asc(commissionPlans.name));
  if (plans.length === 0) return [];

  const tiers = await db.select().from(commissionPlanTiers).orderBy(asc(commissionPlanTiers.planId), asc(commissionPlanTiers.sort));
  const openCounts = await db
    .select({ planId: commissionAssignments.planId, cnt: sql<number>`COUNT(*)` })
    .from(commissionAssignments)
    .where(isNull(commissionAssignments.effectiveTo))
    .groupBy(commissionAssignments.planId);
  const countByPlan = new Map(openCounts.map((r) => [Number(r.planId), Number(r.cnt)]));

  const tiersByPlan = new Map<number, PlanTierRow[]>();
  for (const t of tiers) {
    const list = tiersByPlan.get(Number(t.planId)) ?? [];
    list.push({ id: Number(t.id), sort: t.sort, threshold: t.threshold, ratePct: t.ratePct, fixedBonus: t.fixedBonus });
    tiersByPlan.set(Number(t.planId), list);
  }

  return plans.map((p) => ({
    id: Number(p.id),
    name: p.name,
    basis: p.basis,
    tierMode: p.tierMode,
    isActive: p.isActive,
    notes: p.notes ?? null,
    createdAt: p.createdAt.toISOString(),
    tiers: tiersByPlan.get(Number(p.id)) ?? [],
    openAssignments: countByPlan.get(Number(p.id)) ?? 0,
  }));
}

/* ─────────────────────────── كتابة الخطط ─────────────────────────── */

export async function createPlan(input: CreatePlanInput, actor: Actor): Promise<{ planId: number }> {
  const name = assertPlanName(input.name);
  const tiers = validateTiers(input.tierMode, input.tiers);
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 255) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الملاحظات أطول من ٢٥٥ حرفاً." });
  }
  return withTx(async (tx) => {
    const res = await tx.insert(commissionPlans).values({
      name,
      basis: "NET_SALES",
      tierMode: input.tierMode,
      isActive: true,
      notes,
      createdBy: actor.userId,
    });
    const planId = extractInsertId(res);
    for (let i = 0; i < tiers.length; i++) {
      await tx.insert(commissionPlanTiers).values({
        planId,
        sort: i,
        threshold: toDbMoney(tiers[i].threshold),
        ratePct: toDbRatePct(tiers[i].ratePct),
        fixedBonus: toDbMoney(tiers[i].fixedBonus),
      });
    }
    return { planId };
  });
}

export async function updatePlan(input: UpdatePlanInput, actor: Actor): Promise<{ planId: number }> {
  void actor; // التدقيق في الراوتر (logAudit) — الخدمة تبقى نقيّة.
  const name = assertPlanName(input.name);
  const tiers = validateTiers(input.tierMode, input.tiers);
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 255) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الملاحظات أطول من ٢٥٥ حرفاً." });
  }
  return withTx(async (tx) => {
    const [plan] = await tx.select().from(commissionPlans).where(eq(commissionPlans.id, input.planId)).for("update");
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة." });

    // استبدال الشرائح كاملاً: أسطر التشغيلات المعتمدة لقطات مستقلة (ratePct/fixedBonus/tierIndex
    // منسوخة فيها) ⇒ تعديل الشرائح آمن تاريخياً؛ المسودّات تُعاد بحسابها الجديد عند recompute.
    await tx.delete(commissionPlanTiers).where(eq(commissionPlanTiers.planId, input.planId));
    for (let i = 0; i < tiers.length; i++) {
      await tx.insert(commissionPlanTiers).values({
        planId: input.planId,
        sort: i,
        threshold: toDbMoney(tiers[i].threshold),
        ratePct: toDbRatePct(tiers[i].ratePct),
        fixedBonus: toDbMoney(tiers[i].fixedBonus),
      });
    }
    await tx
      .update(commissionPlans)
      .set({ name, tierMode: input.tierMode, notes })
      .where(eq(commissionPlans.id, input.planId));
    return { planId: input.planId };
  });
}

export async function setPlanActive(planId: number, isActive: boolean): Promise<void> {
  await withTx(async (tx) => {
    const [plan] = await tx.select().from(commissionPlans).where(eq(commissionPlans.id, planId)).for("update");
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة." });
    await tx.update(commissionPlans).set({ isActive }).where(eq(commissionPlans.id, planId));
  });
}

/* ─────────────────────────── الإسنادات ─────────────────────────── */

export interface AssignmentBoardRow {
  employeeId: number;
  employeeName: string;
  position: string | null;
  branchName: string | null;
  /** حالة التوظيف — الواجهة تعلّم «في إجازة» ولا تعرض «منتهي الخدمة» أصلاً. */
  employmentStatus: "active" | "leave" | "terminated";
  assignment: {
    id: number;
    planId: number;
    planName: string;
    effectiveFrom: string;
  } | null;
}

/** لوحة الإسناد: كل موظف مرتبط بحساب مستخدم (شرط نسبة المبيعات) غير منتهي الخدمة،
 *  مع إسناده المفتوح إن وُجد. الاستعلام واحد مجمَّع — لا N+1. */
export async function listAssignmentBoard(): Promise<AssignmentBoardRow[]> {
  const db = requireDb();
  const rows = await db
    .select({
      employeeId: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      employmentStatus: employees.employmentStatus,
      branchName: branches.name,
      assignmentId: commissionAssignments.id,
      planId: commissionAssignments.planId,
      planName: commissionPlans.name,
      effectiveFrom: commissionAssignments.effectiveFrom,
    })
    .from(employees)
    .leftJoin(branches, eq(branches.id, employees.branchId))
    .leftJoin(
      commissionAssignments,
      and(eq(commissionAssignments.employeeId, employees.id), isNull(commissionAssignments.effectiveTo)),
    )
    .leftJoin(commissionPlans, eq(commissionPlans.id, commissionAssignments.planId))
    .where(and(sql`${employees.userId} IS NOT NULL`, sql`${employees.employmentStatus} <> 'terminated'`))
    .orderBy(asc(employees.firstName));

  return rows.map((r) => ({
    employeeId: Number(r.employeeId),
    employeeName: fullEmployeeName(r),
    position: r.position ?? null,
    branchName: r.branchName ?? null,
    employmentStatus: r.employmentStatus,
    assignment:
      r.assignmentId != null
        ? {
            id: Number(r.assignmentId),
            planId: Number(r.planId),
            planName: r.planName ?? "",
            effectiveFrom: r.effectiveFrom ?? "",
          }
        : null,
  }));
}

export interface AssignPlanInput {
  employeeId: number;
  planId: number;
  /** أول شهر يسري فيه الإسناد (YYYY-MM). */
  effectiveFrom: string;
}

export interface AssignPlanResult {
  assignmentId: number;
  /** الإسناد المفتوح السابق الذي أُغلق آلياً (إن وُجد) — للتوثيق في الواجهة والتدقيق. */
  closedPrevious: { assignmentId: number; planId: number; closedAt: string } | null;
}

export async function assignPlan(input: AssignPlanInput, actor: Actor): Promise<AssignPlanResult> {
  const from = assertPeriod(input.effectiveFrom);
  return withTx(async (tx) => {
    // قفل صفّ الموظف يسلسل الإسنادات المتزامنة لنفس الموظف (بديل قيد استبعاد المدى الغائب في MySQL).
    const [emp] = await tx.select().from(employees).where(eq(employees.id, input.employeeId)).for("update");
    if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود." });
    if (emp.userId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الموظف غير مرتبط بحساب مستخدم — اربطه أولاً من شاشة الموظف؛ نسبة المبيعات تتبع حساب المستخدم.",
      });
    }
    if (emp.employmentStatus === "terminated") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُسنَد لموظف منتهي الخدمة." });
    }
    const [plan] = await tx.select().from(commissionPlans).where(eq(commissionPlans.id, input.planId)).limit(1);
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة." });
    if (!plan.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة غير فعّالة — فعّلها أولاً." });

    const existing = await tx
      .select()
      .from(commissionAssignments)
      .where(eq(commissionAssignments.employeeId, input.employeeId));

    let closedPrevious: AssignPlanResult["closedPrevious"] = null;
    for (const a of existing) {
      if (a.effectiveTo == null) {
        if (Number(a.planId) === input.planId && a.effectiveFrom <= from) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "هذه الخطة مُسنَدة فعلاً لهذا الموظف." });
        }
        if (a.effectiveFrom >= from) {
          // إغلاقه عند prevPeriod(from) يعطي مدىً فارغاً/سالباً ⇒ نرفض بدل تخريب التاريخ.
          throw new TRPCError({
            code: "CONFLICT",
            message: `يوجد إسناد مفتوح يبدأ في ${a.effectiveFrom} — أنهِه أولاً أو اختر شهراً بعده.`,
          });
        }
        const closeAt = prevPeriod(from);
        await tx
          .update(commissionAssignments)
          .set({ effectiveTo: closeAt })
          .where(eq(commissionAssignments.id, a.id));
        closedPrevious = { assignmentId: Number(a.id), planId: Number(a.planId), closedAt: closeAt };
      } else if (a.effectiveTo >= from) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `يتقاطع مع إسناد سابق ساري حتى ${a.effectiveTo} — اختر شهراً بعده.`,
        });
      }
    }

    const res = await tx.insert(commissionAssignments).values({
      employeeId: input.employeeId,
      planId: input.planId,
      effectiveFrom: from,
      effectiveTo: null,
      createdBy: actor.userId,
    });
    return { assignmentId: extractInsertId(res), closedPrevious };
  });
}

export interface EndAssignmentInput {
  assignmentId: number;
  /** آخر شهر يسري فيه الإسناد (YYYY-MM، شاملاً). */
  effectiveTo: string;
}

export async function endAssignment(input: EndAssignmentInput): Promise<void> {
  const to = assertPeriod(input.effectiveTo);
  await withTx(async (tx) => {
    const [a] = await tx
      .select()
      .from(commissionAssignments)
      .where(eq(commissionAssignments.id, input.assignmentId))
      .for("update");
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "الإسناد غير موجود." });
    if (a.effectiveTo != null) throw new TRPCError({ code: "BAD_REQUEST", message: "الإسناد مُنهى فعلاً." });
    if (to < a.effectiveFrom) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "شهر الإنهاء قبل شهر البدء." });
    }
    await tx.update(commissionAssignments).set({ effectiveTo: to }).where(eq(commissionAssignments.id, input.assignmentId));
  });
}
