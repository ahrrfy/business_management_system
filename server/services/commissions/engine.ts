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
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  commissionAssignments,
  commissionPlans,
  commissionPlanTiers,
  commissionRunLines,
  commissionRuns,
  employees,
  salesTargets,
  shifts,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { computeNetSalesByUser } from "./base";
import { assertPeriod, periodDateRange } from "./period";

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
  tiers: {
    sort: number;
    threshold: Decimal;
    ratePct: Decimal;
    fixedBonus: Decimal;
  }[];
}

/** الإسنادات الفعّالة للشهر P — سطر لكل موظف مؤهَّل (التداخل ممنوع كتابةً؛ نحسم دفاعياً بالأحدث).
 *  مشتركة مع لوحة الإنجاز/«أدائي» الحيّتين (S5) ⇒ تقبل DB أو Tx. */
export async function loadEligible(
  runner: DB | Tx,
  period: string,
  scopedBranchId: number | null = null,
): Promise<EligibleRow[]> {
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
        scopedBranchId == null
          ? undefined
          : eq(employees.branchId, scopedBranchId),
      ),
    )
    .orderBy(
      asc(commissionAssignments.effectiveFrom),
      asc(commissionAssignments.id),
    );

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

export async function loadPlans(
  runner: DB | Tx,
  planIds: number[],
): Promise<Map<number, PlanWithTiers>> {
  if (planIds.length === 0) return new Map();
  const plans = await runner
    .select()
    .from(commissionPlans)
    .where(inArray(commissionPlans.id, planIds));
  const tiers = await runner
    .select()
    .from(commissionPlanTiers)
    .where(inArray(commissionPlanTiers.planId, planIds))
    .orderBy(
      asc(commissionPlanTiers.planId),
      asc(commissionPlanTiers.threshold),
    );

  const map = new Map<number, PlanWithTiers>();
  for (const p of plans) {
    if (p.basis !== "NET_SALES") {
      // enum يحجز COLLECTED/PROFIT مستقبلاً — المحرّك الحالي يعرف NET_SALES فقط ويرفض غيره
      // صراحةً بدل احتسابٍ خاطئ صامت.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الخطة «${p.name}» بأساس غير مدعوم بعد (${p.basis}).`,
      });
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
export async function loadCarryIn(
  runner: DB | Tx,
  period: string,
  targetEmployeeId?: number,
): Promise<Map<number, Decimal>> {
  const rows = await runner
    .select({
      employeeId: commissionRunLines.employeeId,
      carryOut: commissionRunLines.carryOut,
      period: commissionRuns.period,
    })
    .from(commissionRunLines)
    .innerJoin(commissionRuns, eq(commissionRuns.id, commissionRunLines.runId))
    .where(
      and(
        eq(commissionRuns.status, "approved"),
        lt(commissionRuns.period, period),
        targetEmployeeId != null ? eq(commissionRunLines.employeeId, targetEmployeeId) : undefined,
      ),
    );

  const latest = new Map<number, { period: string; carryOut: Decimal }>();
  for (const r of rows) {
    const empId = Number(r.employeeId);
    const prev = latest.get(empId);
    if (!prev || r.period > prev.period)
      latest.set(empId, { period: r.period, carryOut: money(r.carryOut) });
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
): {
  tier: PlanWithTiers["tiers"][number] | null;
  ratePct: Decimal;
  fixedBonus: Decimal;
  commission: Decimal;
} {
  const measure =
    plan.tierMode === "TARGET_PCT" ? achievementPct : effectiveBase;
  let tier: PlanWithTiers["tiers"][number] | null = null;
  const sortedTiers = [...plan.tiers].sort((a, b) =>
    a.threshold.comparedTo(b.threshold),
  );
  if (measure != null) {
    for (const t of sortedTiers) if (t.threshold.lte(measure)) tier = t;
  }
  const ratePct = tier ? tier.ratePct : new Decimal(0);
  const fixedBonus = tier ? tier.fixedBonus : new Decimal(0);
  const commission = tier
    ? round2(effectiveBase.times(ratePct).div(100)).plus(fixedBonus)
    : new Decimal(0);
  return { tier, ratePct, fixedBonus, commission };
}

/**
 * حساب الشرائح التصاعدية الهامشية (Marginal Progressive Slabs — Tax-bracket style):
 * تُطبَّق الشرائح تدريجياً فقط على المبيعات الواقعة ضمن كل شريحة لتفادي قفزات العتبات الحادة.
 */
export function calculateMarginalSlabs(
  effectiveBase: Decimal,
  slabs: { from: Decimal; to?: Decimal; ratePct: Decimal }[],
): Decimal {
  let totalCommission = new Decimal(0);
  for (const slab of slabs) {
    if (effectiveBase.lte(slab.from)) continue;
    const bracketUpper = slab.to
      ? Decimal.min(effectiveBase, slab.to)
      : effectiveBase;
    const taxableInBracket = bracketUpper.minus(slab.from);
    if (taxableInBracket.gt(0)) {
      const comm = round2(taxableInBracket.times(slab.ratePct).div(100));
      totalCommission = totalCommission.plus(comm);
    }
  }
  return totalCommission;
}

/**
 * احتساب حوافز ومكافآت الأنشطة لموظفي الاستقبال ومجهزي الطلبات:
 * حافز مقطوع لكل أمر شغل منجز / طلب متجر مجهز (COORDINATION_STORE_ORDERS.md).
 */
export function calculateActivityBounties(opts: {
  completedWorkOrdersCount: number;
  bountyPerWorkOrder: Decimal;
  dispatchedOnlineOrdersCount: number;
  bountyPerOnlineOrder: Decimal;
}): {
  workOrderBounty: Decimal;
  fulfillerBounty: Decimal;
  totalBounties: Decimal;
} {
  const woCount = Math.max(0, opts.completedWorkOrdersCount);
  const foCount = Math.max(0, opts.dispatchedOnlineOrdersCount);
  const woBounty = round2(new Decimal(woCount).times(opts.bountyPerWorkOrder));
  const foBounty = round2(
    new Decimal(foCount).times(opts.bountyPerOnlineOrder),
  );
  return {
    workOrderBounty: woBounty,
    fulfillerBounty: foBounty,
    totalBounties: woBounty.plus(foBounty),
  };
}

/**
 * تقييم حافز دقة إقفال الدرج النقدي للكاشير (Cashier Balancing Bonus):
 * يُمنح فقط في حال مطابقة الصندوق وانعدام العجز فوق سقف التسامح عبر كافة الورديات.
 */
export function evaluateCashierBalancingBonus(opts: {
  shifts: { actualCashCounted: Decimal; expectedCash: Decimal }[];
  balancingAllowance: Decimal;
  disqualificationThreshold: Decimal;
}): {
  eligible: boolean;
  bonusAmount: Decimal;
  disqualificationReason?: string;
  reason?: string;
} {
  if (!opts.shifts || opts.shifts.length === 0) {
    return {
      eligible: false,
      bonusAmount: new Decimal(0),
      reason: "no_shifts_recorded",
      disqualificationReason: "no_shifts_recorded",
    };
  }

  let hasViolation = false;
  let maxShortage = new Decimal(0);

  for (const sh of opts.shifts) {
    const variance = sh.actualCashCounted.minus(sh.expectedCash);
    if (variance.lt(0)) {
      const shortage = variance.abs();
      if (shortage.gt(maxShortage)) maxShortage = shortage;
      if (shortage.gt(opts.disqualificationThreshold)) {
        hasViolation = true;
      }
    }
  }

  if (hasViolation) {
    const reasonMsg = `تجاوز العجز النقدي سقف التسامح (${maxShortage.toString()} د.ع)`;
    return {
      eligible: false,
      bonusAmount: new Decimal(0),
      disqualificationReason: reasonMsg,
      reason: reasonMsg,
    };
  }

  return {
    eligible: true,
    bonusAmount: opts.balancingAllowance,
  };
}

/**
 * مضاعف تحقيق الهدف (Target Multiplier / Accelerator):
 * مسرّع إضافي عند تجاوز نسبة تحقيق الهدف للحدود القياسية (100% و120%).
 */
export function calculateTargetMultiplier(
  achievementPct: Decimal | null,
  tiers: { thresholdPct: Decimal; multiplier: Decimal }[] = [
    { thresholdPct: new Decimal("120"), multiplier: new Decimal("1.50") },
    { thresholdPct: new Decimal("100"), multiplier: new Decimal("1.20") },
    { thresholdPct: new Decimal("0"), multiplier: new Decimal("1.00") },
  ],
): Decimal {
  if (!achievementPct || achievementPct.lt(0)) return new Decimal("1.00");
  const sorted = [...tiers].sort((a, b) =>
    b.thresholdPct.gt(a.thresholdPct) ? 1 : -1,
  );
  for (const t of sorted) {
    if (achievementPct.gte(t.thresholdPct)) {
      return t.multiplier;
    }
  }
  return new Decimal("1.00");
}

export interface ComputeCommissionRunOptions {
  bountyPerWorkOrder?: Decimal | string | number;
  bountyPerOnlineOrder?: Decimal | string | number;
  cashierBalancingAllowance?: Decimal | string | number;
  cashierDisqualificationThreshold?: Decimal | string | number;
  cashierShiftsByUser?:
    | Map<number, { actualCashCounted: Decimal; expectedCash: Decimal }[]>
    | Record<number, { actualCashCounted: Decimal; expectedCash: Decimal }[]>;
}

export interface ComputeResult {
  runId: number;
  period: string;
  employeeCount: number;
  totalCommission: string;
  recomputed: boolean;
}

/** احتساب (أو إعادة احتساب مسودة) تشغيلة عمولات الشهر P — ذرّي بالكامل. */
export async function computeCommissionRun(
  period: string,
  actor: Actor,
  scopedBranchId: number | null = null,
  options?: ComputeCommissionRunOptions,
): Promise<ComputeResult> {
  const p = assertPeriod(period);
  return withTx(async (tx) => {
    // ١) حارس التسلسل — الترحيل يُقرأ من المعتمَد فقط، فلا نقفز فوق مسودة أقدم.
    const [olderDraft] = await tx
      .select({ id: commissionRuns.id, period: commissionRuns.period })
      .from(commissionRuns)
      .where(
        and(eq(commissionRuns.status, "draft"), lt(commissionRuns.period, p)),
      )
      .limit(1);
    if (olderDraft) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `اعتمد (أو احذف) تشغيلة شهر ${olderDraft.period} أولاً — الترحيل السالب يُبنى على المعتمَد.`,
      });
    }

    // ٢) رأس التشغيلة تحت قفل.
    const [existing] = await tx
      .select()
      .from(commissionRuns)
      .where(eq(commissionRuns.period, p))
      .for("update");
    let runId: number;
    let recomputed = false;
    if (existing) {
      if (existing.status === "approved") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `تشغيلة عمولات ${p} معتمدة — لا يُعاد احتسابها. ألغِ الاعتماد أولاً إن لزم.`,
        });
      }
      runId = Number(existing.id);
      recomputed = true;
      await tx
        .delete(commissionRunLines)
        .where(
          and(
            eq(commissionRunLines.runId, runId),
            scopedBranchId == null
              ? undefined
              : eq(commissionRunLines.branchId, scopedBranchId),
          ),
        );
    } else {
      const res = await tx
        .insert(commissionRuns)
        .values({ period: p, status: "draft", createdBy: actor.userId });
      runId = extractInsertId(res);
    }

    // ٣) الأهلية والمدخلات.
    const eligible = await loadEligible(tx, p, scopedBranchId);
    if (eligible.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "لا موظفين بإسناد خطة فعّال لهذا الشهر — أسند الخطط أولاً من «خطط العمولات».",
      });
    }
    const plans = await loadPlans(
      tx,
      Array.from(new Set(eligible.map((e) => e.planId))),
    );
    const baseByUser = await computeNetSalesByUser(tx, p);
    const carryByEmployee = await loadCarryIn(tx, p);
    const targetRows = await tx
      .select({
        employeeId: salesTargets.employeeId,
        targetAmount: salesTargets.targetAmount,
      })
      .from(salesTargets)
      .where(eq(salesTargets.period, p));
    const targetByEmployee = new Map(
      targetRows.map((t) => [Number(t.employeeId), money(t.targetAmount)]),
    );

    // إعداد معطيات الحوافز ومكافأة موازنة الدرج (Milestone 2)
    const bountyPerWorkOrder =
      options?.bountyPerWorkOrder != null
        ? money(options.bountyPerWorkOrder)
        : new Decimal(0);
    const bountyPerOnlineOrder =
      options?.bountyPerOnlineOrder != null
        ? money(options.bountyPerOnlineOrder)
        : new Decimal(0);
    const cashierAllowance =
      options?.cashierBalancingAllowance != null
        ? money(options.cashierBalancingAllowance)
        : new Decimal(0);
    const cashierThreshold =
      options?.cashierDisqualificationThreshold != null
        ? money(options.cashierDisqualificationThreshold)
        : new Decimal(5000);

    const cashierShiftsMap = new Map<
      number,
      { actualCashCounted: Decimal; expectedCash: Decimal }[]
    >();
    if (options?.cashierShiftsByUser) {
      if (options.cashierShiftsByUser instanceof Map) {
        options.cashierShiftsByUser.forEach((v, k) =>
          cashierShiftsMap.set(k, v),
        );
      } else {
        for (const [k, v] of Object.entries(options.cashierShiftsByUser)) {
          cashierShiftsMap.set(Number(k), v);
        }
      }
    } else if (cashierAllowance.gt(0)) {
      const { from, toExclusive } = periodDateRange(p);
      const dbShifts = await tx
        .select({
          userId: shifts.userId,
          countedCash: shifts.countedCash,
          expectedCash: shifts.expectedCash,
        })
        .from(shifts)
        .where(
          and(
            eq(shifts.status, "CLOSED"),
            sql`${shifts.openedAt} >= ${from}`,
            sql`${shifts.openedAt} < ${toExclusive}`,
            isNotNull(shifts.countedCash),
            isNotNull(shifts.expectedCash),
          ),
        );
      for (const sh of dbShifts) {
        const uId = Number(sh.userId);
        if (!cashierShiftsMap.has(uId)) cashierShiftsMap.set(uId, []);
        cashierShiftsMap.get(uId)!.push({
          actualCashCounted: money(sh.countedCash!),
          expectedCash: money(sh.expectedCash!),
        });
      }
    }

    // ٤) سطر لكل موظف مؤهَّل — حتى بصفر نشاط (سلسلة الترحيل + اكتمال الالتقاط).
    let totalSales = new Decimal(0);
    let totalReturns = new Decimal(0);
    let totalCommission = new Decimal(0);

    for (const e of eligible) {
      const plan = plans.get(e.planId);
      if (!plan)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `خطة مفقودة (${e.planId}).`,
        });

      const base = baseByUser.get(e.userId);
      const sales = base?.sales ?? new Decimal(0);
      const returns = base?.returns ?? new Decimal(0);
      // بضاعة الأمانة (ش٣): حصص المودِعين تُخصَم من الوعاء (العمولة على الهامش فقط — قرار المالك ٤).
      const consigDeduction = base?.consigDeduction ?? new Decimal(0);
      const carryIn = carryByEmployee.get(e.employeeId) ?? new Decimal(0);

      const grossBase = sales
        .minus(returns)
        .minus(consigDeduction)
        .plus(carryIn);
      const effectiveBase = Decimal.max(0, grossBase);
      const carryOut = Decimal.min(0, grossBase);

      const target = targetByEmployee.get(e.employeeId) ?? null;
      let achievementPct: Decimal | null = null;
      if (target && target.gt(0))
        achievementPct = round2(effectiveBase.div(target).times(100));

      // ١) شريحة المبيعات الصافية
      const {
        tier,
        ratePct,
        fixedBonus,
        commission: tierCommission,
      } = applyPlanTier(plan, effectiveBase, achievementPct);

      // ٢) حوافز الأنشطة (تجهيز طلبات المتجر واستقبال أوامر الشغل)
      const activityBounties = calculateActivityBounties({
        completedWorkOrdersCount: base?.workOrderCount ?? 0,
        bountyPerWorkOrder,
        dispatchedOnlineOrdersCount: base?.fulfilledOrderCount ?? 0,
        bountyPerOnlineOrder,
      });

      // ٣) حافز دقة إقفال درج الكاشير
      const userShifts = cashierShiftsMap.get(e.userId) ?? [];
      const cashierBonus = evaluateCashierBalancingBonus({
        shifts: userShifts,
        balancingAllowance: cashierAllowance,
        disqualificationThreshold: cashierThreshold,
      });

      const totalLineCommission = tierCommission
        .plus(activityBounties.totalBounties)
        .plus(
          cashierBonus.eligible ? cashierBonus.bonusAmount : new Decimal(0),
        );

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
        commissionAmount: toDbMoney(totalLineCommission),
        detail: {
          planName: plan.name,
          tierMode: plan.tierMode,
          tierThreshold: tier ? tier.threshold.toFixed(2) : null,
          saleEntryCount: base?.saleEntryCount ?? 0,
          returnEntryCount: base?.returnEntryCount ?? 0,
          fulfilledOrderCount: base?.fulfilledOrderCount ?? 0,
          workOrderCount: base?.workOrderCount ?? 0,
          noTarget: plan.tierMode === "TARGET_PCT" && !target,
          tierCommission: toDbMoney(tierCommission),
          activityBounties: {
            workOrderBounty: toDbMoney(activityBounties.workOrderBounty),
            fulfillerBounty: toDbMoney(activityBounties.fulfillerBounty),
            totalBounties: toDbMoney(activityBounties.totalBounties),
          },
          cashierBonus: {
            eligible: cashierBonus.eligible,
            bonusAmount: toDbMoney(cashierBonus.bonusAmount),
            reason:
              cashierBonus.disqualificationReason ??
              cashierBonus.reason ??
              null,
          },
        },
      });

      totalSales = totalSales.plus(sales);
      totalReturns = totalReturns.plus(returns);
      totalCommission = totalCommission.plus(totalLineCommission);
    }

    // ٥) رأس التشغيلة — بعد احتساب فرعٍ واحد تُعاد مجاميع الرأس من جميع الأسطر القائمة؛
    // مدير الفرع لا يحذف/يعيد احتساب أسطر الفروع الأخرى، والسلطة المركزية (scope=null)
    // تعيد بناء الكشف كاملاً. المُحتسِب الأخير يبقى maker المحظور من الاعتماد.
    const [runTotals] = await tx
      .select({
        employeeCount: sql<number>`COUNT(*)`,
        totalBaseSales: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseSales}), 0) AS CHAR)`,
        totalBaseReturns: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.baseReturns}), 0) AS CHAR)`,
        totalCommission: sql<string>`CAST(COALESCE(SUM(${commissionRunLines.commissionAmount}), 0) AS CHAR)`,
      })
      .from(commissionRunLines)
      .where(eq(commissionRunLines.runId, runId));
    await tx
      .update(commissionRuns)
      .set({
        employeeCount: Number(runTotals?.employeeCount ?? 0),
        totalBaseSales: toDbMoney(runTotals?.totalBaseSales ?? "0"),
        totalBaseReturns: toDbMoney(runTotals?.totalBaseReturns ?? "0"),
        totalCommission: toDbMoney(runTotals?.totalCommission ?? "0"),
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
