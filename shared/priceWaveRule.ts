/**
 * priceWaveRule.ts — **قاعدة موجة التسعير**: مصدر الحقيقة الوحيد للعميل والخادم.
 *
 * **الجذر (بلاغ المالك ٢٠/٨/٢٦):** شاشة «موجات تحديث الأسعار» كانت تحسب السعر الجديد في
 * الخادم وحده، فلا تستطيع الواجهة أن تُري المدير **ماذا سيحدث** قبل أن يضغط «معاينة» —
 * ولا أن تشرح لماذا سقط صفٌّ من النتيجة. وبما أنّ الحساب كان حبيس الخدمة، كان كلُّ عرضٍ في
 * الواجهة تخميناً موازياً قابلاً للانجراف.
 *
 * القاعدة هنا **دالّةٌ نقيّة واحدة** (`applyPriceWaveRule`) تستعملها:
 *   • الخدمة   ⇒ لحساب `newPrice` الذي يُكتب فعلاً في `productPrices`.
 *   • الشاشة   ⇒ لعرض «المثال الحيّ» في خطوة القاعدة قبل أيّ نداءٍ للخادم.
 * ⇒ ما تراه هو ما يُكتب، حرفياً. لا تُكرّر هذا الحساب في أيّ مكانٍ آخر.
 *
 * **تكلفة الوحدة (`unitCost`) مسؤولية المستدعي، لا هذه الوحدة:** الصيغة الصحيحة
 * `تكلفة الأساس × معامل التحويل`، وللبكج تُشتقّ من وصفته (`loadBundleUnitCosts`) لأنّ عمود
 * تكلفته صفرٌ بحكم التصميم. تمرير `null` هنا يعني «غير معروفة» ⇒ لا حكمَ بالهامش ولا SET_MARGIN.
 */
import Decimal from "decimal.js";

/** أنواع التغيير — مرآة `priceUpdateWaves.priceChangeType` في القاعدة. */
export type PriceChangeType =
  | "INCREASE_PERCENT"
  | "DECREASE_PERCENT"
  | "INCREASE_AMOUNT"
  | "DECREASE_AMOUNT"
  | "SET_MARGIN";

/** تسميات عربية لنوع التغيير — لا تُعاد كتابتها في أيّ شاشة (درس `shared/invoiceStatus.ts`). */
export const PRICE_CHANGE_LABELS: Record<PriceChangeType, string> = {
  INCREASE_PERCENT: "رفع بنسبة (%)",
  DECREASE_PERCENT: "تخفيض بنسبة (%)",
  INCREASE_AMOUNT: "إضافة مبلغ ثابت",
  DECREASE_AMOUNT: "طرح مبلغ ثابت",
  SET_MARGIN: "تعيين هامش على التكلفة (%)",
};

/** هل قيمة هذا النوع نسبةٌ مئوية (لا مبلغٌ بالدينار)؟ يحكم عنوان الحقل ودقّته والسقف ١٠٠٠. */
export function isPercentChange(t: PriceChangeType): boolean {
  return (
    t === "INCREASE_PERCENT" || t === "DECREASE_PERCENT" || t === "SET_MARGIN"
  );
}

/**
 * نطاق الموجة — **قرارٌ صريح لا نتيجةُ فلترٍ ساقط.**
 * كانت الخدمة تُسقط مصطلح البحث بصمت إن قلّ عن حرفين، فتُرجع المعاينة **كامل الكتالوج**
 * والمدير يظنّ أنه صفّى ⇒ موجةُ تسعيرٍ على كل شيء. النطاق يجعل «الكل» اختياراً واعياً.
 */
export type PriceWaveScope = "FILTERED" | "SELECTED" | "ALL";

export const PRICE_WAVE_SCOPE_LABELS: Record<PriceWaveScope, string> = {
  FILTERED: "بالفلاتر (فئة/بحث/فئة سعر)",
  SELECTED: "منتجات محدَّدة يدوياً",
  ALL: "كل الكتالوج",
};

/** وحدات التقريب المتاحة بالدينار العراقي. `0` = بلا تقريب (منزلتان). */
export const PRICE_ROUND_DENOMS = [0, 250, 500, 1000] as const;
export type PriceRoundDenom = (typeof PRICE_ROUND_DENOMS)[number];

/**
 * التقريب الافتراضيّ **في الواجهة** (قرار المالك ٢٠/٨/٢٦): أقرب ٢٥٠ د.ع — أصغر فئةٍ نقدية
 * متداولة في العراق، فسعرٌ كـ‎1,522.50 د.ع غير قابلٍ للتحصيل أصلاً.
 * ملاحظة: الخدمة **لا** تفترض هذا؛ غياب `roundToDenom` عندها = بلا تقريب. الشاشة تقترح،
 * والخدمة تنفّذ ما أُمرت به وتُخزّنه في رأس الموجة ⇒ يبقى المستند شاهداً على ما جرى فعلاً.
 */
export const DEFAULT_PRICE_ROUND_DENOM: PriceRoundDenom = 250;

export function priceRoundDenomLabel(d: number): string {
  return d > 0
    ? `أقرب ${d.toLocaleString("en-US")} د.ع`
    : "بلا تقريب (منزلتان)";
}

/** الحدّ الأدنى المطلق لأيّ سعر (W2) — لا صفر ولا سالب مهما بلغت نسبة التخفيض. */
export const MIN_PRICE = "0.01";

/** أقصى نسبةٍ مقبولة — مرآة CHECK `chk_wave_pct_bounds` في القاعدة. */
export const MAX_PERCENT_VALUE = 1000;

/** سبب سقوط صفٍّ من الموجة — يُعرَض للمدير بدل التخطّي الصامت الذي كان يُخفي عشرات الأصناف. */
export type PriceWaveSkipReason =
  | "NO_COST"
  | "BUNDLE_COST_UNRESOLVED"
  | "UNCHANGED"
  | "ROUNDING_REVERSES";

export const PRICE_WAVE_SKIP_LABELS: Record<PriceWaveSkipReason, string> = {
  NO_COST: "لا تكلفة معروفة لهذه الوحدة — «تعيين هامش» يحتاج تكلفة",
  BUNDLE_COST_UNRESOLVED: "بكج لم تُحَلّ تكلفة وصفته (مكوّن ناقص أو معطَّل)",
  UNCHANGED: "القاعدة لا تُغيّر هذا السعر",
  ROUNDING_REVERSES:
    "التقريب يعكس اتجاه التغيير على هذا السعر — صغّر وحدة التقريب أو كبّر القيمة",
};

export interface PriceWaveRule {
  changeType: PriceChangeType;
  /** نصّ رقميّ موجب (§٥: لا `parseFloat` على المال). */
  changeValue: string;
  /** وحدة التقريب بالدينار؛ `0`/غياب = بلا تقريب. */
  roundToDenom?: number | null;
}

export interface PriceWaveRuleOutcome {
  /** السعر الجديد بمنزلتين، أو `null` إن سقط الصفّ (انظر `skipReason`). */
  newPrice: string | null;
  skipReason: PriceWaveSkipReason | null;
  /** غيّر التقريبُ الناتجَ الحسابيّ فعلاً. */
  rounded: boolean;
  /** اصطدم الناتج بالأرضية المطلقة `MIN_PRICE` (W2). */
  clampedMin: boolean;
}

/**
 * تقريب لأقرب مضاعفٍ لـ`denom` بسياسة HALF_UP — **نفس سياسة `roundCashIQD`** في
 * `server/services/money.ts` (يحرس التطابقَ اختبارُ تكافؤٍ في `shared/priceWaveRule.test.ts`).
 * `denom ≤ 0` أو غير صحيح ⇒ بلا تقريب. الأرضية المطلقة تُطبَّق بعده لا قبله.
 */
export function roundToDenom(
  value: Decimal,
  denom: number | null | undefined,
): Decimal {
  const d = Number(denom ?? 0);
  if (!Number.isInteger(d) || d <= 0) return value;
  if (value.lte(0)) return value;
  const half = new Decimal(d).div(2);
  return value.plus(half).div(d).floor().times(d);
}

/**
 * القاعدة النقيّة: من (سعرٍ قديم، تكلفة وحدةٍ، قاعدة) إلى (سعرٍ جديد أو سببِ سقوط).
 *
 * الترتيب مقصود ومُلزِم: **احسب ← قرّب ← اقصّ عند الأرضية ← أسقط إن لم يتغيّر شيء.**
 * التقريب قبل الأرضية كي لا يُنتج التقريبُ صفراً؛ ومقارنةُ «لم يتغيّر» **بعد** التقريب كي لا
 * تُدرَج صفوفٌ يبتلع تقريبُها التغييرَ كلّه (رفعٌ ٢٪ على ‎1,000 مع تقريب ٢٥٠ = ‎1,000 نفسها).
 *
 * @param oldPrice سعر البيع الحاليّ لهذه (الوحدة × فئة السعر).
 * @param unitCost تكلفة **هذه الوحدة** (الأساس × معامل التحويل، أو وصفة البكج)؛ `null` = مجهولة.
 * @param isBundle يفصل رسالة «بكج بلا وصفة محلولة» عن «صنف بلا تكلفة».
 */
export function applyPriceWaveRule(
  oldPrice: string | number | Decimal,
  unitCost: string | number | Decimal | null,
  rule: PriceWaveRule,
  isBundle = false,
): PriceWaveRuleOutcome {
  const oldP = new Decimal(oldPrice);
  const val = new Decimal(rule.changeValue);
  const cost =
    unitCost == null || unitCost === "" ? null : new Decimal(unitCost);
  const hundred = new Decimal(100);

  let raw: Decimal;
  switch (rule.changeType) {
    case "INCREASE_PERCENT":
      raw = oldP.mul(hundred.plus(val)).div(hundred);
      break;
    case "DECREASE_PERCENT":
      raw = oldP.mul(hundred.minus(val)).div(hundred);
      break;
    case "INCREASE_AMOUNT":
      raw = oldP.plus(val);
      break;
    case "DECREASE_AMOUNT":
      raw = oldP.minus(val);
      break;
    case "SET_MARGIN":
      if (cost == null || cost.lte(0)) {
        return {
          newPrice: null,
          skipReason: isBundle ? "BUNDLE_COST_UNRESOLVED" : "NO_COST",
          rounded: false,
          clampedMin: false,
        };
      }
      raw = cost.mul(hundred.plus(val)).div(hundred);
      break;
  }

  const exact = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  let roundedVal = roundToDenom(exact, rule.roundToDenom);

  // (أ) سعرٌ أصغر من نصف حبيبة التقريب يُقرَّب إلى **صفر** ثمّ يُقصّ إلى 0.01 — سعرٌ عبثيّ.
  //     حبيبةُ ٢٥٠ لا تنطبق أصلاً على صنفٍ سعره ١٠٠، فنتركه بدقّته الحسابية بلا تقريب.
  if (roundedVal.lte(0) && exact.gt(0)) roundedVal = exact;

  // (ب) ⭐ التقريب **لا يعكس اتجاه الموجة أبداً**: «رفعٌ ١٪» على ‎1,260 يعطي ‎1,272.60 ويقرَّب
  //     لأقرب ٢٥٠ إلى ‎1,250 — أي أنّ موجةَ رفعٍ مضبوطةً تُنزِل السعر بصمت (والعكس بالعكس).
  //     لا نُصلحها بتقريبٍ اتجاهيّ (يقفز ‎1,260 إلى ‎1,500 = ‎+19٪ بلا طلب)، بل **نُسقِط الصفّ
  //     مُعلَّلاً** فيراه المدير في «الصفوف الساقطة» ويقرّر: حبيبةٌ أصغر أو قيمةٌ أكبر.
  //     يخصّ الأنواع الاتجاهية وحدها؛ `SET_MARGIN` هدفٌ مطلق لا اتجاه له مقابل السعر القديم.
  const directional = rule.changeType !== "SET_MARGIN";
  if (directional && !exact.equals(oldP)) {
    const wantedUp = exact.gt(oldP);
    const gotUp = roundedVal.gt(oldP);
    if (roundedVal.equals(oldP) === false && wantedUp !== gotUp) {
      return {
        newPrice: null,
        skipReason: "ROUNDING_REVERSES",
        rounded: true,
        clampedMin: false,
      };
    }
  }

  const wasRounded = !roundedVal.equals(exact);
  const floor = new Decimal(MIN_PRICE);
  const clampedMin = roundedVal.lt(floor);
  const finalVal = clampedMin ? floor : roundedVal;

  if (finalVal.toDecimalPlaces(2).equals(oldP.toDecimalPlaces(2))) {
    return {
      newPrice: null,
      skipReason: "UNCHANGED",
      rounded: wasRounded,
      clampedMin,
    };
  }
  return {
    newPrice: finalVal.toFixed(2),
    skipReason: null,
    rounded: wasRounded,
    clampedMin,
  };
}

/**
 * هامش الربح ٪ لسعرٍ مقابل تكلفة وحدةٍ: `(price − cost) / price × 100` (هامش على المبيع،
 * وهو ما يفهمه صاحب المكتبة: «كم من كل دينار مبيعات يبقى لي»). تكلفةٌ مجهولة/صفر ⇒ `null`
 * — لا نُظهر هامشاً ١٠٠٪ كاذباً كما كان يحدث للبكجات (تكلفتها صفرٌ في العمود).
 */
export function marginPct(
  price: string | number | Decimal,
  unitCost: string | number | Decimal | null,
): number | null {
  if (unitCost == null || unitCost === "") return null;
  const c = new Decimal(unitCost);
  const p = new Decimal(price);
  if (c.lte(0) || p.lte(0)) return null;
  return p.minus(c).div(p).mul(100).toDecimalPlaces(1).toNumber();
}
