// حساب الإهلاك (قسط ثابت sl أو متناقص مضاعف db) — قيمة تحليلية تُحسب عند القراءة ولا تُخزَّن.
import Decimal from "decimal.js";
import { money } from "../money";

export interface DepRow {
  year: number;
  opening: number;
  dep: number;
  closing: number;
  isCurrent: boolean;
}

export interface DepResult {
  annualDep: number;
  accumulated: number;
  bookValue: number;
  depPct: number;
  ageYears: number;
  depRate: number;
  schedule: DepRow[];
}

function yearsBetween(d1: Date, d2: Date): number {
  return (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
}

/**
 * يحسب الإهلاك بطريقة القسط الثابت (sl) أو المتناقص المضاعف (db) حتى تاريخ asOf.
 * يتوقّف الحساب عند تاريخ الإخراج إن وُجد. الأصول المُستبعَدة تُعتبر مُهلَكة بالكامل.
 * قيمة تحليلية للعرض (تُقرَّب لأقرب دينار) — ليست عملية دفترية تمسّ رصيداً، فالحساب رقميّ.
 */
export function computeDepreciation(
  a: {
    purchaseValue: string | number;
    salvageValue: string | number;
    usefulLifeYears: number;
    depreciationMethod: "sl" | "db";
    purchaseDate: string | Date;
    status: string;
    disposalDate?: string | Date | null;
  },
  asOf: Date = new Date(),
): DepResult {
  // الحسابات بـDecimal (§٥): الأموال لا تُحسب بـJS Number. الإرجاع كأرقام صحيحة (دينار)
  // لأن العقد الخارجي مع الواجهة/الاختبارات يستعمل number — نخرج عبر toNumber() بعد التقريب.
  const cost = money(a.purchaseValue);
  const sal = a.salvageValue === "" || a.salvageValue == null ? new Decimal(0) : money(a.salvageValue);
  const life = a.usefulLifeYears || 1;
  const method = a.depreciationMethod || "sl";
  const depreciable = Decimal.max(0, cost.sub(sal));
  const annualSL = life > 0 ? depreciable.div(life).toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : new Decimal(0);
  const rate = life > 0 ? new Decimal(2).div(life) : new Decimal(0);
  const startYear = new Date(a.purchaseDate).getFullYear();
  const curYear = asOf.getFullYear();

  const scheduleD: { year: number; opening: Decimal; dep: Decimal; closing: Decimal; isCurrent: boolean }[] = [];
  let book = cost;
  for (let i = 0; i < life; i++) {
    let dep: Decimal;
    const headroom = Decimal.max(0, book.sub(sal));
    if (method === "db") {
      dep = Decimal.min(headroom, book.times(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
      if (i === life - 1) dep = headroom; // آخر سنة: أنزل للتخريدية
    } else {
      dep = Decimal.min(headroom, annualSL);
    }
    scheduleD.push({ year: startYear + i, opening: book, dep, closing: book.sub(dep), isCurrent: startYear + i === curYear });
    book = book.sub(dep);
  }

  // المتراكم حتى تاريخ الإخراج (للمُخرَج/المُستبعَد) أو حتى asOf — تناسبياً مع جزء السنة الجاري.
  // ملاحظة محاسبية: المُستبعَد لا يُجبَر على إهلاك كامل؛ يُحتسب بقيمته الدفترية الحقيقية عند تاريخ
  // الإخراج كي يصحّ ربح/خسارة الاستبعاد (proceeds − NBV). الأصل الذي تجاوز عمره يبلغ التخريدية طبيعياً.
  const stop = a.disposalDate ? new Date(a.disposalDate) : null;
  const age = Math.max(0, yearsBetween(new Date(a.purchaseDate), stop || asOf));

  let accumulatedD = new Decimal(0);
  const fy = Math.floor(age);
  const frac = new Decimal(age - fy);
  for (let i = 0; i < life; i++) {
    if (i < fy) accumulatedD = accumulatedD.plus(scheduleD[i].dep);
    else if (i === fy) {
      accumulatedD = accumulatedD.plus(scheduleD[i].dep.times(frac).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
      break;
    }
  }
  accumulatedD = Decimal.min(accumulatedD, depreciable);
  const bookValueD = Decimal.max(sal, cost.sub(accumulatedD));
  const curIdx = Math.min(life - 1, Math.floor(age));
  const annualDepD = method === "db" ? (scheduleD[curIdx]?.dep ?? annualSL) : annualSL;
  const depPctD = cost.gt(0)
    ? Decimal.min(100, accumulatedD.div(cost).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP))
    : new Decimal(0);
  const ageYearsD = new Decimal(age).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  const depRateD = method === "db" ? rate : cost.gt(0) ? annualSL.div(cost) : new Decimal(0);

  return {
    annualDep: annualDepD.toNumber(),
    accumulated: accumulatedD.toNumber(),
    bookValue: bookValueD.toNumber(),
    depPct: depPctD.toNumber(),
    ageYears: ageYearsD.toNumber(),
    depRate: depRateD.toNumber(),
    schedule: scheduleD.map((r) => ({
      year: r.year,
      opening: r.opening.toNumber(),
      dep: r.dep.toNumber(),
      closing: r.closing.toNumber(),
      isCurrent: r.isCurrent,
    })),
  };
}
