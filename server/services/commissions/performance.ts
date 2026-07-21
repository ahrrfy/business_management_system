/* ============================================================================
 * الأداء الحيّ (S5): لوحة الإنجاز الشهرية + «أدائي» الذاتي.
 *
 * حساب حيّ **قراءةً بحتة** يعيد استعمال محرّك التشغيلات نفسه (كنسة base.ts +
 * loadEligible/loadPlans/loadCarryIn/applyPlanTier) ⇒ رقم اللوحة اليوم = رقم
 * التشغيلة عند احتسابها بنفس اللحظة — مصدر حقيقة واحد بلا انحراف.
 * العمولة المعروضة «تقديرية» حتى تُحتسب التشغيلة وتُعتمد (الصرف من اللقطات فقط).
 *
 * «أدائي» ذاتي بحت: الهوية من users.id في السياق حصراً (لا مدخل employeeId إطلاقاً)
 * — اتّساق مع عزل scopedOwnerId. لا يكشف cost/profit (الأساس مبيعات) ولا أي زميل.
 * ========================================================================== */
import { and, desc, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { fullEmployeeName } from "@shared/hr";
import {
  branches,
  commissionRunLines,
  commissionRuns,
  employees,
  salesTargets,
} from "../../../drizzle/schema";
import { money, round2, toDbMoney } from "../money";
import { requireDb } from "../tx";
import { computeNetSalesByUser } from "./base";
import { applyPlanTier, loadCarryIn, loadEligible, loadPlans } from "./engine";
import { assertPeriod, currentPeriodUTC, prevPeriod } from "./period";

export interface LeaderboardRow {
  rank: number;
  employeeId: number;
  employeeName: string;
  position: string | null;
  branchName: string | null;
  planName: string;
  sales: string;
  returns: string;
  carryIn: string;
  effectiveBase: string;
  target: string | null;
  achievementPct: string | null;
  projectedCommission: string;
  reachedTarget: boolean;
}

export interface LeaderboardResult {
  period: string;
  rows: LeaderboardRow[];
  totals: {
    sales: string;
    effectiveBase: string;
    target: string;
    projectedCommission: string;
    withTarget: number;
    reached: number;
    below50: number;
  };
}

/** لوحة الإنجاز الحيّة لشهر P — ترتيب بالقاعدة الفعلية تنازلياً. */
export async function getLeaderboard(period: string): Promise<LeaderboardResult> {
  const p = assertPeriod(period);
  const db = requireDb();

  const eligible = await loadEligible(db, p);
  if (eligible.length === 0) {
    return {
      period: p,
      rows: [],
      totals: { sales: "0.00", effectiveBase: "0.00", target: "0.00", projectedCommission: "0.00", withTarget: 0, reached: 0, below50: 0 },
    };
  }

  const plans = await loadPlans(db, Array.from(new Set(eligible.map((e) => e.planId))));
  const baseByUser = await computeNetSalesByUser(db, p);
  const carryByEmployee = await loadCarryIn(db, p);
  const targetRows = await db
    .select({ employeeId: salesTargets.employeeId, targetAmount: salesTargets.targetAmount })
    .from(salesTargets)
    .where(eq(salesTargets.period, p));
  const targetByEmployee = new Map(targetRows.map((t) => [Number(t.employeeId), money(t.targetAmount)]));

  const empRows = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      branchName: branches.name,
    })
    .from(employees)
    .leftJoin(branches, eq(branches.id, employees.branchId))
    .where(inArray(employees.id, eligible.map((e) => e.employeeId)));
  const empById = new Map(empRows.map((r) => [Number(r.id), r]));

  let tSales = new Decimal(0);
  let tBase = new Decimal(0);
  let tTarget = new Decimal(0);
  let tProjected = new Decimal(0);
  let withTarget = 0;
  let reached = 0;
  let below50 = 0;

  const unranked = eligible.map((e) => {
    const plan = plans.get(e.planId)!;
    const base = baseByUser.get(e.userId);
    const sales = base?.sales ?? new Decimal(0);
    const returns = base?.returns ?? new Decimal(0);
    const consigDeduction = base?.consigDeduction ?? new Decimal(0);
    const carryIn = carryByEmployee.get(e.employeeId) ?? new Decimal(0);
    const grossBase = sales.minus(returns).minus(consigDeduction).plus(carryIn);
    const effectiveBase = Decimal.max(0, grossBase);

    const target = targetByEmployee.get(e.employeeId) ?? null;
    const achievementPct = target && target.gt(0) ? round2(effectiveBase.div(target).times(100)) : null;
    const { commission } = applyPlanTier(plan, effectiveBase, achievementPct);

    tSales = tSales.plus(sales);
    tBase = tBase.plus(effectiveBase);
    tProjected = tProjected.plus(commission);
    if (target && target.gt(0)) {
      withTarget++;
      tTarget = tTarget.plus(target);
      if (achievementPct!.gte(100)) reached++;
      else if (achievementPct!.lt(50)) below50++;
    }

    const emp = empById.get(e.employeeId);
    return {
      employeeId: e.employeeId,
      employeeName: emp ? fullEmployeeName(emp) : `#${e.employeeId}`,
      position: emp?.position ?? null,
      branchName: emp?.branchName ?? null,
      planName: plan.name,
      _base: effectiveBase,
      sales: toDbMoney(sales),
      returns: toDbMoney(returns),
      carryIn: toDbMoney(carryIn),
      effectiveBase: toDbMoney(effectiveBase),
      target: target ? toDbMoney(target) : null,
      achievementPct: achievementPct ? achievementPct.toFixed(2) : null,
      projectedCommission: toDbMoney(commission),
      reachedTarget: achievementPct != null && achievementPct.gte(100),
    };
  });

  unranked.sort((a, b) => b._base.comparedTo(a._base));
  const rows: LeaderboardRow[] = unranked.map((r, i) => {
    const { _base, ...rest } = r;
    void _base;
    return { rank: i + 1, ...rest };
  });

  return {
    period: p,
    rows,
    totals: {
      sales: toDbMoney(tSales),
      effectiveBase: toDbMoney(tBase),
      target: toDbMoney(tTarget),
      projectedCommission: toDbMoney(tProjected),
      withTarget,
      reached,
      below50,
    },
  };
}

export interface MyStatusResult {
  period: string;
  employeeName: string;
  planName: string | null;
  tierMode: "TARGET_PCT" | "AMOUNT_SLAB" | null;
  sales: string;
  returns: string;
  /** حصص بضاعة الأمانة المستثناة من الوعاء (0 إن لا شيء) — القرار ٤: العمولة على الهامش فقط. */
  consignDeduction: string;
  carryIn: string;
  effectiveBase: string;
  target: string | null;
  achievementPct: string | null;
  /** تقديري من الأرقام الحيّة — الصرف الفعلي من تشغيلة معتمدة فقط. */
  projectedCommission: string;
  /** سطر التشغيلة الفعلي لهذا الشهر إن احتُسب (مسودة/معتمدة). */
  settled: { commissionAmount: string; status: "draft" | "approved" } | null;
  /** آخر ٣ أشهر سابقة من التشغيلات (الأحدث أولاً). */
  history: { period: string; effectiveBase: string; commissionAmount: string; status: "draft" | "approved" }[];
}

/** «أدائي» — الهوية من userId حصراً؛ null = لا موظف مرتبط أو لا خطة له (البطاقة تختفي). */
export async function getMyStatus(userId: number, period?: string): Promise<MyStatusResult | null> {
  const p = period ? assertPeriod(period) : currentPeriodUTC();
  const db = requireDb();

  const [emp] = await db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
    })
    .from(employees)
    .where(eq(employees.userId, userId))
    .limit(1);
  if (!emp) return null;
  const employeeId = Number(emp.id);

  const eligible = await loadEligible(db, p);
  const mine = eligible.find((e) => e.employeeId === employeeId) ?? null;
  const [targetRow] = await db
    .select({ targetAmount: salesTargets.targetAmount })
    .from(salesTargets)
    .where(and(eq(salesTargets.employeeId, employeeId), eq(salesTargets.period, p)))
    .limit(1);
  const target = targetRow ? money(targetRow.targetAmount) : null;
  if (!mine && !target) return null; // لا خطة ولا هدف — لا شيء يُعرض.

  const baseByUser = await computeNetSalesByUser(db, p);
  const base = baseByUser.get(userId);
  const sales = base?.sales ?? new Decimal(0);
  const returns = base?.returns ?? new Decimal(0);
  const consigDeduction = base?.consigDeduction ?? new Decimal(0);
  const carryIn = (await loadCarryIn(db, p)).get(employeeId) ?? new Decimal(0);
  const effectiveBase = Decimal.max(0, sales.minus(returns).minus(consigDeduction).plus(carryIn));
  const achievementPct = target && target.gt(0) ? round2(effectiveBase.div(target).times(100)) : null;

  let planName: string | null = null;
  let tierMode: MyStatusResult["tierMode"] = null;
  let projected = new Decimal(0);
  if (mine) {
    const plans = await loadPlans(db, [mine.planId]);
    const plan = plans.get(mine.planId)!;
    planName = plan.name;
    tierMode = plan.tierMode;
    projected = applyPlanTier(plan, effectiveBase, achievementPct).commission;
  }

  const lineRows = await db
    .select({
      period: commissionRuns.period,
      status: commissionRuns.status,
      effectiveBase: commissionRunLines.effectiveBase,
      commissionAmount: commissionRunLines.commissionAmount,
    })
    .from(commissionRunLines)
    .innerJoin(commissionRuns, eq(commissionRuns.id, commissionRunLines.runId))
    .where(eq(commissionRunLines.employeeId, employeeId))
    .orderBy(desc(commissionRuns.period))
    .limit(4);

  const settledRow = lineRows.find((l) => l.period === p) ?? null;
  const history = lineRows
    .filter((l) => l.period < p)
    .slice(0, 3)
    .map((l) => ({
      period: l.period,
      effectiveBase: l.effectiveBase,
      commissionAmount: l.commissionAmount,
      status: l.status,
    }));

  return {
    period: p,
    employeeName: fullEmployeeName(emp),
    planName,
    tierMode,
    sales: toDbMoney(sales),
    returns: toDbMoney(returns),
    consignDeduction: toDbMoney(consigDeduction),
    carryIn: toDbMoney(carryIn),
    effectiveBase: toDbMoney(effectiveBase),
    target: target ? toDbMoney(target) : null,
    achievementPct: achievementPct ? achievementPct.toFixed(2) : null,
    projectedCommission: toDbMoney(projected),
    settled: settledRow ? { commissionAmount: settledRow.commissionAmount, status: settledRow.status } : null,
    history,
  };
}
