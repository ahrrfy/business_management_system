// حسابات نقية قابلة للاختبار وحدها: تفريق الهدر الطبيعي/غير الطبيعي + تكلفة تشغيل بوصفة.
import Decimal from "decimal.js";
import { round2 } from "../money";

/**
 * تفريق الهدر الطبيعي/غير الطبيعي على كلفة تشغيل كلية — **نقي وقابل للاختبار وحده**.
 * - هدر طبيعي (ضمن المعيار wasteStdPct) ⇒ يُمتَص في كلفة الوحدة السليمة (كلفة منتج، أصل↔أصل).
 * - هدر غير طبيعي (يتجاوز المعيار) ⇒ خسارة منفصلة (قيد WASTAGE) لا تضخّم كلفة السليم.
 * حفظ القيمة: absorbedCost + abnormalLoss = totalCost دائماً.
 */
export function spoilageSplit(totalCost: Decimal, started: number, scrapN: number, wasteStdPct: Decimal) {
  const normalAllow = Math.floor(Math.max(0, wasteStdPct.toNumber()) * started);
  const abnormalUnits = Math.max(0, scrapN - normalAllow);
  const good = started - scrapN;
  const abnormalLoss = started > 0 ? round2(totalCost.div(started).times(abnormalUnits)) : new Decimal(0);
  const absorbedCost = round2(totalCost.minus(abnormalLoss)); // يُحمَّل على الوحدات السليمة
  const unitCost = good > 0 ? round2(absorbedCost.div(good)) : new Decimal(0);
  return { normalAllow, abnormalUnits, good, abnormalLoss, absorbedCost, unitCost };
}

/**
 * الحساب الكامل لتشغيل بوصفة (نقي) — يطابق `computeProductionRun` في المواصفة.
 * **مُدخَل واحد يقود الاستهلاك = الدفعة (started)**؛ الوحدة التالفة استهلكت موادها أيضاً ⇒ لا تضاعف.
 * materialsCost يطابق حرفياً ما يحسبه createProduction (round2 لكل سطر) ⇒ المعاينة = الترحيل.
 */
export function computeRunCosts(args: {
  recipeLines: Array<{ unitCost: Decimal; qtyPerOutputBase: Decimal }>;
  laborPerUnit: Decimal;
  wasteStdPct: Decimal;
  batch: number;
  scrap: number;
}) {
  const started = Math.max(0, Math.trunc(args.batch));
  const scrapN = Math.min(Math.max(0, Math.trunc(args.scrap)), started); // التالف لا يتجاوز الدفعة
  const good = started - scrapN;
  const materialsCost = round2(
    args.recipeLines.reduce(
      (s, l) => s.plus(round2(l.unitCost.times(l.qtyPerOutputBase).times(started))),
      new Decimal(0)
    )
  );
  const labor = round2(args.laborPerUnit.times(started));
  const totalCost = round2(materialsCost.plus(labor));
  const sp = spoilageSplit(totalCost, started, scrapN, args.wasteStdPct); // sp.good = started − scrapN
  const yieldPct = started > 0 ? good / started : 0;
  return { started, scrapN, materialsCost, labor, totalCost, yieldPct, ...sp };
}
