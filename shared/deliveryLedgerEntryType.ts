/**
 * deliveryLedgerEntryType — مفردات **دفتر التوصيل** (`deliveryLedgerEntries.entryType`):
 * تسميةُ كلّ قيدٍ وإشارتُه داخل عهدة الجهة.
 *
 * لماذا وُجد الملفّ (موجة D6، ٢/٩/٢٦): القاموسان كانا داخل مكوّنٍ واحد
 * (`client/src/components/delivery/ConsignmentTimelineDrawer.tsx`)، وانحرفا عن العمود فعلاً:
 * `SHORTFALL_ASSIGNED` (هجرة 0295، Slice DFP1) قيمةٌ حيّةٌ في التعداد **بلا تسمية ولا إشارة**
 * ⇒ عجزُ التحصيل المحمَّل على المندوب يظهر في خطّ الزمن رمزاً إنجليزياً خامّاً بإشارةٍ افتراضيّة.
 *
 * ⛔ لا شاشة تُعيد تعريف هذا القاموس محلّياً — يحرسه `localizationDictionaries.test.ts`، وفيه
 *    مطابقةٌ حرفيّة مع `deliveryLedgerEntries.entryType.enumValues` فينكسر أيُّ توسيعٍ للعمود
 *    بلا تسمية، بدل أن يظهر على شاشةٍ عربيّة.
 *
 * ⚠️ **هذا ليس قاموسَ أحداث الطرد.** أربعةٌ من مفاتيحه (`REMITTED`/`WRITTEN_OFF`/`RECOVERED`/
 *    `FEE_PAID` بصيغها المختصرة) كانت مُقحَمةً في قاموس `deliveryEvents.eventType` حيث لا
 *    يكتبها أحد — تشابُهُ المفاتيح لا يعني وحدةَ المفهوم. الجدولان مختلفان: هذا **مالٌ**،
 *    وذاك **سلسلةُ حيازة** (`deliveryEventType.ts`).
 *
 * ⛔ بلا تشكيل في التسميات (حارس `check:tashkeel`).
 */

export const DELIVERY_LEDGER_ENTRY_TYPES = [
  /** تعرُّضٌ نشأ بإسناد الطرد: قيمةُ COD صارت في عهدة الجهة. */
  "COD_ASSIGNED",
  /** الجهة قبضت نقداً من الزبون. */
  "COD_COLLECTED",
  /** الجهة ورّدت النقد إلى درج المكتبة. */
  "COD_REMITTED",
  /** تحرُّرُ تعرُّضٍ بلا نقد (رجوعٌ/إلغاءٌ/سدادٌ كاونتريّ). */
  "COD_RELEASED",
  /** شُطب عجزٌ باعتمادٍ ثانٍ — خسارةٌ على المكتبة لا ذمّةٌ على الجهة. */
  "COD_WRITTEN_OFF",
  /** استُرجع مبلغٌ سبق شطبُه. */
  "COD_RECOVERED",
  /**
   * Slice DFP1 (هجرة 0295): عجزُ التحصيل ذمّةٌ فوريّة على الجهة — يرفع عهدتها تماماً
   * كـ`COD_COLLECTED`، ويلزمه `shortfallReason` من `shared/shortfallReason.ts`.
   */
  "SHORTFALL_ASSIGNED",
  /** أجرةُ توصيلٍ اكتسبتها الجهة — نحن مدينون لها بها. */
  "FEE_EARNED",
  /** دُفعت الأجرة نقداً للجهة. */
  "FEE_PAID",
  /** سُوّيت الأجرة خصماً من نقدٍ بيدها بدل دفعها. */
  "FEE_OFFSET",
  /** رُدّت أجرةٌ سبق احتسابُها (تصحيحُ استحقاق). */
  "FEE_REFUNDED",
] as const;

export type DeliveryLedgerEntryType = (typeof DELIVERY_LEDGER_ENTRY_TYPES)[number];

/** التسمية العربيّة الرسميّة — تظهر في عمود «النوع» بجدول قيود الدفتر. */
export const DELIVERY_LEDGER_ENTRY_LABEL: Readonly<Record<DeliveryLedgerEntryType, string>> =
  Object.freeze({
    COD_ASSIGNED: "تعرض إسناد",
    COD_COLLECTED: "تحصيل نقد",
    COD_REMITTED: "توريد للمكتبة",
    COD_RELEASED: "تحرير تعرض",
    COD_WRITTEN_OFF: "شطب عجز",
    COD_RECOVERED: "استرداد مشطوب",
    SHORTFALL_ASSIGNED: "عجز محمل على الجهة",
    FEE_EARNED: "استحقاق أجرة",
    FEE_PAID: "دفع أجرة",
    FEE_OFFSET: "خصم أجرة",
    FEE_REFUNDED: "رد أجرة",
  });

/**
 * إشارةُ القيد داخل عهدة الجهة — `1` يرفع ما عليها، `-1` يخفضه. تقود لونَ المبلغ في السطر.
 *
 * ⚠️ **انحرافٌ مرصودٌ لم يُغيَّر هنا:** `computePartyExposure` في `shared/partyExposure.ts`
 * تطرح `FEE_REFUNDED` من الأجور المستحقّة للجهة (سطر `feesOwedRaw -= amt`)، فأثرُها على
 * صافي المسؤوليّة **موجب** بينما هذا الجدول يعطيها `-1`. أحدُهما خطأ، والحسمُ يحتاج قرارَ
 * مالكٍ لمعنى «ردّ الأجرة» (أهو ردٌّ منها إلينا أم إلغاءُ استحقاقٍ لها؟) — فتُنقل القيمةُ
 * هنا **كما كانت** حفاظاً على السلوك، ويُرفَع الانحرافُ لمالك منظومة التوصيل.
 * ⛔ لا تُوحَّد الإشارتان بالتخمين: عكسُها يقلب لونَ سطرٍ ماليّ في وجه الموظّف.
 */
export const DELIVERY_LEDGER_ENTRY_SIGN: Readonly<Record<DeliveryLedgerEntryType, 1 | -1>> =
  Object.freeze({
    COD_ASSIGNED: 1,
    COD_COLLECTED: 1,
    COD_REMITTED: -1,
    COD_RELEASED: -1,
    COD_WRITTEN_OFF: -1,
    COD_RECOVERED: 1,
    SHORTFALL_ASSIGNED: 1,
    FEE_EARNED: -1,
    FEE_PAID: 1,
    FEE_OFFSET: 1,
    FEE_REFUNDED: -1,
  });

export function isDeliveryLedgerEntryType(v: unknown): v is DeliveryLedgerEntryType {
  return typeof v === "string" && (DELIVERY_LEDGER_ENTRY_TYPES as readonly string[]).includes(v);
}

/** المجهول يُعرَض خامّاً — يقود المطوّر إلى الفجوة بدل إخفائها تحت «أخرى». */
export function deliveryLedgerEntryLabel(entryType: string | null | undefined): string {
  if (!entryType) return "—";
  return isDeliveryLedgerEntryType(entryType) ? DELIVERY_LEDGER_ENTRY_LABEL[entryType] : entryType;
}

/** إشارةُ المجهول `1` — مطابقةٌ عمداً للسلوك السابق (`LEDGER_ENTRY_SIGN[t] ?? 1`). */
export function deliveryLedgerEntrySign(entryType: string | null | undefined): 1 | -1 {
  return isDeliveryLedgerEntryType(entryType) ? DELIVERY_LEDGER_ENTRY_SIGN[entryType] : 1;
}
