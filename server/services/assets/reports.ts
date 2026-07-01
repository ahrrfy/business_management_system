// لوحة المؤشّرات + تقرير العهد حسب الموظف + سجلّ الاستبعاد/الإخراج.
import Decimal from "decimal.js";
import { desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { assetMaintenance, branches, fixedAssets } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { sumMoney, toDateStr } from "../money";
import { computeDepreciation } from "./depreciation";
import { listAssets } from "./queries";

export async function dashboard() {
  const all = await listAssets({ includeDisposed: true });
  const live = all.filter((a) => a.status === "active" || a.status === "maintenance" || a.status === "retired");

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
    .leftJoin(fixedAssets, eq(assetMaintenance.assetId, fixedAssets.id))
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
  };
}

/* ----------------------------------------------------------- تقارير */
/** تقرير العهد مجمّعاً حسب الموظف (للأصول بالخدمة/الصيانة فقط). */
export async function custodyReport() {
  const live = (await listAssets()).filter((a) => a.status === "active" || a.status === "maintenance");
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
export async function disposalLog() {
  const db = requireDb();
  const rows = await db
    .select({ ...getTableColumns(fixedAssets), branchName: branches.name })
    .from(fixedAssets)
    .leftJoin(branches, eq(fixedAssets.branchId, branches.id))
    .where(inArray(fixedAssets.status, ["disposed", "retired"]))
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
