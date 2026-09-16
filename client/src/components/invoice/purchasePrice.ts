/**
 * سعرُ الوحدة المُقترَح على شاشة الشراء — `costPriceBase × conversionFactor`، مع تحويلٍ إلى
 * عملة الأمر عند وجود سعر تثبيت.
 *
 * **الفصل بين الحقلين مقصود:**
 *   • `costBase` = تكلفة **الوحدة الأساس** (قطعة) — مرجعٌ ثابت من `catalog.forPurchase`
 *     (`productVariants.costPrice`)، **بالدينار العراقيّ** دائماً (تكلفة WAVG بـIQD).
 *   • `price` = سعر الشراء بـ**وحدة الصفّ** المختارة (قطعة/درزن/كرتون) — ما يُرسَل خادمياً
 *     في `unitPrice` من حمولة `purchases.createOrder` **بعملة الأمر** (`agreedCurrency`)،
 *     ثمّ يقسمه `receive.ts` على معامل الوحدة ليحصل على `costPerBase` الداخل في WAVG.
 *
 * **الخطأ الذي يُغلقه هذا المساعد (PUR-UNIT-01):** كانت الشاشتان تُملآن الحقلَين معاً بـ
 * `r.costPriceBase` (تكلفة الأساس بالدينار) ⇒ درزن (معامل ١٢) بتكلفة قطعةٍ ١٥٠ يُضاف بسعر
 * ١٥٠ لا ١٨٠٠، فيمرّ في الحمولة `unitPrice=150` ثمّ يقسمه الخادم على ١٢ ⇒ **`costPerBase = 12.50`**
 * فيسمّم WAVG بشدّة (رصيد ٢٣٩ قطعةً بـ١٥٠ + استلام ١٢ قطعة بـ١٥٠ إجمالياً ⇒ WAVG ≈ ١٤٣ بدل ١٥٠).
 *
 * **الفرع الدولاريّ — Codex #980 (٤/٩/٢٦):** `catalog.forPurchase.costPriceBase` يبقى بالدينار
 * حتى في أمر الشراء الدولاريّ (تكلفة WAVG الداخلية). إن كانت العملة `USD` فيلزم قسمةُ الناتج
 * على `agreedRate` (د.ع/$) للحصول على سعر وحدة الصفّ **بالدولار**، وإلّا وُضِع المبلغُ الدينارّي
 * حرفياً في حقل الدولار فيتضخّم في `unitPrice` ثمّ يضربه الخادم بسعر التثبيت ⇒ AP/WAVG بمقدار
 * `agreedRate` مرّةً. مثال: قطعة ١٥٠ د.ع، درزن معامل ١٢، تثبيت ١٤٥٠ د.ع/$ ⇒ صحيح ‎$1.2414
 * لا ‎$1800.
 *
 * **⚠️ حين تكون العملة `USD` ولا سعر تثبيت (أو ≤ ٠):** نُعيد نصّاً فارغاً `""` قصداً، لا افتراضاً
 * ديناريّاً صامتاً. رقمٌ دولاريٌّ ملفَّق **أسوأ** من حقلٍ فارغ يُلزم المستخدمَ إدخالَ التثبيت
 * أوّلاً — والحفظُ محروسٌ خادمياً بـ `agreedRate > 0` للأمر الدولاريّ فلا يُقبل ادّعاءُ سعرٍ
 * قبل ضبطه.
 *
 * **الاسم «تقديريّ» عمداً:** سعر المورّد الفعليّ يحسمه المستخدم قبل الحفظ — هذا التقدير
 * يوفّر عليه إعادةَ كتابة العدد المألوف حين لا يتغيّر، ولا يفرضه على ورقة المورّد.
 *
 * @returns سعرٌ نصّيّ منسَّق بدقّة عملة الأمر (`priceDecimalsFor(currency)` — ٢ للدينار و٤ للدولار).
 *          مدخلٌ فارغ/سالب/غير صالح ⇒ `"0.00"` بأمان (لا رمي `D()`).
 *          معاملٌ ≤ صفر أو معدوم ⇒ التكلفة كما هي (كأنّ الوحدة أساس).
 *          `USD` بلا `agreedRate > 0` ⇒ `""` (لا تخمين — المستخدم يدخل يدوياً).
 */
import Decimal from "decimal.js";
import { D, toUnitPriceStr } from "@/lib/money";
import type { PriceCurrency } from "@shared/moneyPrecision";

export function estimatedPurchaseUnitPrice(
  costPriceBase: string | null | undefined,
  conversionFactor: string | null | undefined,
  currency: PriceCurrency = "IQD",
  agreedRate: string | null | undefined = null,
): string {
  // `D()` تحمي من "" و null بترجمتها إلى صفر (لا رمي — الشاشة تعرض هذا الرقم مباشرةً).
  const cost = D(costPriceBase ?? "0");
  const factor = D(conversionFactor ?? "1");
  if (cost.lte(0)) return currency === "USD" && !hasPositiveRate(agreedRate) ? "" : toUnitPriceStr("0", currency);
  const iqdRowUnit = factor.lte(0) ? cost : cost.times(factor);
  if (currency !== "USD") return toUnitPriceStr(iqdRowUnit.toString(), currency);
  // USD: قسمةُ الناتج الديناريّ على سعر التثبيت (د.ع/$). بلا تثبيتٍ صحيح ⇒ فارغ (لا خمين).
  if (!hasPositiveRate(agreedRate)) return "";
  const rate = D(agreedRate);
  const usdRowUnit = iqdRowUnit.dividedBy(rate);
  return toUnitPriceStr(usdRowUnit.toString(), currency);
}

function hasPositiveRate(rate: string | null | undefined): boolean {
  if (rate == null || rate === "") return false;
  try {
    return new Decimal(rate).gt(0);
  } catch {
    return false;
  }
}

/**
 * Codex #980 (٤/٩/٢٦) — Finding 4: مسار الاستحضار من طلب شراء (`purchaseRequisitions`) يبني
 * سعرَ السطر افتراضاً من `estimatedUnitPrice` ثمّ يعود إلى `costPriceBase` عند غيابه. كلا
 * المصدرين قد يكونان **مصابَين بعطب PUR-UNIT-01 القديم**: `PurchaseRequisitions.addCatalogItem`
 * كان يُهيّئ `estimatedUnitPrice = row.costPriceBase` بلا ضربٍ بمعامل الوحدة، فطلبٌ لدرزنٍ
 * (معامل ١٢) بتكلفة قطعةٍ ١٥٠ يمرّ في الاستحضار بسعرٍ ١٥٠ لا ١٨٠٠ ⇒ يقسمه الخادم على ١٢
 * ⇒ `costPerBase = 12.50` يسمّم WAVG.
 *
 * الحلّ الدفاعيّ: إذا كان القادم مساوياً (أو أقلّ من) تكلفة الأساس بينما المعامل > ١، نعتبره
 * مصاباً ونعيد الحساب بـ`estimatedPurchaseUnitPrice(costBase, factor)`. القادم الأعلى صراحةً
 * (تسعيرٌ يدويٌّ للمُعتمِد) يُحترَم كما هو ويُعاد نصّاً بلا تحويل.
 *
 * الطلب الداخلي بلا عمود عملة على `purchaseRequisitions` ⇒ الاشتقاق دائماً بالدينار (`IQD`).
 * تحويلُ العملة قرارُ المستخدم قبل الحفظ في المحرّر، والمحرّر يرفض الحفظَ الدولاريّ بلا
 * `agreedRate > 0`. المستخدم يستطيع تعديل السعر يدوياً بعد الاستحضار.
 */
export function derivePurchaseLinePriceFromRequisition(
  estimatedUnitPrice: string | null | undefined,
  costPriceBase: string | null | undefined,
  conversionFactor: string | null | undefined,
): string {
  const factor = safeDecimal(conversionFactor ?? "1");
  const cost = safeDecimal(costPriceBase ?? "0");
  const provided = estimatedUnitPrice != null && estimatedUnitPrice !== ""
    ? safeDecimal(estimatedUnitPrice)
    : null;
  // بلا `estimatedUnitPrice` صريح ⇒ اشتقّه من التكلفة × المعامل مباشرةً.
  if (provided == null) return estimatedPurchaseUnitPrice(costPriceBase ?? "0", conversionFactor ?? "1");
  // مؤشّر إصابة PUR-UNIT-01 المفسدة: القادم بحجم تكلفة الأساس بينما المعامل يستوجب ضرباً.
  if (factor.gt(1) && cost.gt(0) && provided.lte(cost)) {
    return estimatedPurchaseUnitPrice(costPriceBase ?? "0", conversionFactor ?? "1");
  }
  // نصٌّ نقيٌّ يحترم إدخالَ المُعتمِد الصريح — لا نُعيد تنسيقه (المحرّر يعرضه كما هو).
  return String(estimatedUnitPrice);
}

function safeDecimal(v: string | number | null | undefined): Decimal {
  const raw = typeof v === "number" ? String(v) : (v ?? "").trim();
  if (raw === "") return new Decimal(0);
  try {
    return new Decimal(raw);
  } catch {
    return new Decimal(0);
  }
}
