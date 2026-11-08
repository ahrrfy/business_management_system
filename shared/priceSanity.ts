/**
 * priceSanity.ts — حرّاس عقلانية للحقول العددية المالية (تكلفة/سعر/معامل التحويل).
 *
 * **الجذر (٣٠/٧/٢٦):** أُدخِلت تكلفة `16162 د.ع` بينما المفروض `1162.5` لصنفٍ يُباع بـ‎2000 د.ع،
 * فأشعل حارس «البيع تحت التكلفة» في POS وأوقف الكاشير عن إتمام كل فاتورة تحوي هذا الصنف.
 * السبب البنيويّ: حقول التكلفة/المعامل تُقبَل بلا فحص عقلانية (تكلفة > سعر البيع بخمسة أضعاف؟
 * معامل تحويل بستّة أرقام؟) — أيّ نقرةٍ عرضية على مفتاح تُخزَّن كتكلفة صالحة.
 *
 * هذه الوحدة تُشارَك بين العميل (منع الحفظ + التنبيه المرئيّ) والخادم (رفض قاطع بـzod refinement) —
 * دفاعاً في العمق: نفس القاعدة، تُطبَّق في الطبقتين. **لا تكرّرها** في مكانٍ آخر.
 *
 * CATALOG-SURGICAL-20261107: جميع الحسابات والمقارنات المالية تتم عبر `Decimal` (`decimal.js`)
 * لمنع انحراف الفاصلة العائمة مع الحفاظ على واجهة العقد المشترك للعميل والخادم.
 *
 * **المستويات الثلاثة:**
 *  - `blocker`  ⇒ رفض قاطع (لا يُحفَظ حتى بتأكيد). قيم فلكية بيّنة الخطأ.
 *  - `warning`  ⇒ يتطلّب تأكيداً صريحاً «أؤكد رغم الشذوذ». تكلفة > سعر البيع مثلاً — نادرة لكن ممكنة.
 *  - `info`     ⇒ ملاحظة مرئية غير حاجزة. معلومات مفيدة (هامش ضيق جداً).
 */
import Decimal from "decimal.js";

/** الحدّ الأقصى المطلق لأيّ حقلٍ ماليّ في IQD — عشرة مليارات تفوق أيّ عمليةٍ معقولة في المكتبة. */
export const ABS_MAX_MONEY_IQD = 10_000_000_000;

/** الحدّ الأقصى المطلق لمعامل التحويل (وحدة أساس في وحدة كبيرة) — 100 ألف يفوق أيّ تعبئة معقولة. */
export const ABS_MAX_CONVERSION_FACTOR = 100_000;

/** نسبة «التكلفة أكبر من سعر البيع» بعدها لا يُبَاع الصنف بربح ⇒ يستوجب تأكيد بيعٍ بخسارة. */
export const COST_ABOVE_RETAIL_RATIO = 1.0;

/** نسبة «التكلفة أكبر من سعر البيع بأضعاف» ⇒ حاجز قاطع (خطأ إدخال ٩٩٪) لا يُقبَل حتى بتأكيد.
 *  في مثال ٣٠/٧: التكلفة كانت 16162 والسعر 2000 (٨×) ⇒ الحاجز يمسكها بلا خيار. */
export const COST_ABOVE_RETAIL_HARD_RATIO = 5.0;

/** «هامش ضيّق جداً»: سعر البيع يزيد على التكلفة بأقلّ من ٥٪ ⇒ ملاحظة إعلامية (info) لا حاجب. */
export const NARROW_MARGIN_RATIO = 1.05;

/** مستوى الملاحظة. تُفرَز على العميل حسبها: blocker يحظر، warning يستوجب تأكيداً، info يعرض فقط. */
export type SanityLevel = "blocker" | "warning" | "info";

export interface SanityIssue {
  level: SanityLevel;
  /** رمز داخليّ (مفيد للاختبار والتصنيف). */
  code: string;
  /** رسالة عربية موجَّهة للمستخدم. */
  message: string;
  /** الحقل المعنيّ (اختياري) — للتوجيه المرئيّ (تحديد الحقل بالأحمر مثلاً). */
  field?: "costPrice" | "conversionFactor" | "retail" | "wholesale" | "government" | "minStock" | "reorderPoint";
}

/**
 * يحوّل نصّ أو رقم الحقل إلى `Decimal` بحذر — بلا رمي: قيمة فارغة/غير رقمية ⇒ `null`.
 */
export function parseMoneyDecimal(raw: string | number | null | undefined): Decimal | null {
  if (raw == null) return null;
  if (typeof raw === "number" && !Number.isFinite(raw)) return null;
  const s = String(raw).trim();
  if (s === "" || s === "-") return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * يحوّل نصّ الحقل إلى `number` بحذر عبر `Decimal` — بلا رمي: قيمة فارغة/غير رقمية ⇒ `null` (تُهمَل بلا رفض).
 * التنقية النهائية للأصفار الزائدة تُطبَّق في `MoneyInput`/`NumberInput` قبل الوصول هنا.
 */
export function parseMoneyStr(raw: string | null | undefined): number | null {
  const d = parseMoneyDecimal(raw);
  if (!d) return null;
  const n = d.toNumber();
  return Number.isFinite(n) ? n : null;
}

/**
 * فحص مبلغٍ ماليّ منفرد (تكلفة/سعر) — حدّ مطلقٍ وحدّ سالب. لا يُفحَص «التكلفة > السعر» هنا
 * (يحتاج قيمتين ⇒ `checkCostVsRetail`). القيمة `null`/فارغة تُهمَل (اختياريّة).
 */
export function checkMoneyBounds(raw: string | null | undefined, field: SanityIssue["field"], labelAr: string): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const d = parseMoneyDecimal(raw);
  if (!d) return issues;
  if (d.lt(0)) {
    issues.push({ level: "blocker", code: "money_negative", field, message: `${labelAr} لا يصحّ أن يكون سالباً.` });
  }
  if (d.gt(ABS_MAX_MONEY_IQD)) {
    issues.push({ level: "blocker", code: "money_over_absmax", field, message: `${labelAr} تجاوز الحدّ الأقصى المعقول (${ABS_MAX_MONEY_IQD.toLocaleString("en-US")} د.ع) — راجع الرقم.` });
  }
  return issues;
}

/**
 * فحص معامل التحويل — يجب أن يكون عدداً صحيحاً > 1 لغير الأساس، وأقلّ من الحدّ المطلق. أرقام غير معقولة
 * (مثلاً 100000 قطعة في كارتون) خطأ إدخال شبه مؤكّد.
 */
export function checkConversionFactor(raw: string | null | undefined, isBase: boolean): SanityIssue[] {
  const issues: SanityIssue[] = [];
  if (isBase) return issues; // وحدة الأساس دائماً ١.
  const d = parseMoneyDecimal(raw);
  if (!d || d.lte(0)) {
    issues.push({ level: "blocker", code: "factor_missing", field: "conversionFactor", message: "معامل التحويل لغير الوحدة الأساس مطلوب ويكون أكبر من صفر." });
    return issues;
  }
  if (!d.isInteger()) {
    issues.push({ level: "blocker", code: "factor_not_integer", field: "conversionFactor", message: "معامل التحويل يجب أن يكون عدداً صحيحاً موجباً." });
    return issues;
  }
  if (d.lte(1)) {
    issues.push({ level: "blocker", code: "factor_le_one", field: "conversionFactor", message: "معامل التحويل لغير الأساس يجب أن يكون أكبر من ١ (درزن = ١٢، كرتون = …)." });
  }
  if (d.gt(ABS_MAX_CONVERSION_FACTOR)) {
    issues.push({ level: "warning", code: "factor_over_max", field: "conversionFactor", message: `معامل التحويل (${d.toNumber().toLocaleString("en-US")}) أكبر من ${ABS_MAX_CONVERSION_FACTOR.toLocaleString("en-US")} — راجع الرقم أو أكّد رغم الشذوذ.` });
  }
  return issues;
}

/**
 * مقارنة تكلفة مقابل سعر بيع (لكلٍّ من: مفرد/جملة/حكومي). التكلفة > السعر ⇒ خسارة، ⇒ warning
 * (يمرّ بتأكيدٍ صريح). التكلفة > السعر بخمسة أضعاف ⇒ blocker (خطأ إدخال شبه مؤكّد لا يُقبَل بتأكيد).
 *
 * `tierLabelAr`: تسمية الفئة للرسالة («المفرد»، «الجملة»، «الحكومي»، أو «سعر البيع»).
 */
export function checkCostVsRetail(costRaw: string | null | undefined, retailRaw: string | null | undefined, tierLabelAr: string): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const cost = parseMoneyDecimal(costRaw);
  const retail = parseMoneyDecimal(retailRaw);
  if (!cost || !retail || cost.lte(0) || retail.lte(0)) return issues;
  const ratio = cost.div(retail);
  const narrowThreshold = new Decimal(1).div(NARROW_MARGIN_RATIO);
  if (ratio.gte(COST_ABOVE_RETAIL_HARD_RATIO)) {
    issues.push({
      level: "blocker",
      code: "cost_over_retail_hard",
      field: "costPrice",
      message: `التكلفة (${cost.toNumber().toLocaleString("en-US")}) أكبر من سعر ${tierLabelAr} (${retail.toNumber().toLocaleString("en-US")}) بـ${ratio.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)}× — خطأ إدخال محتمل. راجع الرقم (نقطة عشرية/أصفار زائدة؟).`,
    });
  } else if (ratio.gt(COST_ABOVE_RETAIL_RATIO)) {
    issues.push({
      level: "warning",
      code: "cost_over_retail",
      field: "costPrice",
      message: `التكلفة (${cost.toNumber().toLocaleString("en-US")}) أكبر من سعر ${tierLabelAr} (${retail.toNumber().toLocaleString("en-US")}) ⇒ بيعٌ بخسارة. أكّد إن كان مقصوداً.`,
    });
  } else if (ratio.gt(narrowThreshold)) {
    // ratio بين COST_ABOVE_RETAIL_RATIO و NARROW_MARGIN_RATIO ⇒ هامشٌ ضيّق جداً.
    issues.push({
      level: "info",
      code: "narrow_margin",
      message: `هامش ${tierLabelAr} ضيّق جداً (أقلّ من ٥٪) — تأكّد من الرقم.`,
    });
  }
  return issues;
}

/**
 * وحدة سعرٍ لصنف — عادةً «مفرد» بمعامل ١، لكن ينطبق أيضاً على «درزن» بمعامل ١٢ (تكلفة الوحدة =
 * baseCost × factor). عند بيعِ درزن يجب أن يكون سعر الدرزن > تكلفة الدرزن.
 */
export interface UnitPricing {
  /** اسم الوحدة للرسالة (قطعة/درزن/كارتون…). */
  unitName: string;
  /** معامل التحويل عن وحدة الأساس (١ للأساس). */
  conversionFactor: number | string;
  /** هل هذه هي وحدة الأساس؟ إن لم تُمرَّر تُستنتج للتوافق الخلفي من المعامل ١. */
  isBaseUnit?: boolean;
  /** سعر البيع بهذه الوحدة (المفرد بحدّ أدنى، وقد يشمل الجملة/الحكومي). */
  retail: string | null;
  wholesale?: string | null;
  government?: string | null;
}

/**
 * الفحص الشامل لمتغيّرٍ (تكلفة الأساس × وحدات متعدّدة × ٣ فئات أسعار) —
 * يجمع كل الملاحظات ويرتّبها: blocker أولاً ثم warning ثم info.
 *
 * `baseUnitCost`: تكلفة الوحدة الأساس (سلسلة، بلا تحويل). عند غيابها ⇒ لا يمكن مقارنة أيّ سعر بها.
 */
export function checkVariantSanity(baseUnitCost: string | null | undefined, units: UnitPricing[]): SanityIssue[] {
  const issues: SanityIssue[] = [];
  // ١) حدود التكلفة الأساس نفسها.
  issues.push(...checkMoneyBounds(baseUnitCost, "costPrice", "التكلفة"));
  const baseCost = parseMoneyDecimal(baseUnitCost);
  // ٢) لكل وحدة: حدود الأسعار + مقارنة كلّ فئة بتكلفة الوحدة (baseCost × factor) بدقّة Decimal.
  for (const u of units) {
    const factorDec = parseMoneyDecimal(u.conversionFactor);
    const isBase = u.isBaseUnit !== undefined ? u.isBaseUnit : Boolean(factorDec && factorDec.eq(1));
    const factorIssues = checkConversionFactor(String(u.conversionFactor ?? ""), isBase);
    for (const it of factorIssues) issues.push({ ...it, message: `[${u.unitName}] ${it.message}` });
    issues.push(...checkMoneyBounds(u.retail, "retail", `سعر المفرد (${u.unitName})`));
    if (u.wholesale != null) issues.push(...checkMoneyBounds(u.wholesale, "wholesale", `سعر الجملة (${u.unitName})`));
    if (u.government != null) issues.push(...checkMoneyBounds(u.government, "government", `سعر الحكومي (${u.unitName})`));
    if (baseCost && baseCost.gt(0) && factorDec && factorDec.gt(0)) {
      const unitCost = baseCost.times(factorDec).toString();
      const tierChecks: Array<[string | null | undefined, string]> = [
        [u.retail, `المفرد (${u.unitName})`],
        [u.wholesale, `الجملة (${u.unitName})`],
        [u.government, `الحكومي (${u.unitName})`],
      ];
      for (const [priceRaw, tierLabel] of tierChecks) {
        if (priceRaw != null && priceRaw !== "") issues.push(...checkCostVsRetail(unitCost, priceRaw, tierLabel));
      }
    }
  }
  // ترتيب: blocker → warning → info، مع الحفاظ على الترتيب الأصلي داخل كل مستوى (سلوك سلسلة سلسة).
  const order: Record<SanityLevel, number> = { blocker: 0, warning: 1, info: 2 };
  return issues.slice().sort((a, b) => order[a.level] - order[b.level]);
}

/** نصّ مطالبة التأكيد المُوحَّد (للـwarning) — يُعرَض في حوار قبل الحفظ عند وجود شذوذ غير قاطع. */
export const CONFIRM_ABNORMAL_PRICE_PROMPT =
  "توجد ملاحظات على الأسعار/التكلفة (بيعٌ بخسارة أو شذوذ). هل تؤكّد الحفظ رغمها؟";

// ═══════════════════════════════════════════════════════════════════════════════
// تدرّج catastrophic → blocker → warning → info (توسعة ٣٠/٧ للطبقة ١).
// المصطلح: `catastrophic` = خطأ إدخال شبه مؤكّد، يستوجب اعتماد مديرٍ ثانٍ + سبباً مكتوباً.
// ═══════════════════════════════════════════════════════════════════════════════

/** نسبة التكلفة إلى مرجعٍ (بيعٍ أو قيمة سابقة) التي تصنّف الشذوذ كـcatastrophic. */
export const COST_CATASTROPHIC_RATIO = 10.0;

/** تصنيفٌ موحَّدٌ لتغيير التكلفة: (١) مقارنةً بسعر البيع، (٢) مقارنةً بالقيمة السابقة إن أُعطيت. */
export type CostChangeSeverity = "ok" | "info" | "warning" | "blocker" | "catastrophic";

/**
 * صنّف حدّة التكلفة بمقاييسٍ ثنائية: النسبة إلى `retail` والنسبة إلى `oldCost` (إن أُعطيت). النتيجة
 * هي الأشدّ بين المقياسَين.
 */
export function classifySeverity(cost: string | number | null | undefined, refs: { retail?: string | number | null; oldCost?: string | number | null } = {}): CostChangeSeverity {
  const c = parseMoneyDecimal(cost);
  if (!c || c.lte(0)) return "ok";
  const r = parseMoneyDecimal(refs.retail ?? null);
  const o = parseMoneyDecimal(refs.oldCost ?? null);
  const narrowThreshold = new Decimal(1).div(NARROW_MARGIN_RATIO);
  const cats: CostChangeSeverity[] = [];
  for (const ref of [r, o]) {
    if (!ref || ref.lte(0)) continue;
    const ratio = c.div(ref);
    if (ratio.gte(COST_CATASTROPHIC_RATIO)) cats.push("catastrophic");
    else if (ratio.gte(COST_ABOVE_RETAIL_HARD_RATIO)) cats.push("blocker");
    else if (ratio.gt(COST_ABOVE_RETAIL_RATIO)) cats.push("warning");
    else if (ratio.gt(narrowThreshold)) cats.push("info");
    else cats.push("ok");
  }
  if (cats.includes("catastrophic")) return "catastrophic";
  if (cats.includes("blocker")) return "blocker";
  if (cats.includes("warning")) return "warning";
  if (cats.includes("info")) return "info";
  return "ok";
}

/**
 * اقتراحٌ تصحيحيّ واحد: القيمة البديلة + وصفٌ للعملية التي تولّده + مسافةٌ لتصنيف الأولوية.
 */
export interface CostSuggestion {
  value: number;
  description: string;
  /** كلما اقتربت من ١ كان الاقتراح مثاليّاً (المسافة النسبيّة من المرجع/الوسيط). */
  score: number;
}

/**
 * يقترح تصحيحاتٍ محتملة لقيمة تكلفةٍ شاذّة، بأنماط أخطاء الإدخال الشائعة.
 */
export function suggestCostCorrections(cost: string | number, retail?: string | number | null, medianCategoryCost?: number | null): CostSuggestion[] {
  const cDec = parseMoneyDecimal(cost);
  if (!cDec || cDec.lte(0)) return [];
  const c = cDec.toNumber();
  const rDec = parseMoneyDecimal(retail ?? null);
  const mDec = medianCategoryCost != null ? parseMoneyDecimal(medianCategoryCost) : null;
  const targetDec = mDec && mDec.gt(0) ? mDec : rDec && rDec.gt(0) ? rDec.times("0.5") : cDec;
  const target = targetDec.toNumber();

  const candidates: CostSuggestion[] = [];
  const seen = new Set<string>();
  const push = (valDec: Decimal, description: string) => {
    if (!valDec.isFinite() || valDec.lte(0)) return;
    if (valDec.gte(cDec)) return;
    const roundedDec = valDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const key = roundedDec.toFixed(2);
    if (seen.has(key)) return;
    seen.add(key);
    const rounded = roundedDec.toNumber();
    const score = Math.abs(Math.log10(rounded / target));
    candidates.push({ value: rounded, description, score });
  };

  const s = cDec.toString();
  const digits = s.replace(/[.-]/g, "");
  const decPart = s.includes(".") ? s.split(".")[1] : "";
  const decLen = decPart.length;

  const intPart = s.includes(".") ? s.split(".")[0] : s;
  if (intPart.length >= 2) {
    for (let i = 0; i < intPart.length; i++) {
      const trimmedInt = intPart.slice(0, i) + intPart.slice(i + 1);
      if (trimmedInt === "" || /^0+$/.test(trimmedInt)) continue;
      const val = parseMoneyDecimal(trimmedInt + (decPart ? "." + decPart : ""));
      if (val) push(val, `إزالة الرقم ${intPart[i]} في الموضع ${i + 1}`);
    }
  }

  push(cDec.div(10), "قسمة على ١٠ (نقل الفاصلة يساراً موضعاً واحداً)");
  push(cDec.div(100), "قسمة على ١٠٠");
  push(cDec.div(1000), "قسمة على ١٠٠٠");

  if (decLen === 0 && digits.length >= 3) {
    for (let i = 1; i < digits.length; i++) {
      const inserted = parseMoneyDecimal(digits.slice(0, i) + "." + digits.slice(i));
      if (inserted) push(inserted, `إدراج فاصلة عشريّة قبل الرقم ${digits[i]}`);
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const top: CostSuggestion[] = [];
  for (const cand of candidates) {
    if (top.length >= 3) break;
    if (top.some((t) => Math.abs(t.value - cand.value) / Math.max(t.value, cand.value) < 0.05)) continue;
    top.push(cand);
  }
  return top;
}
