/**
 * supplierInvoiceMatch.ts — **مطابقة أمر الشراء بفاتورة المورّد الورقيّة** (منطقٌ نقيّ، بلا React).
 *
 * **الجذر (بلاغ المالك ١٧/٨/٢٦):** «لا يتم قبول الفاتورة ولا يمكن مطابقتها مع المورد وقيمة
 * الفاتورة». وفعلاً: قيمة فاتورة المورّد (`purchaseOrders.usdTotal`) كانت **مشتقّةً لا مُعلَنة** —
 * لا حقلَ لها في أيّ شاشة، والشاشتان تمتنعان عن إرسالها عمداً لأنّ حارس الخادم كان يرفض بأيّ
 * فرق تقريبٍ برسالةٍ عمياء («لا يطابق مجموع البنود») بلا رقمٍ ولا سبيلٍ للتسوية. فالموظّف يرى
 * إجمالياً يخالف الورقة التي بيده ولا يملك أداةً لتقريبهما.
 *
 * **النموذج المعتمَد — المطابقة تصحيحٌ صريحٌ للأسعار لا امتصاصٌ خفيّ:**
 * فاتورةُ المورّد هي المستند الخارجيّ، وبنودُنا إعادةُ بنائه. حين يختلفان:
 *   • يُعرَض **الفرق بالرقم** قبل الحفظ (لا رفضٌ غامض).
 *   • ويُتاح توزيعُه على أسعار البنود بنسبة القيمة — **فيرى الموظّف الأسعار الجديدة ويؤكّدها**.
 * لا نمتصّ الفرق في حقلٍ خفيّ ولا نُعدّل إجماليّاً بلا أثرٍ على البنود: ذلك يخالف «لا دينار يضيع
 * بصمت أو ليس له مسار» (§٥)، ويجعل تكلفة الصنف (WAVG) والذمّة تختلفان عن المستند.
 *
 * ⚠️ الدقّة تتبع عملة الأمر (`shared/moneyPrecision`): الدينار منزلتان والدولار أربع. فقد لا
 * يكون الهدفُ بالغاً بالضبط بأسعارٍ ضمن تلك الدقّة (قيمةٌ لا تقبل القسمة على الكميات)؛ عندها
 * تُرجِع الدالّة **المتبقّي صراحةً** بدل ادّعاء تطابقٍ لم يقع.
 */
import Decimal from "decimal.js";
import { priceDecimalsFor, type PriceCurrency } from "@shared/moneyPrecision";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

/** سطرٌ بالحدّ الأدنى الذي تحتاجه المطابقة (نظير `InvoiceLine` بلا بقيّة الحقول). */
export interface MatchLine {
  price: string;
  qty: number | string;
}

export type MatchVerdict =
  /** لم تُدخَل قيمة فاتورة المورّد ⇒ لا مطابقة مطلوبة (السلوك التاريخيّ). */
  | "UNSET"
  /** القيمة المُدخَلة غير رقمية/سالبة. */
  | "INVALID"
  /** مطابقٌ تماماً ⇒ الحفظ يمرّ. */
  | "MATCH"
  /** فاتورة المورّد **أقلّ** من مجموع بنودنا (خصمٌ من المورّد أو سعرٌ أعلى لدينا). */
  | "OURS_HIGHER"
  /** فاتورة المورّد **أعلى** من مجموع بنودنا (بندٌ ناقص أو سعرٌ أقلّ لدينا). */
  | "OURS_LOWER";

export interface MatchResult {
  verdict: MatchVerdict;
  /** الإجمالي المشتقّ من البنود بعملة الأمر (2dp) — ما سيحفظه الخادم. */
  derived: string;
  /** قيمة فاتورة المورّد كما أُدخلت، مُطبَّعة (2dp) أو "" حين لا قيمة. */
  declared: string;
  /** فاتورة المورّد − مجموع بنودنا (2dp، موقَّع). صفرٌ عند التطابق أو غياب القيمة. */
  difference: string;
  /** رسالة عربية جاهزة للعرض (فارغة عند UNSET). */
  message: string;
}

const d2 = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const safe = (v: string | number | null | undefined): Decimal | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  try {
    const d = new Decimal(String(v).trim());
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

const sym = (currency: PriceCurrency) => (currency === "USD" ? "$" : "د.ع");

/**
 * يقارن إجماليَّ الأمر المشتقّ بقيمة فاتورة المورّد المُعلَنة ويُصدر حكماً برسالةٍ **تحمل الرقمين
 * والفرق** — لا «لا يطابق» مجرّدة. `derivedTotal` بعملة الأمر (نظير `calcTotals().grandTotal`).
 */
export function matchSupplierInvoice(
  derivedTotal: string,
  declaredRaw: string,
  currency: PriceCurrency,
): MatchResult {
  const derivedD = safe(derivedTotal) ?? new Decimal(0);
  const derived = d2(derivedD).toFixed(2);
  const declaredD = safe(declaredRaw);
  const cur = sym(currency);

  if (declaredD === null) {
    return { verdict: "UNSET", derived, declared: "", difference: "0.00", message: "" };
  }
  if (declaredD.isNegative()) {
    return {
      verdict: "INVALID",
      derived,
      declared: d2(declaredD).toFixed(2),
      difference: "0.00",
      message: "قيمة فاتورة المورّد لا تصحّ أن تكون سالبة.",
    };
  }

  const declared = d2(declaredD).toFixed(2);
  const diff = d2(new Decimal(declared).minus(derived));
  const difference = diff.toFixed(2);

  if (diff.isZero()) {
    return {
      verdict: "MATCH",
      derived,
      declared,
      difference,
      message: `مطابق: مجموع البنود يساوي فاتورة المورّد (${derived} ${cur}).`,
    };
  }

  const abs = diff.abs().toFixed(2);
  if (diff.isNegative()) {
    return {
      verdict: "OURS_HIGHER",
      derived,
      declared,
      difference,
      message:
        `مجموع بنودنا (${derived} ${cur}) يزيد على فاتورة المورّد (${declared} ${cur}) بفرق ${abs} ${cur}. ` +
        "السبب المعتاد: خصمٌ من المورّد لم يُدخَل، أو سعر وحدةٍ أعلى مما في الفاتورة.",
    };
  }
  return {
    verdict: "OURS_LOWER",
    derived,
    declared,
    difference,
    message:
      `فاتورة المورّد (${declared} ${cur}) تزيد على مجموع بنودنا (${derived} ${cur}) بفرق ${abs} ${cur}. ` +
      "السبب المعتاد: بندٌ لم يُدخَل، أو سعر وحدةٍ أقلّ مما في الفاتورة، أو أجرة شحنٍ مدرَجة في الفاتورة (تُدخَل في حقل الشحن لا في الأسعار).",
  };
}

/**
 * **إجماليّ المستند بعملته، بترتيب تقريب الخادم حرفياً**: `Σ round2(سعر × كمّية)` ثمّ الضريبة على
 * المجموع — لا `round2(Σ سعر × كمّية)`.
 *
 * ⚠️ لماذا لا نستعمل `calcTotals().grandTotal` هنا: هي تجمع القيم **غير مقرَّبة** ثمّ تقرّب مرّةً
 * واحدة، بينما `computePurchaseDocument` يقرّب **كلّ سطرٍ** ثمّ يجمع. الفرق صفرٌ بالدينار (سعرٌ
 * بمنزلتين × كمّيةٍ صحيحة = منزلتان بالضبط)، لكنّه فلسٌ حقيقيّ بالدولار ذي الأربع منازل
 * (`3.4566 × 7 = 24.1962` ⇒ الخادم 24.20 والعميل 24.1962) — فتُظهر اللوحة «مطابق» بينما يرفض
 * الخادم، أو العكس. المطابقة لا تحتمل تعريفَين للإجمالي.
 */
export function deriveDocumentTotal(
  lines: MatchLine[],
  taxRatePercent: string | number = 0,
): { subtotal: string; tax: string; total: string } {
  const subtotal = d2(
    lines.reduce((acc, l) => {
      const price = safe(l.price) ?? new Decimal(0);
      const qty = safe(l.qty) ?? new Decimal(0);
      return acc.plus(d2(price.times(qty)));
    }, new Decimal(0)),
  );
  const rate = safe(taxRatePercent) ?? new Decimal(0);
  const tax = rate.gt(0) ? d2(subtotal.times(rate).dividedBy(100)) : new Decimal(0);
  return { subtotal: subtotal.toFixed(2), tax: tax.toFixed(2), total: d2(subtotal.plus(tax)).toFixed(2) };
}

export interface DistributeResult {
  /** الأسعار الجديدة بترتيب البنود نفسه (نصوصٌ بدقّة العملة). فارغة ⇒ تعذّر التوزيع. */
  prices: string[];
  /** المجموع الفرعيّ الذي تبلغه الأسعار الجديدة فعلاً (2dp). */
  reachedSubtotal: string;
  /** ما تعذّر بلوغه من الهدف (2dp، موقَّع). صفرٌ = بلغ الهدف بالضبط. */
  residual: string;
  /** سببُ التعذّر حين `prices` فارغة. */
  error?: string;
}

/**
 * يوزّع فرق المطابقة على **أسعار البنود بنسبة القيمة** ليبلغ المجموعُ الفرعيّ هدفاً محدَّداً.
 *
 * الخوارزمية: معاملُ تحجيمٍ واحد على كلّ سعر (يحفظ النسب بين البنود = «بنسبة القيمة»)، ثمّ
 * **آخر بندٍ ذي كمّيةٍ موجبة يمتصّ باقي التقريب** — نفس نمط `allocateLineTax` الذي يضمن أنّ
 * المجموع يساوي الهدف بالضبط بدل انجراف سنتات.
 *
 * يُرجع `residual ≠ 0` حين لا يكون الهدف بالغاً بأسعارٍ ضمن دقّة العملة (كمّيةٌ كبيرة تجعل
 * أصغر خطوةِ سعرٍ أكبر من الفرق) — **إفصاحٌ لا ادّعاء**.
 */
export function distributeToSubtotal(
  lines: MatchLine[],
  targetSubtotal: string,
  currency: PriceCurrency,
): DistributeResult {
  const dp = priceDecimalsFor(currency);
  const roundPrice = (x: Decimal) => x.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
  const target = safe(targetSubtotal);
  if (target === null || target.isNegative()) {
    return { prices: [], reachedSubtotal: "0.00", residual: "0.00", error: "قيمة الهدف غير صالحة." };
  }

  const parsed = lines.map((l) => ({ price: safe(l.price) ?? new Decimal(0), qty: safe(l.qty) ?? new Decimal(0) }));
  const current = parsed.reduce((acc, l) => acc.plus(d2(l.price.times(l.qty))), new Decimal(0));
  if (current.lte(0)) {
    return {
      prices: [],
      reachedSubtotal: "0.00",
      residual: "0.00",
      error: "لا يمكن توزيع الفرق على بنودٍ بقيمةٍ صفرية — أدخِل الأسعار أوّلاً.",
    };
  }

  const scale = target.dividedBy(current);
  const prices = parsed.map((l) => roundPrice(l.price.times(scale)));

  // آخر بندٍ ذي كمّيةٍ موجبة يمتصّ الباقي (لا يُترَك انجرافُ سنتاتٍ في المجموع).
  let lastIdx = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i].qty.gt(0)) {
      lastIdx = i;
      break;
    }
  }
  const sumOf = (ps: Decimal[]) => ps.reduce((acc, p, i) => acc.plus(d2(p.times(parsed[i].qty))), new Decimal(0));

  if (lastIdx >= 0) {
    const rest = sumOf(prices).minus(d2(prices[lastIdx].times(parsed[lastIdx].qty)));
    const needed = target.minus(rest).dividedBy(parsed[lastIdx].qty);
    const adjusted = roundPrice(needed);
    if (!adjusted.isNegative()) prices[lastIdx] = adjusted;
  }

  const reached = d2(sumOf(prices));
  return {
    prices: prices.map((p) => p.toFixed(dp)),
    reachedSubtotal: reached.toFixed(2),
    residual: d2(target.minus(reached)).toFixed(2),
  };
}

/**
 * المجموع الفرعيّ الذي يلزم بلوغه كي يصير **إجماليُّ الفاتورة** (بعد الضريبة) مساوياً للهدف:
 * `subtotal × (1 + r/100) = target` ⇒ `subtotal = target × 100 / (100 + r)`.
 * الضريبة صفرٌ (الافتراضيّ في العراق) ⇒ الهدف نفسه بلا أيّ تقريب.
 */
export function subtotalForInvoiceTotal(targetTotal: string, taxRatePercent: string | number): string {
  const target = safe(targetTotal) ?? new Decimal(0);
  const rate = safe(taxRatePercent) ?? new Decimal(0);
  if (rate.lte(0)) return d2(target).toFixed(2);
  return d2(target.times(100).dividedBy(new Decimal(100).plus(rate))).toFixed(2);
}
