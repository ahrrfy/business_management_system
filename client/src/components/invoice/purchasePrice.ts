/**
 * سعرُ الوحدة المُقترَح على شاشة الشراء — `costPriceBase × conversionFactor`.
 *
 * **الفصل بين الحقلين مقصود:**
 *   • `costBase` = تكلفة **الوحدة الأساس** (قطعة) — مرجعٌ ثابت من `catalog.forPurchase`
 *     (`productVariants.costPrice`). لا يُعاد كتابته من مُدخَل الشاشة.
 *   • `price` = سعر الشراء بـ**وحدة الصفّ** المختارة (قطعة/درزن/كرتون) — ما يُرسَل خادمياً
 *     في `unitPrice` من حمولة `purchases.createOrder`، ثمّ يقسمه `receive.ts` على معامل
 *     الوحدة ليحصل على `costPerBase` الداخل في WAVG.
 *
 * **الخطأ الذي يُغلقه هذا المساعد (PUR-UNIT-01):** كانت الشاشتان تُملآن الحقلَين معاً بـ
 * `r.costPriceBase` (تكلفة الأساس) ⇒ درزن (معامل ١٢) بتكلفة قطعةٍ ١٥٠ يُضاف بسعر ١٥٠ لا
 * ١٨٠٠، فيمرّ في الحمولة `unitPrice=150` ثمّ يقسمه الخادم على ١٢ ⇒ **`costPerBase = 12.50`**
 * فيسمّم WAVG بشدّة (رصيد ٢٣٩ قطعةً بـ١٥٠ + استلام ١٢ قطعة بـ١٥٠ إجمالياً ⇒ WAVG ≈ ١٤٣ بدل ١٥٠).
 *
 * **الاسم «تقديريّ» عمداً:** سعر المورّد الفعليّ يحسمه المستخدم قبل الحفظ — هذا التقدير
 * يوفّر عليه إعادةَ كتابة العدد المألوف حين لا يتغيّر، ولا يفرضه على ورقة المورّد.
 *
 * @returns سعرٌ نصّيّ منسَّق بدقّة عملة الأمر (`priceDecimalsFor(currency)` — ٢ للدينار و٤ للدولار).
 *          مدخلٌ فارغ/سالب/غير صالح ⇒ `"0.00"` بأمان (لا رمي `D()`).
 *          معاملٌ ≤ صفر أو معدوم ⇒ التكلفة كما هي (كأنّ الوحدة أساس).
 */
import { D, toUnitPriceStr } from "@/lib/money";
import type { PriceCurrency } from "@shared/moneyPrecision";

export function estimatedPurchaseUnitPrice(
  costPriceBase: string | null | undefined,
  conversionFactor: string | null | undefined,
  currency: PriceCurrency = "IQD",
): string {
  // `D()` تحمي من "" و null بترجمتها إلى صفر (لا رمي — الشاشة تعرض هذا الرقم مباشرةً).
  const cost = D(costPriceBase ?? "0");
  const factor = D(conversionFactor ?? "1");
  if (cost.lte(0)) return toUnitPriceStr("0", currency);
  const effective = factor.lte(0) ? cost : cost.times(factor);
  return toUnitPriceStr(effective.toString(), currency);
}
