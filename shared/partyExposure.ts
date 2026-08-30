/**
 * partyExposure — احتساب المسؤوليّة الماليّة لجهة توصيل (Slice DFP1، ٣٠/٨/٢٦).
 *
 * قرار المالك (٣٠/٨/٢٦): «قائمة المناديب تعرض ٤ أعمدة منفصلة» بدل عمود «بذمّتها» الملتبس.
 *
 * ⚠️ الأعمدة الأربعة **دلالياً منفصلة** — الخلط بينها كذّبت اللوحة على المالك ٣ أسابيع:
 *
 *   ١) نقد بيده              (cashInHand)          — نقدٌ قبضه المندوب لم يُورَّد بعد
 *   ٢) طرود بالطريق         (parcelsInTransit)     — بضاعة سُلِّمت للمندوب لم تصل الزبون
 *   ٣) سُلِّم لم يُحصَّل      (deliveredUncollected) — العميل استلم لم يدفع (تسليم جزئيّ/مؤجَّل)
 *   ٤) أجور مستحقّة له      (feesOwedToThem)       — نحن مدينون له بأجور توصيل
 *
 * صافي المسؤوليّة (net) = 1 + 2 + 3 − 4 (كم هو مدينٌ لنا صافيةً).
 *
 * هذه دالّة نقيّة (pure) — تأخذ مصفوفة قيود دفتر التوصيل + معطيات الطرود وتُنتج الأربعة.
 * لا استعلام DB. لا side effects. الغرض: قابلة للاختبار البسيط، ومستهلَكة سيرفر وعميل.
 */

export type PartyExposureLedgerEntry = {
  entryType:
    | "COD_ASSIGNED"
    | "COD_COLLECTED"
    | "COD_REMITTED"
    | "COD_RELEASED"
    | "COD_WRITTEN_OFF"
    | "SHORTFALL_ASSIGNED"
    | "FEE_EARNED"
    | "FEE_PAID"
    | "FEE_REFUNDED"
    | "FEE_OFFSET"
    | string; // نتساهل مع أنواعٍ لا نُقلّبها هنا
  amount: string | number;
};

export type PartyExposureParcelSnapshot = {
  parcelStatus: "ASSIGNED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED" | "RETURNED" | "CANCELLED" | string;
  moneyStatus: "UNSETTLED" | "PARTIAL" | "SETTLED" | "NOT_APPLICABLE" | string;
  codAmount: string | number;
  collectedAmount: string | number;
  counterSettledAmount?: string | number | null;
};

export type PartyExposureBreakdown = {
  /** ١) نقد بيده — من `deliveryParties.currentBalance` مباشرةً (مصدر الحقيقة القائم). */
  cashInHand: string;
  /** ٢) طرود بالطريق — Σ(codAmount) للطرود ASSIGNED/OUT_FOR_DELIVERY. */
  parcelsInTransit: string;
  /** ٣) سُلِّم لم يُحصَّل — Σ(codAmount − collectedAmount − counterSettledAmount) للطرود DELIVERED غير المسدَّدة. */
  deliveredUncollected: string;
  /** ٤) أجور مستحقّة للمندوب — Σ(FEE_EARNED − FEE_REFUNDED − FEE_PAID − FEE_OFFSET) مقصوصةً عند صفر. */
  feesOwedToThem: string;
  /** صافي المسؤوليّة على المندوب = 1 + 2 + 3 − 4 (موجب = مدينٌ لنا). */
  netResponsibility: string;
};

const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const fmt = (n: number): string => n.toFixed(2);

/**
 * ملحوظة معماريّة: لا نقرأ من DB هنا — المستدعي في server/queries.ts يجمع البيانات
 * (currentBalance من العمود، مصفوفة parcels من deliveryConsignments، مصفوفة ledger من
 * deliveryLedgerEntries) ويستدعي هذه الدالّة. الأخير في العميل يستقبل الأعداد المحسوبة
 * جاهزة كسلاسل decimal(2). فوائد النقاء: اختبارٌ بحت، ومستهلكٌ في العميل بلا استعلامٍ ثانٍ.
 */
export function computePartyExposure(input: {
  cashInHand: string | number;
  parcels: PartyExposureParcelSnapshot[];
  ledger: PartyExposureLedgerEntry[];
}): PartyExposureBreakdown {
  const cashInHand = toNum(input.cashInHand);

  // ٢) طرود بالطريق: قيمة الـcod الإجماليّة (البضاعة/النقد المتوقّع كلاهما بيد المندوب).
  let parcelsInTransit = 0;
  // ٣) سُلِّم لم يُحصَّل: المتبقّي على الطرود المُسلَّمة غير المسدَّدة كاملاً.
  let deliveredUncollected = 0;
  for (const p of input.parcels) {
    const cod = toNum(p.codAmount);
    const collected = toNum(p.collectedAmount);
    const counter = toNum(p.counterSettledAmount ?? 0);
    if (p.parcelStatus === "ASSIGNED" || p.parcelStatus === "OUT_FOR_DELIVERY") {
      parcelsInTransit += cod;
    } else if (
      p.parcelStatus === "DELIVERED" &&
      (p.moneyStatus === "UNSETTLED" || p.moneyStatus === "PARTIAL")
    ) {
      const remaining = cod - collected - counter;
      if (remaining > 0) deliveredUncollected += remaining;
    }
  }

  // ٤) أجور مستحقّة للمندوب — يُخصَم منها المدفوع/المُسوَّى، مقصوصةً عند صفر لكل جهة (ليس لكل طرد،
  // فالمقصّ هنا على المجموع لأنّ الجهة الواحدة قد يُوازِن دَينٌ منها فائضاً على طرد آخر — دلالياً
  // «إجمالي أجورها الصافية»؛ الطرود السالبة تعني تصحيحاً محاسبياً مقبولاً في المجموع).
  let feesOwedRaw = 0;
  for (const e of input.ledger) {
    const amt = toNum(e.amount);
    if (e.entryType === "FEE_EARNED") feesOwedRaw += amt;
    else if (e.entryType === "FEE_REFUNDED") feesOwedRaw -= amt;
    else if (e.entryType === "FEE_PAID" || e.entryType === "FEE_OFFSET") feesOwedRaw -= amt;
  }
  const feesOwedToThem = Math.max(0, feesOwedRaw);

  const netResponsibility =
    cashInHand + parcelsInTransit + deliveredUncollected - feesOwedToThem;

  return {
    cashInHand: fmt(cashInHand),
    parcelsInTransit: fmt(parcelsInTransit),
    deliveredUncollected: fmt(deliveredUncollected),
    feesOwedToThem: fmt(feesOwedToThem),
    netResponsibility: fmt(netResponsibility),
  };
}

/**
 * تسميات عربية للعرض في الواجهة — مصدر الحقيقة الوحيد. أيّ شاشة تُعرِّف نصّاً محلّياً
 * تكسر اتّساق تسمية الأعمدة عبر الشاشات (نفس بلاء 7 قواميس invoiceStatus).
 */
export const PARTY_EXPOSURE_LABEL_AR = Object.freeze({
  cashInHand:           "نقد بيده",
  parcelsInTransit:     "طرود بالطريق",
  deliveredUncollected: "سُلِّم لم يُحصَّل",
  feesOwedToThem:       "أجور مستحقّة له",
  netResponsibility:    "صافي المسؤوليّة",
} as const);

/** توكينات لونيّة موصى بها لكل عمود (المستهلك يترجم إلى `var(--sem-*)`). */
export const PARTY_EXPOSURE_COLOR_TOKEN = Object.freeze({
  cashInHand:           "neutral",  // نقدٌ عاديّ يُنتَظر تسويته
  parcelsInTransit:     "warning",  // بضاعة في السوق — تحذير
  deliveredUncollected: "danger",   // سُلِّم بلا قبض — خطر أعلى
  feesOwedToThem:       "positive", // نحن ندين له — إشارة إيجابيّة من منظوره
  netResponsibility:    "primary",  // الرقم الحاسم — إبراز رئيسيّ
} as const);
