// لوحة المؤشّرات + تقرير العهد حسب الموظف + سجلّ الاستبعاد/الإخراج.
import Decimal from "decimal.js";
import { and, desc, eq, getTableColumns, inArray, ne } from "drizzle-orm";
import { assetMaintenance, branches, fixedAssets } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { money, sumMoney, toDateStr, toDbMoney } from "../money";
import type { CompanyBranchScope } from "../companyBranchScope";
import { computeDepreciation } from "./depreciation";
import { listAssets } from "./queries";

export async function dashboard(scope: CompanyBranchScope) {
  const all = await listAssets({ includeDisposed: true }, scope);
  const correctedAcquisitions = all.filter((a) => a.recognitionStatus === "CORRECTED");
  const live = all.filter((a) => a.recognitionStatus !== "CORRECTED" && (a.status === "active" || a.status === "maintenance" || a.status === "retired"));

  const totalAssets = live.length;
  // FA-05 (§٥): جمع قيم الشراء عبر decimal لا Number/float.
  const purchaseValue = sumMoney(live.map((a) => a.purchaseValue)).toNumber();
  const bookValue = live.reduce((s: Decimal, a) => s.plus(a.bookValue), new Decimal(0)).toNumber();
  const accumulated = live.reduce((s: Decimal, a) => s.plus(a.accumulated), new Decimal(0)).toNumber();
  const inMaintenance = live.filter((a) => a.status === "maintenance").length;
  const inCustody = live.filter((a) => a.custodianId).length;

  // القيمة الدفترية حسب الفئة.
  const byCategory = new Map<string, { count: number; value: number }>();
  for (const a of live) {
    const c = byCategory.get(a.category) ?? { count: 0, value: 0 };
    c.count += 1;
    c.value = new Decimal(c.value).plus(a.bookValue).toNumber();
    byCategory.set(a.category, c);
  }
  // القيمة الدفترية حسب الفرع.
  const byBranch = new Map<string, { count: number; value: number }>();
  for (const a of live) {
    const key = a.branchName ?? "بلا فرع";
    const b = byBranch.get(key) ?? { count: 0, value: 0 };
    b.count += 1;
    b.value = new Decimal(b.value).plus(a.bookValue).toNumber();
    byBranch.set(key, b);
  }

  // أحدث عمليات الصيانة (عبر كل الأصول).
  const db = requireDb();
  const recentMaintenance = await db
    .select({
      ...getTableColumns(assetMaintenance),
      assetName: fixedAssets.name,
      assetCode: fixedAssets.code,
    })
    .from(assetMaintenance)
    .innerJoin(fixedAssets, eq(assetMaintenance.assetId, fixedAssets.id))
    .where(and(ne(assetMaintenance.financialStatus, "CORRECTED"), ...(scope.branchId == null ? [] : [eq(fixedAssets.branchId, scope.branchId)])))
    .orderBy(desc(assetMaintenance.maintDate))
    .limit(6);

  // تحتاج إجراءً: قيد الصيانة، أو انتهت كفالتها، أو لا عهدة.
  const today = toDateStr();
  const needsAction = live
    .filter((a) => a.status === "maintenance" || (a.warrantyEnd && String(a.warrantyEnd) < today && a.status === "active") || !a.custodianId)
    .slice(0, 8)
    .map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      reason:
        a.status === "maintenance"
          ? "قيد الصيانة"
          : !a.custodianId
            ? "بلا عهدة مُسندة"
            : "انتهت الكفالة",
    }));

  return {
    kpis: { totalAssets, purchaseValue, bookValue, accumulated, inMaintenance, inCustody },
    byCategory: Array.from(byCategory.entries()).map(([category, v]) => ({ category, ...v })).sort((a, b) => b.value - a.value),
    byBranch: Array.from(byBranch.entries()).map(([branch, v]) => ({ branch, ...v })).sort((a, b) => b.value - a.value),
    recentMaintenance,
    needsAction,
    correctedAcquisitions,
  };
}

/* ----------------------------------------------------------- تقارير */
/** تقرير العهد مجمّعاً حسب الموظف (للأصول بالخدمة/الصيانة فقط). */
export async function custodyReport(scope: CompanyBranchScope) {
  const live = (await listAssets(undefined, scope)).filter((a) => a.status === "active" || a.status === "maintenance");
  const byEmp = new Map<number, { employeeId: number; employeeName: string | null; count: number; value: number; items: typeof live }>();
  const unassigned: typeof live = [];
  for (const a of live) {
    if (!a.custodianId) {
      unassigned.push(a);
      continue;
    }
    const e = byEmp.get(a.custodianId) ?? { employeeId: a.custodianId, employeeName: a.custodianName, count: 0, value: 0, items: [] };
    e.count += 1;
    e.value += a.bookValue;
    e.items.push(a);
    byEmp.set(a.custodianId, e);
  }
  return {
    byEmployee: Array.from(byEmp.values()).sort((a, b) => b.value - a.value),
    unassigned,
  };
}

/** سجلّ الاستبعاد/الإخراج مع نتيجة (ربح/خسارة) كل عملية. */
export async function disposalLog(scope: CompanyBranchScope) {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(fixedAssets), branchName: branches.name })
    .from(fixedAssets)
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .where(
      scope.branchId == null
        ? and(inArray(fixedAssets.status, ["disposed", "retired"]), ne(fixedAssets.recognitionStatus, "CORRECTED"))
        : and(
            inArray(fixedAssets.status, ["disposed", "retired"]),
            ne(fixedAssets.recognitionStatus, "CORRECTED"),
            eq(fixedAssets.branchId, scope.branchId),
          ),
    )
    .orderBy(desc(fixedAssets.disposalDate));
  return rows.map((a) => {
    const dep = computeDepreciation(a);
    const proceeds = a.status === "disposed" ? Number(a.disposalValue ?? 0) : null;
    return {
      ...a,
      ...dep,
      proceeds,
      gain: proceeds !== null ? new Decimal(a.disposalValue ?? "0").minus(new Decimal(dep.bookValue)).toDecimalPlaces(2).toString() : null,
    };
  });
}

export interface AssetRegisterFilters {
  category?: string;
  branchId?: number;
  status?: string;
}

/**
 * تقرير سجل الأصول الثابتة الموحد (Fixed Assets Register) وفق معيار IAS 16.
 * يفصل التكلفة التاريخية عن الإهلاك الافتتاحي وإهلاك النظام وصافي القيمة الدفترية.
 */
export async function fixedAssetRegisterReport(
  filters: AssetRegisterFilters | undefined,
  scope: CompanyBranchScope,
) {
  const assets = await listAssets({ ...filters, includeDisposed: true }, scope);
  const activeAssets = assets.filter((a) => a.recognitionStatus !== "CORRECTED");

  let sumCost = new Decimal(0);
  let sumOpeningDep = new Decimal(0);
  let sumSystemDep = new Decimal(0);
  let sumTotalAccum = new Decimal(0);
  let sumNbv = new Decimal(0);

  const rows = activeAssets.map((a) => {
    const cost = money(a.purchaseValue);
    const openingDep = money(a.openingDepreciation ?? "0");
    const totalAccum = money(a.accumulatedDepreciation ?? "0");
    const systemDep = Decimal.max(0, totalAccum.sub(openingDep));
    const nbv = Decimal.max(0, cost.sub(totalAccum));

    sumCost = sumCost.plus(cost);
    sumOpeningDep = sumOpeningDep.plus(openingDep);
    sumSystemDep = sumSystemDep.plus(systemDep);
    sumTotalAccum = sumTotalAccum.plus(totalAccum);
    sumNbv = sumNbv.plus(nbv);

    return {
      id: a.id,
      code: a.code,
      name: a.name,
      category: a.category,
      branchId: a.branchId,
      branchName: a.branchName ?? "بلا فرع",
      location: a.location,
      custodianId: a.custodianId,
      custodianName: a.custodianName,
      purchaseDate: String(a.purchaseDate),
      usefulLifeYears: a.usefulLifeYears,
      depreciationMethod: a.depreciationMethod,
      status: a.status,
      cost: toDbMoney(cost),
      salvageValue: toDbMoney(money(a.salvageValue ?? "0")),
      openingDepreciation: toDbMoney(openingDep),
      systemDepreciation: toDbMoney(systemDep),
      accumulatedDepreciation: toDbMoney(totalAccum),
      netBookValue: toDbMoney(nbv),
    };
  });

  return {
    kpis: {
      totalCount: rows.length,
      totalCost: toDbMoney(sumCost),
      totalOpeningDepreciation: toDbMoney(sumOpeningDep),
      totalSystemDepreciation: toDbMoney(sumSystemDep),
      totalAccumulatedDepreciation: toDbMoney(sumTotalAccum),
      totalNetBookValue: toDbMoney(sumNbv),
    },
    rows,
  };
}
