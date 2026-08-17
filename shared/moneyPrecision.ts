/**
 * moneyPrecision.ts — **دقّة أسعار الوحدة حسب العملة**: مصدر الحقيقة الوحيد للعميل والخادم.
 *
 * **الجذر (بلاغ المالك ١٧/٨/٢٦):** «سعر الشراء لا يمكن أن يكون 1,450.99، وبالدولار لا يقبل
 * 3.4566». كانت أسعار بنود الفواتير تمرّ بثلاث طبقاتٍ تقصّها إلى منزلتين بلا إشعار:
 *   ١) خليّة السعر في محرّر الفواتير (بلا سقف منازل أصلاً، ثم قصٌّ عند المغادرة للدولار)،
 *   ٢) حمولة الشاشة (`round2(...).toFixed(2)` قبل الإرسال)،
 *   ٣) عقد الراوتر (`nonNegMoneyString` = منزلتان).
 * بينما العمود `purchaseOrderItems.usdUnitPrice` مُعرَّف `decimal(15,4)` أصلاً ⇒ النظام كان
 * **يرمي دقّةً صمّمت قاعدتُه لحفظها**. أثرُ ذلك ماليّ لا تجميليّ: سعر $3.4566 يُخزَّن 3.46 ⇒
 * على ٥٠٠٠ وحدة فرقٌ قدره $17 في ذمّة المورّد، وتكلفةٌ دينارية خاطئة تُسمّم المتوسّط المرجّح
 * (WAVG) فتبقى الأرباح مغلوطةً لكلّ بيعةٍ لاحقة من ذلك الصنف.
 *
 * **القاعدة:** الدقّة صفةُ **العملة** لا صفةُ الحقل:
 *   • الدينار العراقي (IQD): منزلتان — مطابقٌ لأعمدة `decimal(15,2)` ولغياب فئاتٍ أصغر.
 *   • الدولار (USD): أربع منازل — سعرُ وحدةٍ يُشتقّ عادةً بقسمة سعر الكرتون على عدد القطع
 *     (`41.48 ÷ 12 = 3.4566…`)، وقصّه لسنتين يُراكم فرقاً بحجم الكمية.
 *
 * ⚠️ لا تُكرّر هذه الأرقام في شاشةٍ أو راوترٍ أو خدمة — استوردها من هنا. تكرارُها يضمن انجرافاً
 * (نفس درس `priceSanity.ts` و`inboundPaymentPolicy.ts`).
 */

/** العملات التي يقبلها محرّر الفواتير (مرآة `Currency` في `client/src/components/invoice/types.ts`). */
export type PriceCurrency = "IQD" | "USD";

/** منازل سعر الوحدة بالدينار — مطابقة لأعمدة `decimal(15,2)` ولغياب فئاتٍ أصغر من الدينار. */
export const IQD_PRICE_DECIMALS = 2;

/** منازل سعر الوحدة بالدولار — مطابقة لعمود `purchaseOrderItems.usdUnitPrice decimal(15,4)`. */
export const USD_PRICE_DECIMALS = 4;

/** أوسع دقّةٍ يقبلها أيّ سعر وحدة (سقف عقد الراوتر قبل التضييق حسب العملة داخل الخدمة). */
export const MAX_PRICE_DECIMALS = USD_PRICE_DECIMALS;

/** رمز العملة للرسائل العربية. */
export const PRICE_CURRENCY_LABEL_AR: Record<PriceCurrency, string> = {
  IQD: "الدينار",
  USD: "الدولار",
};

/** منازل سعر الوحدة المسموحة لعملةٍ ما. أيّ عملةٍ غير معروفة ⇒ سياسة الدينار (الأضيق = الأأمن). */
export function priceDecimalsFor(currency: PriceCurrency | string | null | undefined): number {
  return currency === "USD" ? USD_PRICE_DECIMALS : IQD_PRICE_DECIMALS;
}

/**
 * عدد المنازل العشرية في نصٍّ رقميّ **بلا تحويلٍ إلى `Number`** (§٥: ممنوع `parseFloat` على المال).
 * يُرجع `-1` للنصّ غير الرقميّ (يفصل «صيغة تالفة» عن «دقّة زائدة» في الرسائل).
 * الأصفار الذيليّة لا تُحتسب: «3.4500» دقّتها الفعليّة منزلتان لا أربع.
 */
export function countPriceDecimals(raw: string | null | undefined): number {
  const s = String(raw ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return -1;
  const dot = s.indexOf(".");
  if (dot === -1) return 0;
  return s.slice(dot + 1).replace(/0+$/, "").length;
}

/** هل يقع السعر ضمن دقّة عملته؟ النصّ التالف ⇒ `false` (يُردّ برسالة الصيغة لا برسالة الدقّة). */
export function isWithinPriceDecimals(
  raw: string | null | undefined,
  currency: PriceCurrency | string | null | undefined,
): boolean {
  const dp = countPriceDecimals(raw);
  return dp >= 0 && dp <= priceDecimalsFor(currency);
}

/**
 * رسالة الرفض الموحَّدة عند تجاوز الدقّة — **تُصرِّح بالسبب والحدّ** بدل قصٍّ صامت.
 * `label` وصفُ الحقل كما يراه المستخدم (اسم الصنف مثلاً) كي يعرف أيّ سطرٍ يُصحِّح.
 */
export function priceDecimalsMessage(
  currency: PriceCurrency | string | null | undefined,
  label: string,
  raw?: string | null,
): string {
  const dp = priceDecimalsFor(currency);
  const cur = PRICE_CURRENCY_LABEL_AR[(currency === "USD" ? "USD" : "IQD") as PriceCurrency];
  const seen = raw ? ` (المُدخَل: ${raw})` : "";
  return `سعر «${label}» بـ${cur} يقبل ${dp} منازل عشرية كحدّ أقصى${seen} — صحّح الرقم بدل تقريبه تلقائياً.`;
}
