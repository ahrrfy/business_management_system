import Decimal from "decimal.js";

/**
 * عقود لقطة الميزان المالي (قبل · دائن/مدين · بعد) + فحص شذوذ سعر الصرف وتكلفة الشراء.
 * مصدر الحقيقة الوحيد للعميل والخادم.
 */

export type LedgerPartyKind = "SUPPLIER" | "CUSTOMER";

export type BalanceTrailSnapshot = {
  partyType: LedgerPartyKind;
  before: string;
  delta: string;
  debit: string;
  credit: string;
  after: string;
  beforeAbs: string;
  afterAbs: string;
  beforeDirectionLabel: string;
  afterDirectionLabel: string;
  deltaEffectLabel: string;
};

function d2(v: string | number | Decimal | null | undefined): Decimal {
  if (v == null || v === "") return new Decimal(0);
  try {
    const n = new Decimal(v);
    return n.isFinite() ? n : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * اتجاه الذمة بلغة واضحة خالية من التشكيل:
 *  - للمورد (`SUPPLIER`): الموجب = «له علينا»، السالب = «لنا عليه»
 *  - للعميل (`CUSTOMER`): الموجب = «لنا عليه»، السالب = «له علينا»
 */
export function balanceDirectionLabel(
  partyType: LedgerPartyKind,
  amount: string | number | Decimal | null | undefined,
): string {
  const val = d2(amount);
  if (val.isZero()) return "متوازن";
  if (partyType === "SUPPLIER") {
    return val.isPositive() ? "له علينا" : "لنا عليه";
  }
  return val.isPositive() ? "لنا عليه" : "له علينا";
}

export function buildBalanceTrailSnapshot(input: {
  partyType: LedgerPartyKind;
  before: string | number | Decimal | null | undefined;
  /** الموجب يرفع رصيد الصافي على مقياس الطرف، والسالب يخفضه؛ أو مرر debit/credit صراحةً. */
  debit?: string | number | Decimal | null | undefined;
  credit?: string | number | Decimal | null | undefined;
}): BalanceTrailSnapshot {
  const before = d2(input.before).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const debit = d2(input.debit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const credit = d2(input.credit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  // القاعدة المحاسبية:
  // للمورد (ذمم دائنة): الدائن (+) يرفع الرصيد، والمدين (-) يخفضه
  // للعميل (ذمم مدينة): المدين (+) يرفع الرصيد، والدائن (-) يخفضه
  const netDelta =
    input.partyType === "SUPPLIER" ? credit.minus(debit) : debit.minus(credit);
  const after = before.plus(netDelta).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const deltaEffectLabel = credit.gt(0) && debit.isZero()
    ? "دائن"
    : debit.gt(0) && credit.isZero()
      ? "مدين"
      : "صافي";

  return {
    partyType: input.partyType,
    before: before.toFixed(2),
    delta: netDelta.toFixed(2),
    debit: debit.toFixed(2),
    credit: credit.toFixed(2),
    after: after.toFixed(2),
    beforeAbs: before.abs().toFixed(2),
    afterAbs: after.abs().toFixed(2),
    beforeDirectionLabel: balanceDirectionLabel(input.partyType, before),
    afterDirectionLabel: balanceDirectionLabel(input.partyType, after),
    deltaEffectLabel,
  };
}

export const SUPPLIER_RECEIPT_PURPOSES = [
  "ADVANCE_REFUND",
  "CREDIT_OBLIGATION",
] as const;

export type SupplierReceiptPurpose = (typeof SUPPLIER_RECEIPT_PURPOSES)[number];

export const SUPPLIER_RECEIPT_PURPOSE_LABELS: Record<
  SupplierReceiptPurpose,
  string
> = {
  ADVANCE_REFUND: "استرداد دفعة سابقة",
  CREDIT_OBLIGATION: "مبلغ مستلم / إشعار دائن يرفع حساب المورد",
};

export const USD_RATE_SANITY = {
  /** أدنى سعر صرف طبيعي في السوق العراقي بالدينار لكل دولار */
  MIN_NORMAL_IQD: 1000,
  /** أعلى سعر صرف طبيعي في السوق العراقي بالدينار لكل دولار */
  MAX_NORMAL_IQD: 2500,
  /** حد الانحراف النسبي مقارنة بالسعر المرجعي للشركة قبل اعتباره شاذاً */
  MAX_DEVIATION_RATIO: 0.25,
} as const;

export type UsdRateSanityResult = {
  status: "OK" | "WARN" | "ANOMALOUS";
  suggestedRate: string | null;
  referenceRate: string | null;
  message: string | null;
};

/**
 * فحص منطقي لسعر صرف الدولار (يكشف أخطاء مثل 169 بدل 1,690 قبل الترحيل).
 */
export function assessUsdRateSanity(
  rateRaw: string | number | Decimal | null | undefined,
  referenceRateRaw?: string | number | Decimal | null | undefined,
): UsdRateSanityResult {
  const rate = d2(rateRaw);
  if (!rate.gt(0)) {
    return {
      status: "ANOMALOUS",
      suggestedRate: null,
      referenceRate: null,
      message: "سعر الصرف يجب أن يكون أكبر من صفر",
    };
  }
  const ref =
    referenceRateRaw != null && d2(referenceRateRaw).gt(0)
      ? d2(referenceRateRaw)
      : null;

  const anchor = ref ?? new Decimal(1500);
  const ratio = rate.minus(anchor).abs().div(anchor);

  // اكتشاف سقوط خانة صفرية مثل 169 بدلاً من 1690
  const scaled10 = rate.times(10);
  const looksLikeMissingZero =
    scaled10.gte(USD_RATE_SANITY.MIN_NORMAL_IQD) &&
    scaled10.lte(USD_RATE_SANITY.MAX_NORMAL_IQD) &&
    rate.lt(USD_RATE_SANITY.MIN_NORMAL_IQD);
  const suggestedRate = looksLikeMissingZero
    ? scaled10.toFixed(0)
    : ref
      ? ref.toFixed(0)
      : null;

  const fmtRate = rate.toDecimalPlaces(2).toString();
  const suggestPart = suggestedRate ? ` — هل تقصد ${suggestedRate}؟` : "";

  if (
    rate.lt(USD_RATE_SANITY.MIN_NORMAL_IQD) ||
    rate.gt(USD_RATE_SANITY.MAX_NORMAL_IQD)
  ) {
    return {
      status: "ANOMALOUS",
      suggestedRate,
      referenceRate: ref ? ref.toFixed(2) : null,
      message: `سعر الصرف ${fmtRate} د.ع/$ خارج النطاق المعتاد (${USD_RATE_SANITY.MIN_NORMAL_IQD}–${USD_RATE_SANITY.MAX_NORMAL_IQD})${suggestPart}`,
    };
  }

  if (ref && ratio.gt(USD_RATE_SANITY.MAX_DEVIATION_RATIO)) {
    return {
      status: "WARN",
      suggestedRate: ref.toFixed(0),
      referenceRate: ref.toFixed(2),
      message: `سعر الصرف ${fmtRate} د.ع/$ يبتعد بأكثر من 25% عن آخر سعر معتمد (${ref.toFixed(0)})`,
    };
  }

  return {
    status: "OK",
    suggestedRate: null,
    referenceRate: ref ? ref.toFixed(2) : null,
    message: null,
  };
}

export type UnitCostAnomalyResult = {
  isAnomalous: boolean;
  kind: "SHARP_DROP" | "SHARP_SPIKE" | "OK";
  ratio: string | null;
  message: string | null;
};

/**
 * كشف انحراف كلفة الوحدة الدينارية مقارنة بالتكلفة الحالية المسجلة في المخزون.
 */
export function assessUnitCostAnomaly(
  newUnitCostRaw: string | number | Decimal | null | undefined,
  currentCostRaw: string | number | Decimal | null | undefined,
  itemLabel?: string | null,
): UnitCostAnomalyResult {
  const newCost = d2(newUnitCostRaw);
  const currentCost = d2(currentCostRaw);
  if (!newCost.gt(0) || !currentCost.gt(0)) {
    return { isAnomalous: false, kind: "OK", ratio: null, message: null };
  }
  const ratio = newCost.div(currentCost);
  const name = itemLabel ? `«${itemLabel}»` : "الصنف";
  if (ratio.lt(0.5)) {
    return {
      isAnomalous: true,
      kind: "SHARP_DROP",
      ratio: ratio.toFixed(2),
      message: `تكلفة ${name} الجديدة (${newCost.toFixed(0)} د.ع) أقل من نصف الكلفة الحالية (${currentCost.toFixed(0)} د.ع) — راجع السعر وسعر الصرف`,
    };
  }
  if (ratio.gt(2)) {
    return {
      isAnomalous: true,
      kind: "SHARP_SPIKE",
      ratio: ratio.toFixed(2),
      message: `تكلفة ${name} الجديدة (${newCost.toFixed(0)} د.ع) تتجاوز ضعف الكلفة الحالية (${currentCost.toFixed(0)} د.ع)`,
    };
  }
  return { isAnomalous: false, kind: "OK", ratio: ratio.toFixed(2), message: null };
}

export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  SALE: "فاتورة بيع",
  PURCHASE: "فاتورة شراء",
  PAYMENT_IN: "سند قبض",
  RECEIPT: "سند قبض",
  PAYMENT_OUT: "سند صرف",
  PAYMENT: "سند صرف",
  RETURN: "مرتجع بيع",
  PURCHASE_RETURN: "مرتجع شراء",
  OPENING: "رصيد افتتاحي",
  MANUAL_JOURNAL: "قيد يدوي",
  ADJUSTMENT: "تسوية",
  FULFILLMENT_CHARGE: "أجور تنفيذ",
  FULFILLMENT_CHARGE_COST: "تكلفة تنفيذ",
  FULFILLMENT_CHARGE_CREDIT: "رصيد تنفيذ",
  FULFILLMENT_CHARGE_ACCRUAL: "استحقاق تنفيذ",
  GRNI: "استلام بضاعة",
  COD: "دفع عند الاستلام",
  CASH: "نقدي — دفع فوري",
  CREDIT: "آجل — ذمة",
  ADVANCE_REFUND: "استرداد دفعة",
};

export function movementKindLabel(kind: string | null | undefined): string {
  if (!kind) return "حركة";
  return MOVEMENT_KIND_LABELS[kind] ?? "حركة مالية";
}

