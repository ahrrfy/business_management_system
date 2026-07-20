/* ============================================================================
 * محرّك احتساب تشغيلة العمولات الشهرية (S3) — القلب المالي للوحدة.
 *
 * الخوارزمية (قرارات المالك ٦/٧/٢٦ + تصميم السلامة المالية):
 *  ١) حارس التسلسل: لا احتساب لشهر P وثمة تشغيلة أقدم ما تزال مسودة — سلسلة الترحيل
 *     السالب تُبنى على المعتمَد فقط، والقفز يفسدها.
 *  ٢) رأس التشغيلة تحت FOR UPDATE: معتمدة ⇒ CONFLICT؛ مسودة ⇒ إعادة احتساب (حذف الأسطر
 *     وإعادة إدراجها — uq_cline_run_emp يضمن سطراً واحداً لكل موظف)؛ غائبة ⇒ إدراج
 *     (uq_commission_period يحسم أي سباق إنشاء مزدوج بـER_DUP_ENTRY).
 *  ٣) الأهلية: إسناد خطة يغطّي P (effectiveFrom ≤ P ≤ effectiveTo|∞) لموظف مرتبط بمستخدم.
 *     employmentStatus لا يُفلتَر عمداً — المفصول منتصف الشهر يستحق ما باعه (§التسوية).
 *  ٤) الوعاء من كنسة base.ts (إسناد ذكي + مرتجعات الشهر تتبع البائع الأصلي).
 *  ٥) الترحيل: carryIn = carryOut آخر سطر **معتمد** بفترة أقدم؛ grossBase = مبيعات −
 *     مرتجعات + carryIn؛ effectiveBase = max(0, grossBase)؛ carryOut = min(0, grossBase).
 *  ٦) الشريحة: آخر عتبة ≤ المقياس (TARGET_PCT: نسبة الإنجاز٪؛ AMOUNT_SLAB: الأساس الفعلي)،
 *     والنسبة على **كامل** الأساس + مكافأة مقطوعة. لا هدف على TARGET_PCT ⇒ سطر صفري
 *     (يُكتب دائماً — يحفظ سلسلة الترحيل ويُبقي الموظف مرئياً في مراجعة الصرف).
 *  ٧) لقطات كاملة في السطر (الهدف/الخطة/الشريحة/النِّسَب) — تعديل الخطط لاحقاً لا يمسّ
 *     تشغيلة معتمدة، والمسودة تلتقط الجديد عند إعادة الاحتساب.
 *
 * كل الحساب decimal.js (money/round2/toDbMoney) — ممنوع Number على الأموال (§٥).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  commissionAssignments,
  commissionPlans,
  commissionPlanTiers,
  commissionRunLines,
  commissionRuns,
  employees,
  salesTargets,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { computeNetSalesByUser } from "./base";
import { assertPeriod } from "./period";

export interface EligibleRow {
  employeeId: number;
  userId: number;
  branchId: number | null;
  planId: number;
}

export interface PlanWithTiers {
  id: number;
  name: string;
  basis: string;
  tierMode: "TARGET_PCT" | "AMOUNT_SLAB";
  tiers: { sort: number; threshold: Decimal; ratePct: Decimal; fixedBonus: Decimal }[];
}

/** الإسنادات الفعّالة للشهر P — سطر لكل موظف مؤهَّل (التداخل ممنوع كتابةً؛ نحسم دفاعياً بالأحدث).
 *  مشتركة مع لوحة الإنجاز/«أدائي» الحيّتين (S5) ⇒ تقبل DB أو Tx. */
export async function loadEligible(runner: DB | Tx, period: string): Promise<EligibleRow[]> {
  const rows = await runner
    .select({
      employeeId: commissionAssignments.employeeId,
      planId: commissionAssignments.planId,
      effectiveFrom: commissionAssignments.effectiveFrom,
      userId: employees.userId,
      branchId: employees.branchId,
    })
    .from(commissionAssignments)
    .innerJoin(employees, eq(employees.id, commissionAssignments.employeeId))
    .where(
      and(
        sql`${commissionAssignments.effectiveFrom} <= ${period}`,
        sql`(${commissionAssignments.effectiveTo} IS NULL OR ${commissionAssignments.effectiveTo} >= ${period})`,
        sql`${employees.userId} IS NOT NULL`,
      ),
    )
    .orderBy(asc(commissionAssignments.effectiveFrom), asc(commissionAssignments.id));

  const byEmployee = new Map<number, EligibleRow>();
  for (const r of rows) {
    byEmployee.set(Number(r.employeeId), {
      employeeId: Number(r.employeeId),
      userId: Number(r.userId),
      branchId: r.branchId != null ? Number(r.branchId) : null,
      planId: Number(r.planId),
    });
  }
  return Array.from(byEmployee.values());
}

export async function loadPlans(runner: DB | Tx, planIds: number[]): Promise<Map<number, PlanWithTiers>> {
  if (planIds.length === 0) return new Map();
  const plans = await runner.select().from(commissionPlans).where(inArray(commissionPlans.id, planIds));
  const tiers = await runner
    .select()
    .from(commissionPlanTiers)
    .where(inArray(commissionPlanTiers.planId, planIds))
    .orderBy(asc(commissionPlanTiers.planId), asc(commissionPlanTiers.threshold));

  const map = new Map<number, PlanWithTiers>();
  for (const p of plans) {
    if (p.basis !== "NET_SALES") {
      // enum يحجز COLLECTED/PROFIT مستقبلاً — المحرّك الحالي يعرف NET_SALES فقط ويرفض غيره
      // صراحةً بدل احتسابٍ خاطئ صامت.
      throw new TRPCError({ code: "BAD_REQUEST", message: `الخطة «${p.name}» بأساس غير مدعوم بعد (${p.basis}).` });
    }
    map.set(Number(p.id), {
      id: Number(p.id),
      name: p.name,
      basis: p.basis,
      tierMode: p.tierMode,
      tiers: [],
    });
  }
  for (const t of tiers) {
    map.get(Number(t.planId))?.tiers.push({
      sort: t.sort,
      threshold: money(t.threshold),
      ratePct: money(t.ratePct),
      fixedBonus: money(t.fixedBonus),
    });
  }
  return map;
}

/** carryOut آخر سطر معتمد بفترة أقدم من P لكل موظف — أساس سلسلة الترحيل السالب. */
export async function loadCarryIn(runner: DB | Tx, period: string): Promise<Map<number, Decimal>> {
  const rows = await runner
    .select({
      employeeId: commissionRunLines.employeeId,
      carryOut: commissionRunLines.carryOut,
      period: commissionRuns.period,
    })
    .from(commissionRunLines)
    .innerJoin(commissionRuns, eq(commissionRuns.id, commissionRunLines.runId))
    .where(and(eq(commissionRuns.status, "approved"), lt(commissionRuns.period, period)));

  const latest = new Map<number, { period: string; carryOut: Decimal }>();
  for (const r of rows) {
    const empId = Number(r.employeeId);
    const prev = latest.get(empId);
    if (!prev || r.period > prev.period) latest.set(empId, { period: r.period, carryOut: money(r.carryOut) });
  }
  const out = new Map<number, Decimal>();
  latest.forEach((v, empId) => out.set(empId, v.carryOut));
  return out;
}

/** تطبيق شريحة الخطة على الأساس الفعلي — دالة نقية مشتركة بين المحرّك (اللقطات) والعرض الحيّ (S5).
 *  القاعدة: آخر عتبة ≤ المقياس (TARGET_PCT: نسبة الإنجاز؛ AMOUNT_SLAB: الأساس)، والنسبة على كامل الأساس. */
export function applyPlanTier(
  plan: PlanWithTiers,
  effectiveBase: Decimal,
  achievementPct: Decimal | null,
): { tier: PlanWithTiers["tiers"][number] | null; ratePct: Decimal; fixedBonus: Decimal; commission: Decimal } {
  const measure = plan.tierMode === "TARGET_PCT" ? achievementPct : effectiveBase;
  let tier: PlanWithTiers["tiers"][number] | null = null;
  if (measure != null) {
    for (const t of plan.tiers) if (t.threshold.lte(measure)) tier = t;
  }
  const ratePct = tier ? tier.ratePct : new Decimal(0);
  const fixedBonus = tier ? tier.fixedBonus : new Decimal(0);
  const commission = tier ? round2(effectiveBase.times(ratePct).div(100)).plus(fixedBonus) : new Decimal(0);
  return { tier, ratePct, fixedBonus, commission };
}

export interface ComputeResult {
  runId: number;
  period: string;
  employeeCount: number;
  totalCommission: string;
  recomputed: boolean;
}

/** احتساب (أو إعادة احتساب مسودة) تشغيلة عمولات الشهر P — ذرّي بالكامل. */
export async function computeCommissionRun(period: string, actor: Actor): Promise<ComputeResult> {
  const p = assertPeriod(period);
  return withTx(async (tx) => {
    // ١) حارس التسلسل — الترحيل يُقرأ من المعتمَد فقط، فلا نقفز فوق مسودة أقدم.
    const [olderDraft] = await tx
      .select({ id: commissionRuns.id, period: commissionRuns.period })
      .from(commissionRuns)
      .where(and(eq(commissionRuns.status, "draft"), lt(commissionRuns.period, p)))
      .limit(1);
    if (olderDraft) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `اعتمد (أو احذف) تشغيلة شهر ${olderDraft.period} أولاً — الترحيل السالب يُبنى على المعتمَد.`,
      });
    }

    // ٢) رأس التشغيلة تحت قفل.
    const [existing] = await tx.select().from(commissionRuns).where(eq(commissionRuns.period, p)).for("update");
    let runId: number;
    let recomputed = false;
    if (existing) {
      if (existing.status === "approved") {
        throw new TRPCError({ code: "CONFLICT", message: `تشغيلة عمولات ${p} معتمدة — لا يُعاد احتسابها. ألغِ الاعتماد أولاً إن لزم.` });
      }
      runId = Number(existing.id);
      recomputed = true;
      await tx.delete(commissionRunLines).where(eq(commissionRunLines.runId, runId));
    } else {
      const res = await tx.insert(commissionRuns).values({ period: p, status: "draft", createdBy: actor.userId });
      runId = extractInsertId(res);
    }

    // ٣) الأهلية والمدخلات.
    const eligible = await loadEligible(tx, p);
    if (eligible.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا موظفين بإسناد خطة فعّال لهذا الشهر — أسند الخطط أولاً من «خطط العمولات»." });
    }
    const plans = await loadPlans(tx, Array.from(new Set(eligible.map((e) => e.planId))));
    const baseByUser = await computeNetSalesByUser(tx, p);
    const carryByEmployee = await loadCarryIn(tx, p);
    const targetRows = await tx
      .select({ employeeId: salesTargets.employeeId, targetAmount: salesTargets.targetAmount })
      .from(salesTargets)
      .where(eq(salesTargets.period, p));
    const targetByEmployee = new Map(targetRows.map((t) => [Number(t.employeeId), money(t.targetAmount)]));

    // ٤) سطر لكل موظف مؤهَّل — حتى بصفر نشاط (سلسلة الترحيل + اكتمال الالتقاط).
    let totalSales = new Decimal(0);
    let totalReturns = new Decimal(0);
    let totalCommission = new Decimal(0);

    for (const e of eligible) {
      const plan = plans.get(e.planId);
      if (!plan) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `خطة مفقودة (${e.planId}).` });

      const base = baseByUser.get(e.userId);
      const sales = base?.sales ?? new Decimal(0);
      const returns = base?.returns ?? new Decimal(0);
      // بضاعة الأمانة (ش٣): حصص المودِعين تُخصَم من الوعاء (العمولة على الهامش فقط — قرار المالك ٤).
      const consigDeduction = base?.consigDeduction ?? new Decimal(0);
      const carryIn = carryByEmployee.get(e.employeeId) ?? new Decimal(0);

      const grossBase = sales.minus(returns).minus(consigDeduction).plus(carryIn);
      const effectiveBase = Decimal.max(0, grossBase);
      const carryOut = Decimal.min(0, grossBase);

      const target = targetByEmployee.get(e.employeeId) ?? null;
      let achievementPct: Decimal | null = null;
      if (target && target.gt(0)) achievementPct = round2(effectiveBase.div(target).times(100));

      // المقياس حسب نمط الخطة — TARGET_PCT بلا هدف ⇒ لا شريحة (سطر صفري مرئي).
      const { tier, ratePct, fixedBonus, commission } = applyPlanTier(plan, effectiveBase, achievementPct);

      await tx.insert(commissionRunLines).values({
        runId,
        employeeId: e.employeeId,
        userId: e.userId,
        branchId: e.branchId,
        baseSales: toDbMoney(sales),
        baseReturns: toDbMoney(returns),
        baseConsignDeduction: toDbMoney(consigDeduction),
        carryIn: toDbMoney(carryIn),
        effectiveBase: toDbMoney(effectiveBase),
        carryOut: toDbMoney(carryOut),
        targetAmount: target ? toDbMoney(target) : null,
        achievementPct: achievementPct ? achievementPct.toFixed(2) : null,
        planId: plan.id,
        tierIndex: tier ? tier.sort : null,
        ratePct: ratePct.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
        fixedBonus: toDbMoney(fixedBonus),
        commissionAmount: toDbMoney(commission),
        detail: {
          planName: plan.name,
          tierMode: plan.tierMode,
          tierThreshold: tier ? tier.threshold.toFixed(2) : null,
          saleEntryCount: base?.saleEntryCount ?? 0,
          returnEntryCount: base?.returnEntryCount ?? 0,
          noTarget: plan.tierMode === "TARGET_PCT" && !target,
        },
      });

      totalSales = totalSales.plus(sales);
      totalReturns = totalReturns.plus(returns);
      totalCommission = totalCommission.plus(commission);
    }

    // ٥) رأس التشغيلة — المُحتسِب الحالي يملك الأرقام النهائية (التاريخ الكامل في auditLogs).
    await tx
      .update(commissionRuns)
      .set({
        employeeCount: eligible.length,
        totalBaseSales: toDbMoney(totalSales),
        totalBaseReturns: toDbMoney(totalReturns),
        totalCommission: toDbMoney(totalCommission),
        createdBy: actor.userId,
        computedAt: new Date(),
      })
      .where(eq(commissionRuns.id, runId));

    return {
      runId,
      period: p,
      employeeCount: eligible.length,
      totalCommission: toDbMoney(totalCommission),
      recomputed,
    };
  });
}
