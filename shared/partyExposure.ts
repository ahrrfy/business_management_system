/**
 * partyExposure — احتساب المسؤوليّة الماليّة لجهة توصيل (Slice DFP1، ٣٠/٨/٢٦).
 *
 * قرار المالك (٣٠/٨/٢٦): «قائمة المناديب تعرض ٤ أعمدة منفصلة» بدل عمود «بذمّتها» الملتبس.
 *
 * ⚠️ الأعمدة الأربعة **دلالياً منفصلة** — الخلط بينها كذّبت اللوحة على المالك ٣ أسابيع:
 *
 *   ١) نقد بيده              (cashInHand)          — نقدٌ **ماديّ** قبضه المندوب لم يُورَّد بعد
 *   ٢) طرود بالطريق         (parcelsInTransit)     — بضاعة سُلِّمت للمندوب لم تصل الزبون
 *   ٣) سُلِّم لم يُحصَّل      (deliveredUncollected) — العميل استلم لم يدفع (تسليم جزئيّ/مؤجَّل)
 *   ٤) أجور مستحقّة له      (feesOwedToThem)       — نحن مدينون له بأجور توصيل
 *   ٥) عجزٌ محمَّل عليه      (shortfallOwed)        — ذمّةٌ **غير نقديّة** على الجهة (نقدٌ لم يُحصَّل حُمِّل عليها)
 *
 * صافي المسؤوليّة (net) = 1 + 2 + 3 + 5 − 4 (كم هو مدينٌ لنا صافيةً).
 *
 * ⚠️ Codex #1012 P2 — **العجز ذمّةٌ لا نقدٌ ماديّ**: `SHORTFALL_ASSIGNED` يرفع عهدة الجهة
 * (`currentBalance` والدفتر معاً) تماماً كالنقد، لكنّه دَينٌ لم تقبضه قطّ. فُصِل عن العمود ١
 * («نقد بيده») إلى عمودٍ خامسٍ مستقلّ كي لا تُبنى قراراتُ الدرج على دَينٍ يظهر نقداً ماديّاً؛
 * والعهدةُ الكلّية (نقد + عجز) تبقى مصدرَ الحقيقة الذي يطابقه المخزَّن (`reconcileService`).
 *
 * هذه دالّة نقيّة (pure) — تأخذ مصفوفة قيود دفتر التوصيل + معطيات الطرود وتُنتج الأربعة.
 * لا استعلام DB. لا side effects. الغرض: قابلة للاختبار البسيط، ومستهلَكة سيرفر وعميل.
 *
 * م١ (PR-2/3، ٥/٩/٢٦): الخادم **يستدعي هذه الدالّة فعلاً** (`delivery/board.ts` و`parties.ts` و
 * `queries.ts`) بدل إعادة كتابة صيغها SQL — كانت ثلاثُ نسخٍ متوازية. والعمود ١ صار له مصدران
 * يُعرَضان معاً في الطرح الظلّيّ: المخزَّن (`currentBalance`) والمشتقّ من الدفتر
 * (`deriveCashInHandFromLedger`)، ومن يُقدَّم منهما في `net` يقرّره علَم `courierLedgerDerived`.
 * إشاراتُ الأجور تُقرأ من `DELIVERY_LEDGER_ENTRY_SIGN` (ثابتٌ واحد مع قاموس الدفتر) — انظر
 * `deliveryFeeLiabilityDelta` وقرارَ المالك المعلَّق على `FEE_REFUNDED` هناك.
 */

import {
  DELIVERY_CASH_CUSTODY_SIGN,
  DELIVERY_FEE_ENTRY_TYPES,
  deliveryFeeLiabilityDelta,
  type DeliveryFeeEntryType,
} from "./deliveryLedgerEntryType";

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

/**
 * حالاتُ الطرد التي **بيد الجهة في السوق** (عمود «طرود بالطريق»): من الإسناد حتى إثبات الوصول.
 * ⚠️ Codex #1012 P2 — لزم أن تشمل `ACCEPTED`/`PICKED_UP`: لوحةُ الجهات (`board.ts`) تعدّها ضمن
 * الدلو «المُسنَد» بينما كان هذا المسند يقصر على `ASSIGNED`/`OUT_FOR_DELIVERY` وحدهما ⇒ طردٌ
 * قَبِله المندوب أو استلمه (عالي القيمة) يظهر في الدلو ويسقط من `net` — تبخيسٌ لمسؤوليّته.
 */
export const PARCEL_IN_TRANSIT_STATUSES = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;

export type PartyExposureParcelSnapshot = {
  parcelStatus: "ASSIGNED" | "ACCEPTED" | "PICKED_UP" | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED" | "RETURNED" | "CANCELLED" | string;
  moneyStatus: "UNSETTLED" | "PARTIAL" | "SETTLED" | "NOT_APPLICABLE" | string;
  codAmount: string | number;
  collectedAmount: string | number;
  counterSettledAmount?: string | number | null;
  /**
   * م١ (PR-2) — **ما تحمله الجهة من نقد هذا الطرد بحسب الدفتر** (Σ `DELIVERY_CASH_CUSTODY_SIGN`
   * لقيود الطرد: قُبض + عجزٌ مُحمَّل − وُرِّد − شُطب). لماذا لزم: `collectedAmount` عمودُ
   * **تخصيص التوريد** لا القبض — ختمُ التسليم من البوّابة يكتب `COD_COLLECTED` ويرفع العهدة
   * ولا يمسّه. فطردٌ سُلِّم وقُبض نقدُه ولم يُورَّد كان يُحسَب **مرّتين**: نقداً بيد الجهة
   * (العمود ١) **و**«سُلِّم لم يُحصَّل» (العمود ٣) بكامل قيمته — وصافي المسؤوليّة ضعفَ الحقيقة.
   * `null`/غياب = صفر (الصفوف القديمة بلا قيود قبض تبقى كما كانت: المتبقّي كلُّه غير محصَّل).
   */
  ledgerCustody?: string | number | null;
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
  /**
   * ٥) عجزٌ محمَّل على الجهة — Σ SHORTFALL_ASSIGNED (ذمّةٌ غير نقديّة، Codex #1012 P2). يُفصَل عن
   * «نقد بيده» فلا يُعرَض دَينٌ نقداً ماديّاً؛ ويبقى داخل `net` (الجهة مدينةٌ لنا به فعلاً).
   */
  shortfallOwed: string;
  /** صافي المسؤوليّة على المندوب = 1 + 2 + 3 + 5 − 4 (موجب = مدينٌ لنا). */
  netResponsibility: string;
};

const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const fmt = (n: number): string => n.toFixed(2);

/**
 * م١ (PR-2/3) — **النقد بيد الجهة مشتقّاً من الدفتر الإلحاقيّ** (مصدر الحقيقة المستهدَف):
 *   Σ COD_COLLECTED + Σ SHORTFALL_ASSIGNED − Σ COD_REMITTED − Σ COD_WRITTEN_OFF
 * الأنواعُ والإشارات من `DELIVERY_CASH_CUSTODY_SIGN` (ثابتٌ واحد يقرؤه الخادم SQL أيضاً).
 * الدالّة خطّيّة في المبالغ ⇒ تمريرُ مجاميعَ مُجمَّعةٍ لكلّ نوعٍ يُنتج نفس الناتج تماماً.
 */
export function deriveCashInHandFromLedger(ledger: PartyExposureLedgerEntry[]): string {
  let cash = 0;
  for (const e of ledger) {
    const sign = (DELIVERY_CASH_CUSTODY_SIGN as Record<string, 1 | -1 | undefined>)[e.entryType];
    if (sign == null) continue;
    cash += sign * toNum(e.amount);
  }
  return fmt(cash);
}

/**
 * Codex #1012 P2 — **العجزُ المحمَّل على الجهة** (`SHORTFALL_ASSIGNED`) مجموعاً: ذمّةٌ غير نقديّة
 * تُطرح من «العهدة الكلّية» لِتُعرَض «نقد بيده» ماديّاً وحده، وتظهر عموداً خامساً مستقلّاً.
 * لا كاتبَ يُنقصها في الشيفرة اليوم (لا نوعَ «تسوية عجز») ⇒ المجموع = العجز القائم.
 */
export function deriveShortfallOwedFromLedger(ledger: PartyExposureLedgerEntry[]): string {
  let owed = 0;
  for (const e of ledger) {
    if (e.entryType === "SHORTFALL_ASSIGNED") owed += toNum(e.amount);
  }
  return fmt(owed);
}

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
    // Codex #1012 P2 — يشمل ACCEPTED/PICKED_UP (المسند الواحد `PARCEL_IN_TRANSIT_STATUSES`) كي لا
    // يسقط طردٌ قَبِله المندوب أو استلمه من `net` بينما لوحةُ الجهات تعدّه ضمن الدلو المُسنَد.
    if ((PARCEL_IN_TRANSIT_STATUSES as readonly string[]).includes(p.parcelStatus)) {
      parcelsInTransit += cod;
    } else if (
      p.parcelStatus === "DELIVERED" &&
      (p.moneyStatus === "UNSETTLED" || p.moneyStatus === "PARTIAL")
    ) {
      // ما لم يدفعه الزبون بعد = المتبقّي الحيّ − ما قبضته الجهة منه فعلاً (عهدةُ الطرد في الدفتر).
      const custody = toNum(p.ledgerCustody ?? 0);
      const remaining = cod - collected - counter - Math.max(0, custody);
      if (remaining > 0) deliveredUncollected += remaining;
    }
  }

  // ٤) أجور مستحقّة للمندوب — يُخصَم منها المدفوع/المُسوَّى، مقصوصةً عند صفر لكل جهة (ليس لكل طرد،
  // فالمقصّ هنا على المجموع لأنّ الجهة الواحدة قد يُوازِن دَينٌ منها فائضاً على طرد آخر — دلالياً
  // «إجمالي أجورها الصافية»؛ الطرود السالبة تعني تصحيحاً محاسبياً مقبولاً في المجموع).
  // الإشارةُ من الثابت الواحد `DELIVERY_LEDGER_ENTRY_SIGN` (عبر `deliveryFeeLiabilityDelta`) — لا
  // قائمةَ محلّية تنجرف عن قاموس الدفتر (كانت `FEE_REFUNDED` تُطرح هنا وتُرفع هناك).
  let feesOwedRaw = 0;
  for (const e of input.ledger) {
    if (!(DELIVERY_FEE_ENTRY_TYPES as readonly string[]).includes(e.entryType)) continue;
    feesOwedRaw += deliveryFeeLiabilityDelta(e.entryType as DeliveryFeeEntryType) * toNum(e.amount);
  }
  const feesOwedToThem = Math.max(0, feesOwedRaw);

  // ٥) العجزُ المحمَّل (ذمّةٌ غير نقديّة) — يُطرح من العهدة الكلّية المُمرَّرة (`cashInHand`) لِيُعرَض
  // العمود ١ نقداً ماديّاً وحده، ويظهر عموداً خامساً مستقلّاً. صافي المسؤوليّة **لا يتغيّر**:
  // physicalCash + shortfallOwed = cashInHand المُمرَّرة، فالمجموع كما كان (Codex #1012 P2).
  const shortfallOwed = toNum(deriveShortfallOwedFromLedger(input.ledger));
  const physicalCashInHand = cashInHand - shortfallOwed;

  const netResponsibility =
    physicalCashInHand + parcelsInTransit + deliveredUncollected + shortfallOwed - feesOwedToThem;

  return {
    cashInHand: fmt(physicalCashInHand),
    parcelsInTransit: fmt(parcelsInTransit),
    deliveredUncollected: fmt(deliveredUncollected),
    feesOwedToThem: fmt(feesOwedToThem),
    shortfallOwed: fmt(shortfallOwed),
    netResponsibility: fmt(netResponsibility),
  };
}

/**
 * تسميات عربية للعرض في الواجهة — مصدر الحقيقة الوحيد. أيّ شاشة تُعرِّف نصّاً محلّياً
 * تكسر اتّساق تسمية الأعمدة عبر الشاشات (نفس بلاء 7 قواميس invoiceStatus).
 *
 * Slice DFP2 (٣١/٨/٢٦): إزالة التشكيل — الفحص البصريّ أظهر أنّ خطّ الواجهة (Cairo/Tajawal)
 * يرسم «مُ + كلمة» + تشكيل كأنّه «ف + كلمة» في حجم < 14px، فيقرأ الكاشير المصطلحات خاطئةً
 * («سُلِّم» ⇒ «شلَم»، «المُحصَّل» ⇒ «الفَحصل»). النسخة الأدبيّة الكاملة بتشكيلٍ في `deliveryTerminology.prose`.
 */
export const PARTY_EXPOSURE_LABEL_AR = Object.freeze({
  cashInHand:           "نقد بيده",
  parcelsInTransit:     "طرود بالطريق",
  deliveredUncollected: "سلم لم يحصل",
  feesOwedToThem:       "أجور له",
  shortfallOwed:        "عجز عليه",
  netResponsibility:    "صافي المسؤولية",
} as const);

/** توكينات لونيّة موصى بها لكل عمود (المستهلك يترجم إلى `var(--sem-*)`). */
export const PARTY_EXPOSURE_COLOR_TOKEN = Object.freeze({
  cashInHand:           "neutral",  // نقدٌ عاديّ يُنتَظر تسويته
  parcelsInTransit:     "warning",  // بضاعة في السوق — تحذير
  deliveredUncollected: "danger",   // سُلِّم بلا قبض — خطر أعلى
  feesOwedToThem:       "positive", // نحن ندين له — إشارة إيجابيّة من منظوره
  shortfallOwed:        "danger",   // دَينُ عجزٍ عليه — خطر (لا يُخلَط بالنقد الماديّ)
  netResponsibility:    "primary",  // الرقم الحاسم — إبراز رئيسيّ
} as const);
