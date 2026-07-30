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
 * **المستويات الثلاثة:**
 *  - `blocker`  ⇒ رفض قاطع (لا يُحفَظ حتى بتأكيد). قيم فلكية بيّنة الخطأ.
 *  - `warning`  ⇒ يتطلّب تأكيداً صريحاً «أؤكد رغم الشذوذ». تكلفة > سعر البيع مثلاً — نادرة لكن ممكنة.
 *  - `info`     ⇒ ملاحظة مرئية غير حاجزة. معلومات مفيدة (هامش ضيق جداً).
 */

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
 * يحوّل نصّ الحقل إلى `number` بحذر — بلا رمي: قيمة فارغة/غير رقمية ⇒ `null` (تُهمَل بلا رفض).
 * التنقية النهائية للأصفار الزائدة تُطبَّق في `MoneyInput`/`NumberInput` قبل الوصول هنا.
 */
export function parseMoneyStr(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * فحص مبلغٍ ماليّ منفرد (تكلفة/سعر) — حدّ مطلقٍ وحدّ سالب. لا يُفحَص «التكلفة > السعر» هنا
 * (يحتاج قيمتين ⇒ `checkCostVsRetail`). القيمة `null`/فارغة تُهمَل (اختياريّة).
 */
export function checkMoneyBounds(raw: string | null | undefined, field: SanityIssue["field"], labelAr: string): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const v = parseMoneyStr(raw);
  if (v == null) return issues;
  if (v < 0) {
    issues.push({ level: "blocker", code: "money_negative", field, message: `${labelAr} لا يصحّ أن يكون سالباً.` });
  }
  if (v > ABS_MAX_MONEY_IQD) {
    issues.push({ level: "blocker", code: "money_over_absmax", field, message: `${labelAr} تجاوز الحدّ الأقصى المعقول (${ABS_MAX_MONEY_IQD.toLocaleString("en-US")} د.ع) — راجع الرقم.` });
  }
  return issues;
}

/**
 * فحص معامل التحويل — يجب أن يكون > 1 لغير الأساس، وأقلّ من الحدّ المطلق. أرقام غير معقولة
 * (مثلاً 100000 قطعة في كارتون) خطأ إدخال شبه مؤكّد.
 */
export function checkConversionFactor(raw: string | null | undefined, isBase: boolean): SanityIssue[] {
  const issues: SanityIssue[] = [];
  if (isBase) return issues; // وحدة الأساس دائماً ١.
  const v = parseMoneyStr(raw);
  if (v == null || v <= 0) {
    issues.push({ level: "blocker", code: "factor_missing", field: "conversionFactor", message: "معامل التحويل لغير الوحدة الأساس مطلوب ويكون أكبر من صفر." });
    return issues;
  }
  if (v <= 1) {
    issues.push({ level: "blocker", code: "factor_le_one", field: "conversionFactor", message: "معامل التحويل لغير الأساس يجب أن يكون أكبر من ١ (درزن = ١٢، كرتون = …)." });
  }
  if (v > ABS_MAX_CONVERSION_FACTOR) {
    issues.push({ level: "warning", code: "factor_over_max", field: "conversionFactor", message: `معامل التحويل (${v.toLocaleString("en-US")}) أكبر من ${ABS_MAX_CONVERSION_FACTOR.toLocaleString("en-US")} — راجع الرقم أو أكّد رغم الشذوذ.` });
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
  const cost = parseMoneyStr(costRaw);
  const retail = parseMoneyStr(retailRaw);
  if (cost == null || retail == null || cost <= 0 || retail <= 0) return issues;
  const ratio = cost / retail;
  if (ratio >= COST_ABOVE_RETAIL_HARD_RATIO) {
    issues.push({
      level: "blocker",
      code: "cost_over_retail_hard",
      field: "costPrice",
      message: `التكلفة (${cost.toLocaleString("en-US")}) أكبر من سعر ${tierLabelAr} (${retail.toLocaleString("en-US")}) بـ${ratio.toFixed(1)}× — خطأ إدخال محتمل. راجع الرقم (نقطة عشرية/أصفار زائدة؟).`,
    });
  } else if (ratio > COST_ABOVE_RETAIL_RATIO) {
    issues.push({
      level: "warning",
      code: "cost_over_retail",
      field: "costPrice",
      message: `التكلفة (${cost.toLocaleString("en-US")}) أكبر من سعر ${tierLabelAr} (${retail.toLocaleString("en-US")}) ⇒ بيعٌ بخسارة. أكّد إن كان مقصوداً.`,
    });
  } else if (ratio > 1 / NARROW_MARGIN_RATIO) {
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
  conversionFactor: number;
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
  const baseCost = parseMoneyStr(baseUnitCost);
  // ٢) لكل وحدة: حدود الأسعار + مقارنة كلّ فئة بتكلفة الوحدة (baseCost × factor).
  for (const u of units) {
    const factorIssues = checkConversionFactor(String(u.conversionFactor), u.conversionFactor === 1);
    for (const it of factorIssues) issues.push({ ...it, message: `[${u.unitName}] ${it.message}` });
    issues.push(...checkMoneyBounds(u.retail, "retail", `سعر المفرد (${u.unitName})`));
    if (u.wholesale != null) issues.push(...checkMoneyBounds(u.wholesale, "wholesale", `سعر الجملة (${u.unitName})`));
    if (u.government != null) issues.push(...checkMoneyBounds(u.government, "government", `سعر الحكومي (${u.unitName})`));
    if (baseCost != null && baseCost > 0 && Number.isFinite(u.conversionFactor) && u.conversionFactor > 0) {
      const unitCost = (baseCost * u.conversionFactor).toString();
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
 * هي الأشدّ بين المقياسَين. يُستدعى في الطبقات الثلاث:
 *   - الطبقة ١: حين يكتب المستخدم قيمة (بلا oldCost فقط retail).
 *   - الطبقة ٢: حين يفحص الكاشف قيمةً موجودة (retail موجود، oldCost يأتي من auditLog).
 *   - الطبقة ٣: حين يقارن Trigger القيمة الجديدة بالقديمة قبل الحفظ (oldCost موجود، retail قد يغيب).
 */
export function classifySeverity(cost: string | number | null | undefined, refs: { retail?: string | number | null; oldCost?: string | number | null } = {}): CostChangeSeverity {
  const c = parseMoneyStr(cost as string | null | undefined);
  if (c == null || c <= 0) return "ok";
  const r = parseMoneyStr((refs.retail ?? null) as string | null | undefined);
  const o = parseMoneyStr((refs.oldCost ?? null) as string | null | undefined);
  const cats: CostChangeSeverity[] = [];
  for (const ref of [r, o]) {
    if (ref == null || ref <= 0) continue;
    const ratio = c / ref;
    if (ratio >= COST_CATASTROPHIC_RATIO) cats.push("catastrophic");
    else if (ratio >= COST_ABOVE_RETAIL_HARD_RATIO) cats.push("blocker");
    else if (ratio > COST_ABOVE_RETAIL_RATIO) cats.push("warning");
    else if (ratio > 1 / NARROW_MARGIN_RATIO) cats.push("info");
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
 * يقترح تصحيحاتٍ محتملة لقيمة تكلفةٍ شاذّة، بأنماط أخطاء الإدخال الشائعة:
 *   ١) إزالة رقمٍ من المقدّمة (يعالج «16162» بدل «1162.5»: ١ متلصق).
 *   ٢) إزالة صفرٍ (يعالج «8000» بدل «800»: صفر زائد ذيليّ).
 *   ٣) نقل الفاصلة (`1616.2` كنسخة أخرى من «16162»).
 *   ٤) إدخال فاصلة (يعالج «16162» → «161.62» أو «1616.2» أو «16.162»).
 *
 * الترتيب بالمسافة من `retail` أو `medianCategoryCost` — الأقرب إليهما أوّلاً. تُعاد إلى ٣ اقتراحات كحدّ أقصى.
 */
export function suggestCostCorrections(cost: string | number, retail?: string | number | null, medianCategoryCost?: number | null): CostSuggestion[] {
  const c = parseMoneyStr(typeof cost === "number" ? String(cost) : cost);
  if (c == null || c <= 0) return [];
  const r = parseMoneyStr((retail ?? null) as string | null | undefined);
  const m = medianCategoryCost != null && Number.isFinite(medianCategoryCost) && medianCategoryCost > 0 ? medianCategoryCost : null;
  // نقطة الاستهداف: نصف سعر البيع (هامش ٥٠٪ كأول تخمين) أو الوسيط.
  const target = m ?? (r != null && r > 0 ? r * 0.5 : c);

  const candidates: CostSuggestion[] = [];
  const seen = new Set<number>();
  const push = (value: number, description: string) => {
    if (!Number.isFinite(value) || value <= 0) return;
    // نستثني الاقتراحات التي تُنتج نفس القيمة الحالية أو قيمة أكبر منها (لا نقترح جعل الخطأ أكبر).
    if (value >= c) return;
    // تقريب لخانتَين — قيم المال في نظامنا.
    const rounded = Math.round(value * 100) / 100;
    if (seen.has(rounded)) return;
    seen.add(rounded);
    const score = Math.abs(Math.log10(rounded / target));
    candidates.push({ value: rounded, description, score });
  };

  const s = String(c);
  const digits = s.replace(/[.-]/g, "");
  const decPart = s.includes(".") ? s.split(".")[1] : "";
  const decLen = decPart.length;

  // ١) إزالة رقمٍ أوّل (16162 → 6162 مثلاً — لكن هذا لا يفيد. الأنفع «إزالة رقمٍ ثاني/ثالث»).
  //    نجرّب حذف كلّ رقمٍ في الجزء الصحيح واحداً تلو الآخر ونحسب المسافة.
  const intPart = s.includes(".") ? s.split(".")[0] : s;
  if (intPart.length >= 2) {
    for (let i = 0; i < intPart.length; i++) {
      const trimmedInt = intPart.slice(0, i) + intPart.slice(i + 1);
      if (trimmedInt === "" || trimmedInt === "0") continue;
      const val = Number(trimmedInt + (decPart ? "." + decPart : ""));
      push(val, `إزالة الرقم ${intPart[i]} في الموضع ${i + 1}`);
    }
  }

  // ٢) نقل الفاصلة يميناً/يساراً بمكانٍ واحد (تكون العشرة بديلاً واقعياً):
  push(c / 10, "قسمة على ١٠ (نقل الفاصلة يساراً موضعاً واحداً)");
  push(c / 100, "قسمة على ١٠٠");
  push(c / 1000, "قسمة على ١٠٠٠");

  // ٣) إدخال فاصلة عشريّة داخل الجزء الصحيح (16162 → 1616.2 أو 161.62 أو 16.162).
  if (decLen === 0 && digits.length >= 3) {
    for (let i = 1; i < digits.length; i++) {
      const inserted = Number(digits.slice(0, i) + "." + digits.slice(i));
      push(inserted, `إدراج فاصلة عشريّة قبل الرقم ${digits[i]}`);
    }
  }

  // فرز واقتصاص بالأقرب إلى الهدف.
  candidates.sort((a, b) => a.score - b.score);
  const top: CostSuggestion[] = [];
  for (const cand of candidates) {
    if (top.length >= 3) break;
    // لا نُدرج قيمتَين متقاربتَين جداً (فارقهما < ٥٪) — تنويعٌ أفضل للمستخدم.
    if (top.some((t) => Math.abs(t.value - cand.value) / Math.max(t.value, cand.value) < 0.05)) continue;
    top.push(cand);
  }
  return top;
}
